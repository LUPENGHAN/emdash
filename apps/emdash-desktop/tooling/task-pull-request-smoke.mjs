import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import electronPath from 'electron';
import { resolveConfig } from 'electron-vite';
import { _electron } from 'playwright';
import { build, createServer } from 'vite';
import { startGitForgeFixture } from './acceptance/git-forge-fixture.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(join(tmpdir(), 'emdash-task-pr-smoke-'));
const repository = join(profile, 'repo');
const capture = join(profile, 'capture');
await mkdir(repository);
await mkdir(capture);
const exec = promisify(execFile);
const git = async (...args) => (await exec('git', args, { cwd: repository })).stdout.trim();
await git('init', '-b', 'main');
await git('config', 'user.name', 'PR acceptance');
await git('config', 'user.email', 'test@example.invalid');
await writeFile(join(repository, 'README.md'), 'Isolated PR acceptance');
await git('add', '.');
await git('commit', '-m', 'Baseline');
const baseline = await git('rev-parse', 'HEAD');
const managementRepository = join(profile, 'management-repo');
await exec('git', ['clone', repository, managementRepository]);
const forge = await startGitForgeFixture(join(profile, 'forge'), repository);
await git('remote', 'add', 'upstream', forge.gitUrl('org'));
await git('remote', 'add', 'personal', forge.gitUrl('personal'));
await git('fetch', 'upstream');
const wrapper = join(profile, 'fake-claude');
const mainWrapper = join(profile, 'fake-opencode');
await writeFile(
  wrapper,
  `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path'); const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) { console.log('2.1.325 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: false })); process.exit(0); }
const config = args.find((arg) => arg.startsWith('--mcp-config='));
const id = args[args.indexOf('--session-id') + 1];
fs.writeFileSync(path.join(${JSON.stringify(capture)}, id + '.json'), JSON.stringify({ mcpUrl: JSON.parse(config.slice('--mcp-config='.length)).mcpServers.emdash.url }));
process.stdin.on('data', () => {}); setInterval(() => {}, 1000);
`,
  { mode: 0o755 }
);
await writeFile(
  mainWrapper,
  `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
if (process.argv.includes('--version')) { console.log('1.4.0'); process.exit(0); }
if (!process.argv.includes('acp')) { console.log('{}'); process.exit(0); }
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
 let q; try { q = JSON.parse(line); } catch { return; } if (q.id === undefined) return;
 let result = {};
 if (q.method === 'initialize') result = { protocolVersion: 1, agentInfo: { name: 'fixture', version: '1' }, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, authMethods: [] };
 if (q.method === 'session/new' || q.method === 'session/load') { const mcp = q.params.mcpServers.find((s) => s.name === 'emdash');
  const id = new URL(mcp.url).pathname.split('/')[2];
  fs.writeFileSync(path.join(${JSON.stringify(capture)}, id + '.json'), JSON.stringify({ mcpUrl: mcp.url }));
  result = q.method === 'session/new' ? { sessionId: 'ses_' + require('node:crypto').randomUUID(), configOptions: [] } : { configOptions: [] };
 }
 if (q.method === 'session/prompt') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: q.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PR acceptance main ready.' } } } }) + '\\n'); result = { stopReason: 'end_turn' }; }
 process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }) + '\\n');
});
`,
  { mode: 0o755 }
);
process.chdir(appRoot);
const { config } = await resolveConfig(
  { configFile: join(appRoot, 'electron.vite.config.ts') },
  'serve'
);
await build({
  ...config.main,
  configFile: false,
  logLevel: 'warn',
  define: { ...config.main.define, 'import.meta.env.DEV': 'true' },
});
const renderer = await createServer({
  ...config.renderer,
  configFile: false,
  server: { ...config.renderer.server, host: '127.0.0.1', port: 0, open: false },
});
await renderer.listen();
const env = {
  ...process.env,
  ELECTRON_RENDERER_URL: renderer.resolvedUrls.local[0],
  EMDASH_USER_DATA_DIR: profile,
  EMDASH_DB_FILE: join(profile, 'scratch.db'),
  TELEMETRY_ENABLED: 'false',
  CLAUDE_CONFIG_DIR: join(profile, 'claude'),
  CODEX_HOME: join(profile, 'codex'),
  OPENCODE_CONFIG_DIR: join(profile, 'opencode'),
  XDG_CONFIG_HOME: join(profile, 'config'),
};
delete env.ELECTRON_RUN_AS_NODE;
let onboarded = false;
let app;
let page;
const launchErrors = [];
const clients = [];
const wait = async (read, message) => {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(message);
};
const captureClient = async (id) => {
  const captured = await wait(async () => {
    try {
      return JSON.parse(await readFile(join(capture, id + '.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return null;
    }
  }, 'The simulated agent did not expose its MCP identity.');
  const client = new Client({ name: 'isolated-pr-acceptance', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(captured.mcpUrl)));
  clients.push(client);
  return client;
};
const call = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return JSON.parse(result.content.find((part) => part.type === 'text').text);
};
async function launch() {
  app = await _electron.launch({
    executablePath: electronPath,
    args: [appRoot],
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => launchErrors.push({ kind: 'pageerror', message: error.message }));
  page.on('console', (message) => {
    if (message.type() === 'error') launchErrors.push({ kind: 'console', message: message.text() });
  });
  page.on('crash', () => launchErrors.push({ kind: 'crash' }));
  page.setDefaultTimeout(25000);
  await page.waitForLoadState('domcontentloaded');
  if (!onboarded) {
    await page.getByRole('button', { name: /Skip for now|暂时跳过/ }).click();
    await page
      .getByRole('button', { name: /开始使用|Start shipping|Get started/ })
      .first()
      .click();
    onboarded = true;
  }
  await page.getByRole('button', { name: /^(Settings|设置)$/ }).waitFor();
  await page.addScriptTag({
    type: 'module',
    content: `import { prepareCoordinator, prepareAdditionalProject, configurePrFixture, openPrFixtureDialog, readPrFixtureAssociation, openBaselineFixtureSettings, baselineFixtureState, coordinatorDelegationStatus, observeMergedPrFixture } from '/@fs${join(appRoot, 'tooling/acceptance/task-delegation-browser.ts')}'; Object.assign(window, { prepareCoordinator, prepareAdditionalProject, configurePrFixture, openPrFixtureDialog, readPrFixtureAssociation, openBaselineFixtureSettings, baselineFixtureState, coordinatorDelegationStatus, observeMergedPrFixture });`,
  });
  await page.waitForFunction(() => typeof window.configurePrFixture === 'function');
}
async function quit() {
  const child = app.process();
  const exited = once(child, 'exit');
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    await Promise.race([
      exited,
      (async () => {
        const button = page.getByTestId('confirm-action-submit');
        await button.waitFor({ timeout: 5000 });
        await button.click();
      })(),
    ]).catch(() => {});
    await exited;
    assert.equal(child.exitCode, 0);
  } finally {
    clearTimeout(timeout);
    app = undefined;
  }
}
try {
  await launch();
  const main = await page.evaluate((input) => window.prepareCoordinator(input), {
    wrapper,
    mainWrapper,
    repository: managementRepository,
    worktreeRoot: join(profile, 'worktrees'),
  });
  const codeProjectId = await page.evaluate((input) => window.prepareAdditionalProject(input), {
    wrapper,
    repository,
    worktreeRoot: join(profile, 'code-worktrees'),
    name: 'SDK acceptance',
    baselineBranch: 'main',
  });
  await page.evaluate((input) => window.configurePrFixture(input), {
    projectId: codeProjectId,
    apiBaseUrl: forge.origin,
    baseRemote: 'personal',
  });
  await page
    .locator(`[data-testid="project-main-agent"][data-project-id="${main.projectId}"]`)
    .click();
  await page.locator('[contenteditable="true"]').first().fill('Prepare the isolated PR workflow.');
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click();
  const mainClient = await captureClient(main.conversationId);
  await page.evaluate((id) => window.openBaselineFixtureSettings(id), codeProjectId);
  const baselineSection = page.getByRole('region', { name: 'Code baseline', exact: true });
  const command = baselineSection.getByLabel('Baseline verification command', { exact: true });
  await command.fill('printf baseline-failure-evidence; exit 9');
  await baselineSection
    .getByRole('button', { name: 'Save baseline settings', exact: true })
    .click();
  await baselineSection.getByRole('button', { name: 'Check baseline', exact: true }).click();
  await baselineSection.getByText('Verification failed', { exact: true }).waitFor();
  await baselineSection.getByText('baseline-failure-evidence', { exact: true }).waitFor();
  const blockedDelegation = await mainClient.callTool({
    name: 'create_task',
    arguments: {
      project_id: codeProjectId,
      request_id: 'baseline-rejected-task',
      name: 'Rejected baseline task',
      prompt: 'This must not start.',
      agent: 'claude',
      ui: 'terminal',
    },
  });
  assert.equal(blockedDelegation.isError, true);
  const failedBaseline = await page.evaluate(
    (id) => window.baselineFixtureState(id),
    codeProjectId
  );
  assert.equal(failedBaseline.canDelegate, false);
  assert.equal(failedBaseline.attempts.filter((attempt) => attempt.verification?.runId).length, 1);
  await baselineSection
    .getByRole('status')
    .screenshot({ path: join(profile, 'baseline-verification-blocked.png') });
  await command.fill(`test "$(git rev-parse HEAD)" = '${baseline}' && printf baseline-verified`);
  await baselineSection
    .getByRole('button', { name: 'Save baseline settings', exact: true })
    .click();
  await baselineSection.getByRole('button', { name: 'Check baseline', exact: true }).click();
  await baselineSection.getByText('Ready for delegation', { exact: true }).waitFor();
  await baselineSection.getByText('baseline-verified', { exact: true }).waitFor();
  const approvedBaseline = await page.evaluate(
    (id) => window.baselineFixtureState(id),
    codeProjectId
  );
  assert.equal(approvedBaseline.proof.oid, baseline);
  assert.equal(approvedBaseline.proof.verification, 'succeeded');
  await baselineSection
    .getByRole('status')
    .screenshot({ path: join(profile, 'baseline-verification-approved.png') });
  const task = await call(mainClient, 'create_task', {
    project_id: codeProjectId,
    request_id: 'pr-code-task',
    name: 'PR code task',
    prompt: 'Wait for the isolated test code change.',
    agent: 'claude',
    ui: 'terminal',
    effort: 'high',
  });
  const approvedTask = await page.evaluate(
    (input) => window.coordinatorDelegationStatus(input.id, input.taskId),
    { id: main.id, taskId: task.task_id }
  );
  assert.equal(approvedTask.baselineSelection.oid, baseline);
  assert.equal(approvedTask.baselineSelection.verification, 'succeeded');
  const taskGit = async (...args) => (await exec('git', args, { cwd: task.path })).stdout.trim();
  await writeFile(join(task.path, 'sdk.ts'), 'export const fixture = true;');
  await taskGit('add', '.');
  await taskGit('commit', '-m', 'Isolated SDK change');
  const oid = await taskGit('rev-parse', 'HEAD');
  const branch = await taskGit('branch', '--show-current');
  const worker = await captureClient(task.conversation_id);
  forge.loseNextCreateResponse();
  const failed = await mainClient.callTool({
    name: 'create_pull_request',
    arguments: {
      task_id: task.task_id,
      request_id: 'main-pr',
      title: 'Main PR recovery',
      push_remote: 'personal',
      target_repository: forge.repositoryUrl('org'),
      target_branch: 'main',
    },
  });
  assert.equal(failed.isError, true);
  assert.equal(forge.prs.length, 1);
  const status = await call(mainClient, 'get_task_status', { task_id: task.task_id });
  assert.equal(status.pullRequests[0].phase, 'creating');
  assert.equal(status.pullRequests[0].plan.oid, oid);
  const own = await call(worker, 'create_pull_request', {
    request_id: 'worker-pr',
    title: 'Worker PR',
    push_remote: 'personal',
    target_repository: forge.repositoryUrl('org'),
    target_branch: 'main',
  });
  assert.equal(own.phase, 'complete');
  assert.equal(forge.prs.length, 1);
  const associated = async () =>
    page.evaluate((input) => window.readPrFixtureAssociation(input), {
      projectId: codeProjectId,
      taskId: task.task_id,
    });
  await wait(async () => {
    const prs = await associated();
    return prs.length === 1 && prs[0].url === own.result.url;
  }, 'The ordinary task did not associate its saved explicit-target PR.');
  assert.equal((await associated())[0].repositoryUrl, forge.repositoryUrl('org'));
  await page
    .locator(`[data-testid="project-main-agent"][data-project-id="${main.projectId}"]`)
    .click();
  await page.getByTestId('coordinator-tasks-tab').click();
  await page
    .getByTestId('task-pr-status')
    .getByText('Main PR recovery · PR creating', { exact: true })
    .click();
  await page.screenshot({ path: join(profile, 'task-pr-failed.png') });
  for (const client of clients.splice(0)) await client.close();
  const posts = forge.requests.filter(
    (request) => request.method === 'POST' && request.path.endsWith('/merge_requests')
  ).length;
  await unlink(join(capture, main.conversationId + '.json'));
  await quit();
  await launch();
  const restoredBaseline = await page.evaluate(
    (id) => window.baselineFixtureState(id),
    codeProjectId
  );
  assert.equal(restoredBaseline.proof.oid, baseline);
  assert.equal(restoredBaseline.proof.verification, 'succeeded');
  assert.ok(
    restoredBaseline.attempts.some(
      (attempt) => attempt.verification?.output === 'baseline-verified'
    )
  );
  await page.evaluate((id) => window.openBaselineFixtureSettings(id), codeProjectId);
  await page
    .getByRole('region', { name: 'Code baseline', exact: true })
    .getByText('Ready for delegation', { exact: true })
    .waitFor();
  await page
    .getByRole('region', { name: 'Code baseline', exact: true })
    .getByRole('status')
    .screenshot({ path: join(profile, 'baseline-verification-restored.png') });
  const expand = page.getByRole('button', { name: /^(Expand|展开) Delegation acceptance$/ });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator(`[data-testid="project-main-agent"][data-project-id="${main.projectId}"]`)
    .click();
  await page.getByTestId('coordinator-tasks-tab').click();
  await page
    .getByTestId('task-pr-status')
    .getByText('Main PR recovery · PR creating', { exact: true })
    .click();
  await page.getByTestId('retry-task-pr').click();
  await page
    .getByTestId('task-pr-status')
    .getByText('Main PR recovery · PR complete', { exact: true })
    .waitFor();
  assert.equal(forge.prs.length, 1);
  assert.equal(
    forge.requests.filter(
      (request) => request.method === 'POST' && request.path.endsWith('/merge_requests')
    ).length,
    posts
  );
  await page.screenshot({ path: join(profile, 'task-pr-recovered.png') });
  await wait(
    async () => (await associated()).some((pr) => pr.url === own.result.url),
    'The ordinary task did not restore its explicit-target PR association.'
  );
  await taskGit('fetch', 'personal');
  await taskGit('branch', '--set-upstream-to', `personal/${branch}`);
  const workspaceId = status.task.workspaceId;
  const pushesBeforeDialog = forge.requests.filter((request) =>
    request.path.endsWith('/git-receive-pack')
  ).length;
  await page.evaluate((input) => window.openPrFixtureDialog(input), {
    projectId: codeProjectId,
    taskId: task.task_id,
    workspaceId,
    repositoryUrl: forge.repositoryUrl('org'),
    branchName: branch,
  });
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox').first().click();
  await page.getByRole('option', { name: /upstream/ }).click();
  const create = dialog.getByRole('button', { name: 'Create MR', exact: true });
  if (!(await create.isVisible())) {
    await dialog.locator('[data-slot="dropdown-menu-trigger"]').last().click();
    await page.getByRole('menuitem', { name: /^Create MR/ }).click();
  }
  await create.waitFor();
  await create.click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(forge.prs.length, 1);
  assert.equal(
    forge.requests.filter((request) => request.path.endsWith('/git-receive-pack')).length,
    pushesBeforeDialog
  );
  assert.equal(await git('rev-parse', 'main'), baseline);
  assert.equal(await taskGit('rev-parse', 'HEAD'), oid);
  await page.screenshot({ path: join(profile, 'task-pr-modal-complete.png') });
  // Advance only the temporary organization upstream, then let the cached merge fact trigger sync.
  const organizationBare = join(profile, 'forge', 'org', 'sdk.git');
  const personalBare = join(profile, 'forge', 'personal', 'sdk.git');
  const author = join(profile, 'upstream-author');
  await exec('git', ['clone', organizationBare, author]);
  const authorGit = async (...args) => (await exec('git', args, { cwd: author })).stdout.trim();
  await authorGit('config', 'user.name', 'Upstream acceptance');
  await authorGit('config', 'user.email', 'test@example.invalid');
  await authorGit('fetch', personalBare, branch);
  await authorGit('merge', '--no-ff', '--no-edit', 'FETCH_HEAD');
  const mergedOid = await authorGit('rev-parse', 'HEAD');
  await authorGit('push', organizationBare, 'main');
  const managementRef = `refs/heads/emdash/manage/${main.taskId}`;
  const managementOid = (
    await exec('git', ['rev-parse', managementRef], { cwd: managementRepository })
  ).stdout.trim();
  await page.evaluate((id) => window.openBaselineFixtureSettings(id), codeProjectId);
  const advancedSection = page.getByRole('region', { name: 'Code baseline', exact: true });
  await advancedSection
    .getByLabel('Baseline verification command', { exact: true })
    .fill('test -f sdk.ts && printf upstream-baseline-verified');
  await advancedSection
    .getByRole('button', { name: 'Save baseline settings', exact: true })
    .click();
  const receivesBeforeSync = forge.requests.filter((request) =>
    request.path.endsWith('/git-receive-pack')
  ).length;
  forge.markMerged(own.result.number);
  await page.evaluate((input) => window.observeMergedPrFixture(input), {
    repositoryUrl: forge.repositoryUrl('org'),
    number: own.result.number,
  });
  const mergedState = await wait(async () => {
    const state = await page.evaluate((id) => window.baselineFixtureState(id), codeProjectId);
    return state.status === 'ready' &&
      state.proof?.oid === mergedOid &&
      state.attempts.some(
        (attempt) => attempt.trigger === 'pr-merged' && attempt.observation?.oid === mergedOid
      )
      ? state
      : null;
  }, 'The observed organization merge did not advance the local baseline.');
  assert.equal(mergedState.proof.verification, 'succeeded');
  assert.equal(await git('rev-parse', 'main'), mergedOid);
  assert.equal(await taskGit('rev-parse', 'HEAD'), oid);
  assert.equal(
    (await exec('git', ['rev-parse', managementRef], { cwd: managementRepository })).stdout.trim(),
    managementOid
  );
  assert.equal(
    (await exec('git', ['--git-dir', personalBare, 'rev-parse', 'main'])).stdout.trim(),
    baseline
  );
  assert.equal(
    forge.requests.filter((request) => request.path.endsWith('/git-receive-pack')).length,
    receivesBeforeSync
  );
  await advancedSection
    .getByRole('status')
    .screenshot({ path: join(profile, 'baseline-merged-automatically.png') });
  await writeFile(join(repository, 'dirty-acceptance.txt'), 'Preserve this local file');
  await writeFile(join(author, 'upstream.txt'), 'A second upstream revision');
  await authorGit('add', '.');
  await authorGit('commit', '-m', 'Advance upstream again');
  const advancedOid = await authorGit('rev-parse', 'HEAD');
  await authorGit('push', organizationBare, 'main');
  await advancedSection.getByRole('button', { name: 'Check baseline', exact: true }).click();
  await wait(async () => {
    const state = await page.evaluate((id) => window.baselineFixtureState(id), codeProjectId);
    return state.status === 'blocked' && state.attempts.at(-1)?.error?.code === 'checkout-dirty';
  }, 'The dirty root checkout was not preserved.');
  assert.equal(await git('rev-parse', 'main'), mergedOid);
  assert.equal(
    await readFile(join(repository, 'dirty-acceptance.txt'), 'utf8'),
    'Preserve this local file'
  );
  await advancedSection
    .getByText(
      'The baseline checkout has local changes. Commit or stash them before synchronizing.',
      { exact: true }
    )
    .waitFor();
  await advancedSection
    .getByRole('status')
    .screenshot({ path: join(profile, 'baseline-dirty-blocked.png') });
  await unlink(join(repository, 'dirty-acceptance.txt'));
  await advancedSection.getByRole('button', { name: 'Check baseline', exact: true }).click();
  await wait(async () => {
    const state = await page.evaluate((id) => window.baselineFixtureState(id), codeProjectId);
    return state.status === 'ready' && state.proof?.oid === advancedOid;
  }, 'The clean checkout did not resume safe synchronization.');
  // Force-pushes below touch only the throwaway fixture bare repository.
  await authorGit('checkout', '--orphan', 'rewritten-history');
  await authorGit('rm', '-rf', '--', '.');
  await writeFile(join(author, 'README.md'), 'Unrelated fixture history');
  await authorGit('add', '.');
  await authorGit('commit', '-m', 'Rewrite fixture upstream');
  await authorGit('push', '--force', organizationBare, 'HEAD:main');
  for (const pass of [1, 2]) {
    await advancedSection.getByRole('button', { name: 'Check baseline', exact: true }).click();
    await wait(async () => {
      const state = await page.evaluate((id) => window.baselineFixtureState(id), codeProjectId);
      return (
        state.status === 'blocked' &&
        state.attempts.filter((attempt) => attempt.error?.code === 'upstream-rewritten').length >=
          pass
      );
    }, 'The rewritten upstream history was accepted.');
  }
  assert.equal(await git('rev-parse', 'main'), advancedOid);
  await advancedSection
    .getByText(
      'The upstream history was rewritten. Inspect the upstream before retrying; the local baseline was preserved.',
      { exact: true }
    )
    .waitFor();
  await advancedSection
    .getByRole('status')
    .screenshot({ path: join(profile, 'baseline-rewrite-blocked.png') });
  await authorGit('checkout', 'main');
  await authorGit('push', '--force', organizationBare, 'main');
  await advancedSection.getByRole('button', { name: 'Check baseline', exact: true }).click();
  const onlineState = await wait(async () => {
    const state = await page.evaluate((id) => window.baselineFixtureState(id), codeProjectId);
    return state.status === 'ready' && state.proof?.oid === advancedOid ? state : null;
  }, 'Restoring the fixture upstream did not unblock the original baseline.');
  // Obtain a fresh authenticated main identity after the complete app restart.
  await page
    .locator(`[data-testid="project-main-agent"][data-project-id="${main.projectId}"]`)
    .click();
  await page.getByTestId('coordinator-conversation-tab').click();
  await page
    .locator('[contenteditable="true"]')
    .first()
    .fill('Prepare the isolated offline delegation check.');
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click();
  const resumedMain = await captureClient(main.conversationId);
  await page.evaluate((id) => window.openBaselineFixtureSettings(id), codeProjectId);
  await forge.close();
  await advancedSection.getByRole('button', { name: 'Check baseline', exact: true }).click();
  const offlineState = await wait(async () => {
    const state = await page.evaluate((id) => window.baselineFixtureState(id), codeProjectId);
    return state.status === 'offline' ? state : null;
  }, 'A verified local baseline was not available during the fixture outage.');
  assert.equal(offlineState.canDelegate, true);
  assert.equal(offlineState.lastContactAt, onlineState.lastContactAt);
  const offlineTask = await call(resumedMain, 'create_task', {
    project_id: codeProjectId,
    request_id: 'offline-approved-task',
    name: 'Offline approved task',
    prompt: 'Wait for the isolated test.',
    agent: 'claude',
    ui: 'terminal',
  });
  const offlineSelection = await page.evaluate(
    (input) => window.coordinatorDelegationStatus(input.id, input.taskId),
    { id: main.id, taskId: offlineTask.task_id }
  );
  assert.equal(offlineSelection.baselineSelection.oid, advancedOid);
  assert.equal(offlineSelection.baselineSelection.offline, true);
  assert.equal(
    (await exec('git', ['rev-parse', 'HEAD'], { cwd: offlineTask.path })).stdout.trim(),
    advancedOid
  );
  assert.equal(await taskGit('rev-parse', 'HEAD'), oid);
  assert.equal(
    (await exec('git', ['--git-dir', personalBare, 'rev-parse', 'main'])).stdout.trim(),
    baseline
  );
  await advancedSection
    .getByRole('status')
    .screenshot({ path: join(profile, 'baseline-offline-delegation.png') });
  await writeFile(
    join(profile, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        checks: [
          'real Electron with isolated DB and mock CLI/ACP plus authenticated main and worker MCP',
          'project settings saved baseline validation and a real Host script failure blocked MCP delegation',
          'fixed-commit validation passed in a separate checkout and delegation retained its approval snapshot',
          'baseline proof and output survived complete Electron restart',
          'real smart HTTP Git publication to a loopback personal fork with pinned task OID',
          'main platform response loss persisted and worker creation reused the same PR',
          'complete restart restored the request and UI continued without another platform create',
          'ordinary create-only dialog used the same durable pipeline and preserved source and baseline',
          'ordinary task association followed the saved organization target despite a different project base remote, including after restart',
          'main agent created and resumed a PR for another repository while its task page was never opened',
          'an observed organization PR merge automatically fast-forwarded and verified the local baseline without changing task, management or personal fork main refs',
          'a dirty checkout blocked synchronization, preserved its file and resumed after the fixture file was removed',
          'rewritten upstream history remained blocked across repeated checks until the fixture upstream was restored explicitly',
          'a loopback upstream outage retained the verified local baseline and last contact time',
          'authenticated MCP delegation during the outage froze the approved offline commit in the actual task checkout',
        ],
        taskId: task.task_id,
        oid,
      },
      null,
      2
    )
  );
  await quit();
  process.stdout.write(`Task PR acceptance passed: ${profile}\n`);
} catch (error) {
  await writeFile(join(profile, 'forge-requests.json'), JSON.stringify(forge.requests, null, 2));
  await writeFile(
    join(profile, 'failure-error.json'),
    JSON.stringify({ message: error.message, stack: error.stack, launchErrors }, null, 2)
  );
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(profile, 'failure.png') }).catch(() => {});
    await writeFile(join(profile, 'failure.html'), await page.content()).catch(() => {});
  }
  process.stdout.write(`Task PR acceptance failed: ${profile}\n`);
  process.exitCode = 1;
} finally {
  for (const client of clients) await client.close().catch(() => {});
  if (app) await quit().catch(() => app?.process().kill('SIGKILL'));
  await renderer.close();
  await forge.close();
}
