import { spawn, execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** Loopback-only forge and smart HTTP Git fixture. No production service or account is used. */
export async function startGitForgeFixture(directory, sourceRepository) {
  const git = promisify(execFile);
  for (const owner of ['org', 'personal']) {
    const path = join(directory, owner, 'sdk.git');
    await mkdir(join(directory, owner), { recursive: true });
    await git('git', ['init', '--bare', path]);
    await git('git', ['--git-dir', path, 'config', 'http.receivepack', 'true']);
    await git('git', ['-C', sourceRepository, 'push', path, 'main:refs/heads/main']);
    await git('git', ['--git-dir', path, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  const prs = [];
  const requests = [];
  let loseResponse = false;
  let closed = false;
  const repositoryUrl = (owner) => `${origin.replace('http:', 'https:')}/${owner}/sdk`;
  const oid = async (owner, branch) =>
    (
      await git('git', [
        '--git-dir',
        join(directory, owner, 'sdk.git'),
        'rev-parse',
        `refs/heads/${branch}`,
      ])
    ).stdout.trim();
  const mergeRequest = (pr) => ({
    iid: pr.number,
    web_url: pr.url,
    title: pr.title,
    description: '',
    state: pr.merged ? 'merged' : 'opened',
    draft: false,
    created_at: '2026-11-17T00:00:00Z',
    updated_at: pr.updatedAt ?? '2026-11-17T00:00:00Z',
    source_branch: pr.branch,
    target_branch: pr.base,
    sha: pr.oid,
    diff_refs: { base_sha: pr.baseOid, head_sha: pr.oid },
    source_project_id: 2,
    target_project_id: 1,
    author: null,
    assignees: [],
    labels: [],
    changes_count: '1',
    merge_status: 'can_be_merged',
    head_pipeline: null,
  });
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, origin);
      requests.push({ method: request.method, path: url.pathname });
      if (/^\/(org|personal)\/sdk\.git\//.test(url.pathname)) {
        const child = spawn('git', ['http-backend'], {
          windowsHide: true,
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: directory,
            GIT_HTTP_EXPORT_ALL: '1',
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: request.method,
            CONTENT_TYPE: request.headers['content-type'] ?? '',
            CONTENT_LENGTH: request.headers['content-length'] ?? '',
            REMOTE_USER: 'fixture',
            REMOTE_ADDR: '127.0.0.1',
          },
        });
        const chunks = [];
        let bytes = 0;
        child.stdout.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) child.kill();
          else chunks.push(chunk);
        });
        child.stderr.resume();
        request.pipe(child.stdin);
        child.stdin.on('error', () => {});
        await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code) =>
            code === 0 ? resolve() : reject(new Error('Fixture Git backend failed'))
          );
        });
        const output = Buffer.concat(chunks);
        const split = output.indexOf('\r\n\r\n');
        if (split < 0) throw new Error('Missing fixture CGI headers');
        for (const line of output.subarray(0, split).toString().split('\r\n')) {
          const colon = line.indexOf(':');
          const key = line.slice(0, colon);
          const value = line.slice(colon + 1).trim();
          if (key.toLowerCase() === 'status') response.statusCode = Number.parseInt(value, 10);
          else response.setHeader(key, value);
        }
        response.end(output.subarray(split + 4));
        return;
      }
      const json = (data, status = 200) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(data));
      };
      let text = '';
      for await (const chunk of request) {
        text += chunk;
        if (text.length > 1024 * 1024) throw new Error('Oversized fixture request');
      }
      const body = text ? JSON.parse(text) : {};
      if (url.pathname === '/api/v4/user')
        return json({
          id: 7,
          username: 'fixture',
          name: 'Fixture account',
          web_url: `${repositoryUrl('org')}/fixture`,
        });
      const project = /^\/api\/v4\/projects\/([^/]+)$/.exec(url.pathname);
      if (project) {
        const source = ['2', 'personal/sdk'].includes(decodeURIComponent(project[1]));
        return json({
          id: source ? 2 : 1,
          path_with_namespace: source ? 'personal/sdk' : 'org/sdk',
          web_url: repositoryUrl(source ? 'personal' : 'org'),
          default_branch: 'main',
        });
      }
      if (url.pathname === '/api/v4/projects/1/merge_requests' && request.method === 'GET')
        return json(
          prs
            .filter(
              (pr) =>
                (!url.searchParams.has('source_branch') ||
                  url.searchParams.get('source_branch') === pr.branch) &&
                (!url.searchParams.has('target_branch') ||
                  url.searchParams.get('target_branch') === pr.base)
            )
            .map(mergeRequest)
        );
      if (url.pathname === '/api/v4/projects/2/merge_requests' && request.method === 'POST') {
        const branch = body.source_branch;
        if (prs.some((pr) => pr.branch === branch && pr.base === body.target_branch))
          return json({ message: 'A merge request already exists' }, 409);
        const number = prs.length + 1;
        const pr = {
          number,
          branch,
          base: body.target_branch,
          title: body.title,
          url: `${repositoryUrl('org')}/-/merge_requests/${number}`,
          oid: await oid('personal', branch),
          baseOid: await oid('org', body.target_branch),
        };
        prs.push(pr);
        if (loseResponse) {
          loseResponse = false;
          response.destroy();
          return;
        }
        return json(mergeRequest(pr), 201);
      }
      const detail = /^\/api\/v4\/projects\/1\/merge_requests\/(\d+)(?:\/(\w+))?$/.exec(
        url.pathname
      );
      if (detail) {
        const pr = prs.find((entry) => entry.number === Number(detail[1]));
        if (!pr) return json({ message: 'Not found' }, 404);
        if (!detail[2]) return json(mergeRequest(pr));
        if (detail[2] === 'approvals')
          return json({ approved: true, approvals_required: 0, approvals_left: 0 });
        if (detail[2] === 'commits') return json([{ id: pr.oid }]);
        return json([]);
      }
      return json({ message: `Unsupported fixture route ${url.pathname}` }, 404);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end('Fixture request failed');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    repositoryUrl,
    gitUrl: (owner) => `${origin}/${owner}/sdk.git`,
    prs,
    requests,
    loseNextCreateResponse: () => {
      loseResponse = true;
    },
    markMerged: (number) => {
      const pr = prs.find((entry) => entry.number === number);
      if (!pr) throw new Error('Missing fixture pull request');
      pr.merged = true;
      pr.updatedAt = new Date().toISOString();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
