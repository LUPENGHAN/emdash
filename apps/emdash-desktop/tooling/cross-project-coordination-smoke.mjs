import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import electronPath from 'electron';
import { resolveConfig } from 'electron-vite';
import { _electron } from 'playwright';
import { build, createServer } from 'vite';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(join(tmpdir(), 'emdash-cross-coordination-'));
const repository = join(profile, 'repository');
const capture = join(profile, 'spawns');
await mkdir(repository);
await mkdir(capture);
const git = async (...args) =>
  (await promisify(execFile)('git', args, { cwd: repository })).stdout.trim();
await git('init', '-b', 'main');
await git('config', 'user.name', 'Emdash test');
await git('config', 'user.email', 'test@example.invalid');
await writeFile(join(repository, 'README.md'), 'Isolated delegation acceptance\n');
await git('add', 'README.md');
await git(
  '-c',
  'user.name=Emdash test',
  '-c',
  'user.email=test@example.invalid',
  'commit',
  '-m',
  'Initial baseline'
);
const baseline = await git('rev-parse', 'HEAD');
const personalFork = join(profile, 'personal fork.git');
const upstreamRepository = join(profile, 'upstream.git');
await git('init', '--bare', upstreamRepository);
await git('push', upstreamRepository, 'main:refs/heads/main');
await git('remote', 'add', 'upstream', upstreamRepository);
await git('init', '--bare', personalFork);
await git('push', personalFork, 'main:refs/heads/main');
await git('remote', 'add', 'personal-documents', personalFork);
const forkGit = async (...args) =>
  (await promisify(execFile)('git', ['--git-dir', personalFork, ...args])).stdout.trim();

const wrapper = join(profile, 'fake-claude');
await writeFile(
  wrapper,
  `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) { console.log('2.1.325 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: false })); process.exit(0); }
const mcp = args.find((arg) => arg.startsWith('--mcp-config='));
const sessionFlag = args.indexOf('--session-id');
const session = sessionFlag >= 0 ? args[sessionFlag + 1] : require('node:crypto').randomUUID();
fs.writeFileSync(path.join(${JSON.stringify(capture)}, session + '.json'), JSON.stringify({
  session, effort: process.env.CLAUDE_CODE_EFFORT_LEVEL,
  cliEffort: args[args.indexOf('--effort') + 1],
  hasDocumentText: args.some((arg) => arg.includes('Frozen management documents:') && arg.includes('Saved through the main agent document editor.')),
  hasLaterDocumentEdit: args.some((arg) => arg.includes('A later edit.')),
  hasWaitingDocumentEdit: args.some((arg) => arg.includes('Changed while waiting.')),
  mcpUrl: mcp ? JSON.parse(mcp.slice('--mcp-config='.length)).mcpServers?.emdash?.url : undefined,
}));
process.stdin.on('data', (data) => fs.appendFileSync(path.join(${JSON.stringify(capture)}, session + '-input.txt'), data));
process.stdout.write('Isolated simulated agent is running\\n');
setInterval(() => {}, 1000);
`,
  { mode: 0o755 }
);

const mainWrapper = join(profile, 'fake-opencode');
await writeFile(
  mainWrapper,
  String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('1.4.0'); process.exit(0); }
if (!process.argv.includes('acp')) { console.log('{}'); process.exit(0); }
const failStartup = path.join(${JSON.stringify(capture)}, 'fail-next-acp-start');
if (fs.existsSync(failStartup)) { fs.unlinkSync(failStartup); process.exit(41); }
const readline = require('node:readline');
const capture = ${JSON.stringify(capture)};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'initialize') result = { protocolVersion: 1, agentInfo: { name: 'isolated-simulator', version: '1' }, agentCapabilities: { loadSession: false, mcpCapabilities: { http: true } }, authMethods: [] };
  else if (request.method === 'session/new') {
    const sessionId = 'ses_' + require('node:crypto').randomUUID();
    const mcp = request.params.mcpServers.find((server) => server.name === 'emdash');
    fs.writeFileSync(path.join(capture, 'main-session.json'), JSON.stringify({ sessionId, mcpUrl: mcp?.url, cwd: request.params.cwd }));
    const conversationId = new URL(mcp.url).pathname.split('/')[2];
    fs.writeFileSync(path.join(capture, conversationId + '.json'), JSON.stringify({ sessionId, mcpUrl: mcp.url }));
    result = { sessionId, configOptions: [] };
  } else if (request.method === 'session/prompt') {
    fs.appendFileSync(path.join(capture, 'main-prompts.jsonl'), JSON.stringify(request.params) + '\n');
    if (JSON.stringify(request.params.prompt).includes('Hold coordination turn for queue acceptance')) {
      const watcher = fs.watch(capture, (_event, name) => {
        if (name !== 'release-held-turn') return;
        watcher.close();
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } }) + '\n');
      });
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: request.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Simulated main agent response.' } } } }) + '\n');
    result = { stopReason: 'end_turn' };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
`,
  { mode: 0o755 }
);

process.chdir(appRoot);
const { config } = await resolveConfig(
  { configFile: join(appRoot, 'electron.vite.config.ts') },
  'serve'
);
// Build the real main process for a dev renderer, so its normal typed clients are available.
await build({
  ...config.main,
  configFile: false,
  logLevel: 'warn',
  define: { ...config.main.define, 'import.meta.env.DEV': 'true' },
});
const renderer = await createServer({
  ...config.renderer,
  configFile: false,
  server: { ...config.renderer.server, port: 0, host: '127.0.0.1', open: false },
});
await renderer.listen();
const env = {
  ...process.env,
  ELECTRON_RENDERER_URL: renderer.resolvedUrls.local[0],
  EMDASH_USER_DATA_DIR: profile,
  EMDASH_DB_FILE: join(profile, 'scratch.db'),
  CLAUDE_CONFIG_DIR: join(profile, 'claude'),
  CODEX_HOME: join(profile, 'codex'),
  OPENCODE_CONFIG_DIR: join(profile, 'opencode'),
  XDG_CONFIG_HOME: join(profile, 'config'),
  TELEMETRY_ENABLED: 'false',
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
let client;
let workerClient;
let replacementClient;
let crossWorkerClient;
let independentClient;
let grantedWorkerClient;
// Playwright's browser predicate treats a returned Promise as truthy before it resolves.
// Await typed Wire snapshots in Node so a pending migration cannot satisfy the condition.
const waitForSnapshot = async (predicate, argument) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, argument)) return;
    await delay(100);
  }
  throw new Error('Timed out waiting for the persisted coordination state.');
};
const waitForCapture = async (id) => {
  const file = join(capture, id + '.json');
  if (!(await readdir(capture)).includes(id + '.json')) {
    await new Promise((done, reject) => {
      const watcher = watch(capture, (_event, name) => {
        if (name === id + '.json') {
          cleanup();
          done();
        }
      });
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`The simulated agent ${id} did not spawn.`));
      }, 15000);
      const cleanup = () => {
        clearTimeout(timer);
        watcher.close();
      };
    });
  }
  return JSON.parse(await readFile(file, 'utf8'));
};
const waitForPrompt = (text, sessionId) =>
  new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const prompts = await readFile(join(capture, 'main-prompts.jsonl'), 'utf8');
        const observed = prompts
          .split('\n')
          .filter(Boolean)
          .some((line) => {
            const prompt = JSON.parse(line);
            return (
              (!sessionId || prompt.sessionId === sessionId) &&
              JSON.stringify(prompt.prompt).includes(text)
            );
          });
        if (observed) {
          cleanup();
          resolve();
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          cleanup();
          reject(error);
        }
      }
    };
    const watcher = watch(capture, () => {
      void check();
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('The expected prompt did not reach the simulated ACP agent.'));
    }, 20000);
    const cleanup = () => {
      clearTimeout(timer);
      watcher.close();
    };
    void check();
  });

async function quitApplication(application) {
  const child = application.process();
  const exited =
    child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve();
  await application.evaluate(({ app }) => app.quit()).catch(() => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const window = application.windows().find((window) => !window.isClosed());
  if (window) {
    await Promise.race([
      exited,
      (async () => {
        const quit = window.getByTestId('confirm-action-submit');
        const save = window.getByRole('button', { name: /^(Save All|保存全部|全部保存)$/ });
        const action = await Promise.race([
          quit.waitFor({ state: 'visible', timeout: 5000 }).then(() => 'quit'),
          save.waitFor({ state: 'visible', timeout: 5000 }).then(() => 'save'),
        ]);
        if (action === 'save') await save.click();
        await window.screenshot({ path: join(profile, 'quit-confirmation.png') });
        await quit.click();
      })(),
    ]).catch(() => {});
  }
  await exited;
  clearTimeout(timer);
  return { exitCode: child.exitCode, signal: child.signalCode };
}
async function waitForDocumentSave(path, expected) {
  await new Promise((done, reject) => {
    const watcher = watch(dirname(path), () => {
      void check();
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error('The editor did not save the expected document text.'));
    }, 15000);
    const check = async () => {
      const content = await readFile(path, 'utf8').catch(() => '');
      if (content.includes(expected)) {
        clearTimeout(timer);
        watcher.close();
        done();
      }
    };
    void check();
  });
}
try {
  app = await _electron.launch({
    executablePath: electronPath,
    args: [appRoot],
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForLoadState('domcontentloaded');
  const skip = page.getByRole('button', { name: /Skip for now|暂时跳过/ });
  await skip.waitFor();
  await skip.click();
  await page
    .getByRole('button', { name: /开始使用|Start shipping|Get started/ })
    .first()
    .click();
  await page.getByRole('button', { name: /^(Settings|设置)$/ }).waitFor();
  await writeFile(
    join(profile, 'modules.json'),
    JSON.stringify(
      await page.evaluate(() => ({
        url: location.href,
        resources: performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter((name) => name.includes('connection') || name.includes('main.tsx')),
      })),
      null,
      2
    )
  );

  await page.addScriptTag({
    type: 'module',
    content: `import { prepareCoordinator, coordinatorSnapshot, createReplacementMain, prepareAdditionalProject, allCoordinatorSnapshots, createTerminalMain } from '/@fs${join(appRoot, 'tooling/acceptance/task-delegation-browser.ts')}';
      Object.assign(window, { prepareCoordinator, coordinatorSnapshot, createReplacementMain, prepareAdditionalProject, allCoordinatorSnapshots, createTerminalMain });`,
  });
  await page.waitForFunction(() => typeof window.prepareCoordinator === 'function');
  const coordinator = await page.evaluate((input) => window.prepareCoordinator(input), {
    wrapper,
    mainWrapper,
    repository,
    worktreeRoot: join(profile, 'worktrees'),
  });
  await page.getByRole('button', { name: /main agent/i }).click();
  await page.getByTestId('coordinator-tasks-tab').waitFor();
  assert.ok(
    !(await readdir(capture)).includes('main-session.json'),
    'Opening a fresh main agent started a process before its first message'
  );
  await page.getByTestId('coordinator-documents-tab').click();
  const documents = page.getByTestId('coordinator-documents-panel');
  await documents.getByRole('textbox', { name: 'Document path' }).fill('plan.md');
  await documents.getByRole('button', { name: 'Create document', exact: true }).click();
  const raw = documents.getByRole('button', { name: /^(Raw|原始)$/ });
  await raw.waitFor();
  await raw.click();
  const editor = documents.locator('.monaco-editor .view-lines').first();
  await editor.click();
  const documentText =
    '# Coordination acceptance\n\nSaved through the main agent document editor.\n';
  await page.keyboard.insertText(documentText);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await page.screenshot({ path: join(profile, 'management-document.png') });
  assert.ok(
    !(await readdir(capture)).includes('main-session.json'),
    'Editing documents started an agent process'
  );
  const documentPush = documents.getByTestId('coordinator-document-push');
  await documentPush.getByText('Configure document remote', { exact: true }).click();
  await documentPush.getByTestId('document-push-remote').click();
  await page.getByRole('option', { name: /personal-documents/ }).click();
  await documentPush.getByRole('button', { name: 'Save document remote', exact: true }).click();
  await documentPush.getByText(/Document remote: personal-documents/).waitFor();
  assert.equal(
    await forkGit('for-each-ref', '--format=%(refname)'),
    'refs/heads/main',
    'Saving a remote published management documents'
  );
  assert.ok(
    !(await readdir(capture)).includes('main-session.json'),
    'Configuring a document remote started a model process'
  );
  await page.getByTestId('coordinator-conversation-tab').click();
  await page
    .locator('[contenteditable="true"]')
    .first()
    .fill('Delegate an isolated implementation task and inspect the result.');
  const send = page.getByRole('button', { name: /^(Send message|发送消息)$/ });
  await send.click();
  const main = await waitForCapture('main-session');
  assert.ok(main.mcpUrl, 'The main ACP session was not given its authenticated MCP URL');
  assert.ok(main.cwd && main.cwd !== repository);
  await assert.rejects(readFile(join(main.cwd, 'README.md'), 'utf8'), { code: 'ENOENT' });
  let hasCommonHistory = true;
  try {
    await promisify(execFile)('git', ['merge-base', baseline, 'HEAD'], { cwd: main.cwd });
  } catch (error) {
    assert.equal(error.code, 1);
    hasCommonHistory = false;
  }
  assert.equal(hasCommonHistory, false, 'The main agent inherited code history');
  assert.equal(await git('rev-parse', 'HEAD'), baseline);

  await waitForPrompt('main agent');
  client = new Client({ name: 'isolated-main-agent', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(main.mcpUrl)));
  const call = async (caller, name, args) => {
    const result = await caller.callTool({ name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result.content.find((item) => item.type === 'text').text;
  };
  const documentRead = JSON.parse(
    await call(client, 'read_management_document', { path: 'plan.md' })
  );
  assert.equal(documentRead.content, documentText);
  assert.ok(documentRead.revision.startsWith('disk:'));
  assert.equal(await readFile(join(main.cwd, 'plan.md'), 'utf8'), documentText);
  const forbiddenDocument = await client.callTool({
    name: 'read_management_document',
    arguments: { path: '../README.md' },
  });
  assert.equal(forbiddenDocument.isError, true);
  const args = {
    name: 'Coordinated implementation',
    prompt: 'Simulated implementation',
    agent: 'claude',
    effort: 'high',
    connection: 'official',
    request_id: 'coordinated-request',
    document_refs: [{ path: 'plan.md', revision: documentRead.revision }],
  };
  const created = JSON.parse(await call(client, 'create_task', args));
  const duplicate = JSON.parse(await call(client, 'create_task', args));
  assert.equal(created.task_id, duplicate.task_id);
  await writeFile(join(main.cwd, 'plan.md'), documentText + 'A later edit.\n');
  const staleDocument = await client.callTool({
    name: 'read_management_document',
    arguments: { path: 'plan.md', revision: documentRead.revision },
  });
  assert.equal(staleDocument.isError, true);
  assert.equal(JSON.parse(await call(client, 'create_task', args)).task_id, created.task_id);
  const spawned = await waitForCapture(created.conversation_id);
  assert.equal(spawned.effort, 'high');
  assert.equal(spawned.cliEffort, 'high');
  assert.equal(spawned.hasDocumentText, true);
  assert.equal(spawned.hasLaterDocumentEdit, false);
  const head = (
    await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: created.path })
  ).stdout.trim();
  assert.equal(head, baseline);
  await writeFile(join(created.path, 'acceptance.js'), 'export const completed = true;\n');
  const syntax = await promisify(execFile)(process.execPath, ['--check', 'acceptance.js'], {
    cwd: created.path,
  });
  const workerGit = async (...args) =>
    (await promisify(execFile)('git', args, { cwd: created.path })).stdout.trim();
  await workerGit('add', 'acceptance.js');
  await workerGit(
    '-c',
    'user.name=Emdash test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'Simulated delegated change'
  );
  const workerCommit = await workerGit('rev-parse', 'HEAD');
  const diff = await workerGit('diff', baseline, workerCommit, '--', 'acceptance.js');
  assert.ok(diff.includes('+export const completed = true;'));
  assert.ok(spawned.mcpUrl);
  workerClient = new Client({ name: 'isolated-worker-agent', version: '1' });
  await workerClient.connect(new StreamableHTTPClientTransport(new URL(spawned.mcpUrl)));
  const savedDocument = JSON.parse(
    await call(workerClient, 'read_management_document', {
      path: 'plan.md',
      revision: documentRead.revision,
    })
  );
  assert.equal(savedDocument.content, documentText);
  const unauthorizedDocument = await workerClient.callTool({
    name: 'read_management_document',
    arguments: { path: 'unselected.md' },
  });
  assert.equal(unauthorizedDocument.isError, true);
  await assert.rejects(readFile(join(created.path, 'plan.md'), 'utf8'), { code: 'ENOENT' });
  const terminalMessageArgs = {
    conversation_id: created.conversation_id,
    text: 'Manually inspect the terminal task',
    request_id: 'pty-pending-ui',
  };
  const terminalMessage = JSON.parse(await call(client, 'send_message', terminalMessageArgs));
  assert.equal(terminalMessage.status, 'pending');
  await page
    .getByRole('button', { name: /^(打开任务|Open task) Coordinated implementation$/ })
    .click();
  const pendingPanel = page.getByTestId('pending-agent-messages');
  await pendingPanel.getByRole('button', { name: 'Pending messages (1)', exact: true }).click();
  await pendingPanel.getByText(terminalMessageArgs.text, { exact: true }).waitFor();
  await page.screenshot({ path: join(profile, 'pending-terminal-message.png') });
  await pendingPanel.getByRole('button', { name: 'Mark handled', exact: true }).click();
  await pendingPanel.waitFor({ state: 'hidden' });
  assert.equal(
    JSON.parse(await call(client, 'send_message', terminalMessageArgs)).status,
    'handled'
  );
  assert.ok(
    !(await readdir(capture)).includes(created.conversation_id + '-input.txt'),
    'Background terminal message injected input'
  );
  await page.getByRole('button', { name: /main agent/i }).click();
  const submission = {
    task_id: created.task_id,
    request_id: 'result-1',
    result: {
      summary: 'Simulated task result',
      commits: [workerCommit],
      checks: [
        {
          command: 'node --check acceptance.js',
          passed: true,
          output: syntax.stdout || 'Syntax check passed',
        },
      ],
      unresolved: [],
      prUrls: [],
    },
  };
  const composer = page.locator(`[data-acp-conversation-id="${coordinator.conversationId}"]`);
  await composer
    .locator('[contenteditable="true"]')
    .fill('Hold coordination turn for queue acceptance');
  await composer.getByRole('button', { name: /^(Send message|发送消息)$/ }).click();
  await waitForPrompt('Hold coordination turn for queue acceptance', main.sessionId);
  const receipt = JSON.parse(await call(workerClient, 'submit_task_result', submission));
  await composer
    .locator('[contenteditable="true"]')
    .fill('User follow-up before background result');
  await composer.getByRole('button', { name: /^(Queue message|排队发送)$/ }).click();
  await composer.getByText('User follow-up before background result', { exact: true }).waitFor();
  assert.ok(
    !(await readFile(join(capture, 'main-prompts.jsonl'), 'utf8')).includes(receipt.eventId),
    'Background result interrupted the active user turn'
  );
  await writeFile(join(capture, 'release-held-turn'), 'release');
  await waitForPrompt(receipt.eventId, main.sessionId);
  const queueOrder = (await readFile(join(capture, 'main-prompts.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const userIndex = queueOrder.findIndex(
    (prompt) =>
      prompt.sessionId === main.sessionId &&
      JSON.stringify(prompt.prompt).includes('User follow-up before background result')
  );
  const resultIndex = queueOrder.findIndex(
    (prompt) =>
      prompt.sessionId === main.sessionId && JSON.stringify(prompt.prompt).includes(receipt.eventId)
  );
  assert.ok(
    userIndex >= 0 && userIndex < resultIndex,
    'User follow-up did not take priority over the background result'
  );

  const repeated = JSON.parse(await call(workerClient, 'submit_task_result', submission));
  assert.deepEqual(repeated, receipt);
  await page.getByTestId('coordinator-tasks-tab').click();
  await page.getByText('Simulated task result', { exact: true }).waitFor();
  await page.getByTestId('coordinator-accept-result').waitFor();
  await waitForSnapshot(async (id) => {
    const record = await window.coordinatorSnapshot(id);
    return record.events.some((event) => event.state === 'queued');
  }, coordinator.taskId);
  await waitForPrompt(receipt.eventId);
  const before = await page.evaluate((id) => window.coordinatorSnapshot(id), coordinator.taskId);
  assert.equal(before.tasks[created.task_id].state, 'review');
  await call(client, 'acknowledge_task_results', { event_ids: [receipt.eventId] });
  await call(client, 'review_task_result', {
    task_id: created.task_id,
    result_version: 1,
    accepted: false,
    note: 'Add another check',
  });
  const revision = await page.evaluate((id) => window.coordinatorSnapshot(id), coordinator.taskId);
  assert.equal(revision.tasks[created.task_id].state, 'changes_requested');
  await call(client, 'review_task_result', {
    task_id: created.task_id,
    result_version: 1,
    accepted: true,
    note: 'Inspected simulated evidence',
  });
  const final = await page.evaluate((id) => window.coordinatorSnapshot(id), coordinator.taskId);
  assert.equal(final.tasks[created.task_id].state, 'done');
  assert.equal(final.events[0].state, 'acknowledged');
  assert.equal(final.events.length, 1);
  const relatedRepository = join(profile, 'related-repository');
  await mkdir(relatedRepository);
  const relatedGit = async (...args) =>
    (await promisify(execFile)('git', args, { cwd: relatedRepository })).stdout.trim();
  await relatedGit('init', '-b', 'develop');
  await writeFile(join(relatedRepository, 'README.md'), 'Independent related baseline\n');
  await relatedGit('add', 'README.md');
  await relatedGit(
    '-c',
    'user.name=Emdash test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'Related baseline'
  );
  const relatedBaseline = await relatedGit('rev-parse', 'HEAD');
  const relatedProjectId = await page.evaluate((input) => window.prepareAdditionalProject(input), {
    wrapper,
    repository: relatedRepository,
    worktreeRoot: join(profile, 'related-worktrees'),
    name: 'Related repository',
    baselineBranch: 'develop',
  });
  const discovered = JSON.parse(await call(client, 'list_projects', {}));
  assert.ok(discovered.some((project) => project.id === relatedProjectId));
  assert.ok(discovered.some((project) => project.id === coordinator.projectId));
  const cross = JSON.parse(
    await call(client, 'create_task', {
      project_id: relatedProjectId,
      name: 'Related repository change',
      request_id: 'cross-request',
      agent: 'opencode',
      ui: 'chat',
      prompt: 'Implement related fixture',
      connection: 'official',
      effort: null,
    })
  );
  assert.equal(cross.project_id, relatedProjectId);
  const actualCrossBranch = (
    await promisify(execFile)('git', ['branch', '--show-current'], { cwd: cross.path })
  ).stdout.trim();
  assert.equal(cross.branch, actualCrossBranch);
  const crossHead = (
    await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: cross.path })
  ).stdout.trim();
  assert.equal(crossHead, relatedBaseline);
  assert.notEqual(crossHead, baseline);
  const crossCapture = await waitForCapture(cross.conversation_id);
  await waitForPrompt('Implement related fixture', crossCapture.sessionId);
  crossWorkerClient = new Client({ name: 'cross-project-worker', version: '1' });
  await crossWorkerClient.connect(new StreamableHTTPClientTransport(new URL(crossCapture.mcpUrl)));
  const workerProjects = JSON.parse(await call(crossWorkerClient, 'list_projects', {}));
  assert.deepEqual(
    workerProjects.map((project) => project.id),
    [relatedProjectId]
  );
  const deniedWorker = await crossWorkerClient.callTool({
    name: 'create_task',
    arguments: {
      project_id: coordinator.projectId,
      name: 'Unauthorized child',
      request_id: 'denied-worker',
    },
  });
  assert.equal(deniedWorker.isError, true, 'A worker expanded its project access without a grant');
  const remoteList = JSON.parse(await call(client, 'list_tasks', { project_id: relatedProjectId }));
  assert.deepEqual(
    remoteList.map((task) => task.id),
    [cross.task_id]
  );
  const remoteConversations = JSON.parse(
    await call(client, 'list_conversations', {
      project_id: relatedProjectId,
      task_id: cross.task_id,
      scope: 'task',
    })
  );
  assert.equal(remoteConversations[0].id, cross.conversation_id);
  const status = JSON.parse(await call(client, 'get_task_status', { task_id: cross.task_id }));
  const owner = await page.evaluate((id) => window.coordinatorSnapshot(id), coordinator.taskId);
  assert.equal(status.coordination.coordinatorId, owner.id);
  const message = {
    conversation_id: cross.conversation_id,
    text: 'Cross project follow-up',
    request_id: 'cross-message',
  };
  const sent = JSON.parse(await call(client, 'send_message', message));
  assert.equal(sent.status, 'accepted');
  assert.deepEqual(JSON.parse(await call(client, 'send_message', message)), sent);
  await waitForPrompt(message.text, crossCapture.sessionId);
  const capturedPrompts = (await readFile(join(capture, 'main-prompts.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(
    capturedPrompts.filter(
      (prompt) =>
        prompt.sessionId === crossCapture.sessionId &&
        JSON.stringify(prompt.prompt).includes(message.text)
    ).length,
    1
  );
  const branchCount = (await relatedGit('for-each-ref', '--format=%(refname)', 'refs/heads')).split(
    '\n'
  ).length;
  await page.getByTestId('coordinator-settings-tab').click();
  await page.getByTestId('coordinator-project-access').click();
  await page.getByTestId('coordinator-access-selected').click();
  await page.getByTestId('coordinator-save-access').click();
  await waitForSnapshot(
    async (id) => (await window.coordinatorSnapshot(id)).projectAccess?.mode === 'selected',
    coordinator.taskId
  );
  const denied = await client.callTool({
    name: 'create_task',
    arguments: {
      project_id: relatedProjectId,
      name: 'Denied cross project',
      request_id: 'denied-main',
    },
  });
  assert.equal(denied.isError, true);
  const restricted = JSON.parse(await call(client, 'list_projects', {}));
  assert.ok(!restricted.some((project) => project.id === relatedProjectId));
  assert.equal(
    (await relatedGit('for-each-ref', '--format=%(refname)', 'refs/heads')).split('\n').length,
    branchCount
  );
  await page.getByTestId('coordinator-project-access').click();
  await page.getByTestId('coordinator-access-all').click();
  await page.getByTestId('coordinator-save-access').click();
  await waitForSnapshot(
    async (id) => (await window.coordinatorSnapshot(id)).projectAccess?.mode === 'all',
    coordinator.taskId
  );
  const crossReceipt = JSON.parse(
    await call(crossWorkerClient, 'submit_task_result', {
      task_id: cross.task_id,
      request_id: 'cross-result',
      result: {
        summary: 'Related repository result',
        commits: [crossHead],
        checks: [{ command: 'git rev-parse HEAD', passed: true, output: crossHead }],
        unresolved: [],
        prUrls: [],
      },
    })
  );
  await waitForPrompt(crossReceipt.eventId, main.sessionId);
  await call(client, 'acknowledge_task_results', { event_ids: [crossReceipt.eventId] });
  await call(client, 'review_task_result', {
    task_id: cross.task_id,
    result_version: 1,
    accepted: true,
    note: 'Inspected related repository baseline and results',
  });
  const replacement = await page.evaluate((input) => window.createReplacementMain(input), {
    projectId: coordinator.projectId,
    taskId: coordinator.taskId,
  });
  const secondReceipt = JSON.parse(
    await call(workerClient, 'submit_task_result', {
      ...submission,
      request_id: 'result-2',
      result: { ...submission.result, summary: 'Updated result for replacement main' },
    })
  );
  await page.getByTestId('coordinator-settings-tab').click();
  await page.getByTestId('coordinator-main-conversation').click();
  await page.getByRole('option', { name: /Replacement main/ }).click();
  await page.getByTestId('coordinator-bind-main').click();
  await waitForSnapshot(
    async ({ taskId, conversationId }) =>
      (await window.coordinatorSnapshot(taskId)).conversationId === conversationId,
    { taskId: coordinator.taskId, conversationId: replacement.id }
  );
  const replacementCapture = await waitForCapture(replacement.id);
  await waitForPrompt(secondReceipt.eventId, replacementCapture.sessionId);
  assert.notEqual(replacementCapture.mcpUrl, main.mcpUrl);
  const oldAcknowledgment = await client.callTool({
    name: 'acknowledge_task_results',
    arguments: { event_ids: [secondReceipt.eventId] },
  });
  assert.equal(
    oldAcknowledgment.isError,
    true,
    'The replaced main conversation retained result consumption authority'
  );
  replacementClient = new Client({ name: 'replacement-main-agent', version: '1' });
  await replacementClient.connect(
    new StreamableHTTPClientTransport(new URL(replacementCapture.mcpUrl))
  );
  await call(replacementClient, 'acknowledge_task_results', { event_ids: [secondReceipt.eventId] });
  await call(replacementClient, 'review_task_result', {
    task_id: created.task_id,
    result_version: 2,
    accepted: true,
    note: 'Replacement main inspected revision 2',
  });
  const switched = await page.evaluate((id) => window.coordinatorSnapshot(id), coordinator.taskId);
  assert.equal(switched.taskId, coordinator.taskId);
  assert.equal(switched.tasks[created.task_id].state, 'done');
  assert.equal(switched.events.length, 3);
  assert.ok(switched.events.every((event) => event.state === 'acknowledged'));
  await page.getByTestId('coordinator-tasks-tab').click();
  await page.screenshot({ path: join(profile, 'coordinator-result.png') });
  await page.getByTestId('coordinator-settings-tab').click();
  const createForm = page.getByTestId('cross-project-agent-form');
  await createForm.getByTestId('cross-project-agent-name').fill('Independent integration');
  await createForm.getByTestId('cross-project-agent-type').click();
  await page.getByRole('option', { name: 'opencode', exact: true }).click();
  await createForm.getByLabel('Related repository', { exact: true }).check();
  await createForm.getByTestId('create-cross-project-agent').click();
  const independentRow = page
    .getByTestId('cross-project-main-agents')
    .getByRole('button', { name: 'Independent integration', exact: true });
  await independentRow.waitFor();
  const independent = await page.evaluate(async () =>
    (await window.allCoordinatorSnapshots()).find(
      (record) => record.name === 'Independent integration'
    )
  );
  assert.ok(independent && independent.kind === 'cross-project');
  assert.notEqual(independent.taskId, coordinator.taskId);
  assert.ok(independent.projectIds.includes(relatedProjectId));
  await independentRow.click();
  await page.getByTestId('coordinator-conversation-tab').click();
  const independentComposer = page.locator(
    `[data-acp-conversation-id="${independent.conversationId}"]`
  );
  await independentComposer
    .locator('[contenteditable="true"]')
    .fill('Coordinate two repositories explicitly.');
  await independentComposer.getByRole('button', { name: /^(Send message|发送消息)$/ }).click();
  const independentCapture = await waitForCapture(independent.conversationId);
  independentClient = new Client({ name: 'independent-cross-main', version: '1' });
  await independentClient.connect(
    new StreamableHTTPClientTransport(new URL(independentCapture.mcpUrl))
  );
  const implicitTarget = await independentClient.callTool({
    name: 'create_task',
    arguments: { name: 'Ambiguous target', request_id: 'ambiguous-target' },
  });
  assert.equal(
    implicitTarget.isError,
    true,
    'Independent main used its document project as an implicit code target'
  );
  const grantedTask = JSON.parse(
    await call(independentClient, 'create_task', {
      project_id: relatedProjectId,
      project_grants: [coordinator.projectId],
      name: 'Independent related task',
      request_id: 'independent-work',
      agent: 'opencode',
      ui: 'chat',
      prompt: 'Independent delegated task',
      connection: 'official',
      effort: null,
    })
  );
  const grantedCapture = await waitForCapture(grantedTask.conversation_id);
  grantedWorkerClient = new Client({ name: 'explicitly-granted-worker', version: '1' });
  await grantedWorkerClient.connect(
    new StreamableHTTPClientTransport(new URL(grantedCapture.mcpUrl))
  );
  const grantedProjects = JSON.parse(await call(grantedWorkerClient, 'list_projects', {}));
  assert.equal(grantedProjects.length, 2);
  const child = JSON.parse(
    await call(grantedWorkerClient, 'create_task', {
      project_id: coordinator.projectId,
      name: 'Granted repository work',
      request_id: 'granted-child',
    })
  );
  assert.equal(child.project_id, coordinator.projectId);
  const childStatus = JSON.parse(
    await call(independentClient, 'get_task_status', { task_id: child.task_id })
  );
  assert.equal(childStatus.coordination.coordinatorId, independent.id);
  const expandedGrant = await grantedWorkerClient.callTool({
    name: 'create_task',
    arguments: {
      project_id: coordinator.projectId,
      project_grants: [relatedProjectId],
      name: 'Expanded child grant',
      request_id: 'expanded-child-grant',
    },
  });
  assert.equal(expandedGrant.isError, true);
  const dependentRequest = {
    project_id: coordinator.projectId,
    name: 'Consume approved SDK result',
    request_id: 'dependent-work',
    depends_on: [grantedTask.task_id],
    document_refs: [{ coordinator_id: documentRead.coordinatorId, path: 'plan.md' }],
    agent: 'claude',
    ui: 'terminal',
    prompt: 'Consume only the approved prerequisite version',
    connection: 'official',
    effort: 'high',
  };
  const dependentPlan = JSON.parse(await call(independentClient, 'create_task', dependentRequest));
  assert.equal(dependentPlan.status, 'blocked');
  assert.equal(dependentPlan.path, undefined);
  assert.ok(dependentPlan.waiting_for.includes('Waiting for review'));
  await writeFile(join(main.cwd, 'plan.md'), documentText + 'Changed while waiting.\n');
  assert.ok(!(await readdir(capture)).includes(dependentPlan.conversation_id + '.json'));
  const plannedStatus = JSON.parse(
    await call(independentClient, 'get_task_status', { task_id: dependentPlan.task_id })
  );
  assert.equal(plannedStatus.task.workspacePending, true);
  assert.equal(plannedStatus.coordination.assignment.taskCreated, false);
  const plannedList = JSON.parse(
    await call(independentClient, 'list_tasks', { project_id: coordinator.projectId })
  );
  assert.ok(plannedList.some((task) => task.id === dependentPlan.task_id && task.workspacePending));
  const branchesBeforeReview = await git('worktree', 'list', '--porcelain');
  assert.ok(!branchesBeforeReview.includes('refs/heads/' + dependentPlan.planned_branch));
  assert.equal(
    JSON.parse(await call(independentClient, 'create_task', dependentRequest)).task_id,
    dependentPlan.task_id
  );
  const cancelledPlan = JSON.parse(
    await call(independentClient, 'create_task', {
      ...dependentRequest,
      name: 'Cancelled waiting consumer',
      request_id: 'cancelled-dependent',
    })
  );
  await page.getByTestId('coordinator-tasks-tab').click();
  const cancelArticle = page.locator('article').filter({ hasText: 'Cancelled waiting consumer' });
  await cancelArticle.getByRole('button', { name: 'Cancel waiting task', exact: true }).click();
  await cancelArticle.getByText('Cancelled before startup.', { exact: true }).waitFor();
  const cancelledStatus = JSON.parse(
    await call(independentClient, 'get_task_status', { task_id: cancelledPlan.task_id })
  );
  assert.equal(cancelledStatus.coordination.assignment.state, 'cancelled');
  await call(independentClient, 'cancel_pending_task', { task_id: cancelledPlan.task_id });
  const independentResult = JSON.parse(
    await call(grantedWorkerClient, 'submit_task_result', {
      task_id: grantedTask.task_id,
      request_id: 'independent-result',
      result: {
        summary: 'Independent coordination result',
        commits: [relatedBaseline],
        checks: [],
        unresolved: [],
        prUrls: [],
      },
    })
  );
  await waitForPrompt(independentResult.eventId, independentCapture.sessionId);
  await call(independentClient, 'acknowledge_task_results', {
    event_ids: [independentResult.eventId],
  });
  const beforeDependencyReview = JSON.parse(
    await call(independentClient, 'get_task_status', { task_id: dependentPlan.task_id })
  );
  assert.equal(beforeDependencyReview.coordination.assignment.state, 'blocked');
  assert.equal(
    beforeDependencyReview.coordination.assignment.documents[0].content,
    documentText + 'A later edit.\n'
  );
  assert.ok(!(await readdir(capture)).includes(dependentPlan.conversation_id + '.json'));
  await call(independentClient, 'review_task_result', {
    task_id: grantedTask.task_id,
    result_version: 1,
    accepted: true,
    note: 'Inspected independent main task result',
  });
  const dependentCapture = await waitForCapture(dependentPlan.conversation_id);
  assert.equal(dependentCapture.hasDocumentText, true);
  assert.equal(dependentCapture.hasLaterDocumentEdit, true);
  assert.equal(dependentCapture.hasWaitingDocumentEdit, false);
  assert.equal(dependentCapture.effort, 'high');
  assert.equal(dependentCapture.cliEffort, 'high');
  assert.ok(!(await readdir(capture)).includes(cancelledPlan.conversation_id + '.json'));
  assert.equal(
    JSON.parse(
      await call(independentClient, 'create_task', {
        ...dependentRequest,
        name: 'Cancelled waiting consumer',
        request_id: 'cancelled-dependent',
      })
    ).status,
    'blocked'
  );
  const dependentStarted = JSON.parse(
    await call(independentClient, 'create_task', dependentRequest)
  );
  assert.equal(dependentStarted.status, 'agent_started');
  assert.equal(dependentStarted.task_id, dependentPlan.task_id);
  assert.equal(dependentStarted.conversation_id, dependentPlan.conversation_id);
  const dependencySnapshot = JSON.parse(
    await call(independentClient, 'get_task_status', { task_id: dependentPlan.task_id })
  );
  assert.equal(dependencySnapshot.coordination.assignment.taskCreated, true);
  assert.deepEqual(dependencySnapshot.coordination.assignment.dependencyResults, [
    {
      taskId: grantedTask.task_id,
      projectId: relatedProjectId,
      version: 1,
      commits: [relatedBaseline],
    },
  ]);
  const startedHead = (
    await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: dependentStarted.path })
  ).stdout.trim();
  assert.equal(startedHead, baseline);
  await page.getByTestId('coordinator-tasks-tab').click();
  await page.getByText('Independent coordination result', { exact: true }).waitFor();
  await page.screenshot({ path: join(profile, 'independent-main-result.png') });
  const beforeTransferHead = (
    await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: cross.path })
  ).stdout.trim();
  const foreignMessage = await independentClient.callTool({
    name: 'send_message',
    arguments: {
      conversation_id: cross.conversation_id,
      text: 'Before takeover',
      request_id: 'foreign-before-takeover',
    },
  });
  assert.equal(foreignMessage.isError, true);
  const transferResult = JSON.parse(
    await call(crossWorkerClient, 'submit_task_result', {
      task_id: cross.task_id,
      request_id: 'pending-transfer-result',
      result: {
        summary: 'Result pending while ownership changes',
        commits: [beforeTransferHead],
        checks: [],
        unresolved: [],
        prUrls: [],
      },
    })
  );
  await page.getByTestId('takeover-task-id').fill(cross.task_id);
  await page.getByTestId('inspect-task-takeover').click();
  await page.getByTestId('confirm-task-takeover').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="takeover-task-id"]').value === ''
  );
  await page.getByText('Result pending while ownership changes', { exact: true }).waitFor();
  const previousOwner = await page.evaluate(
    (id) => window.coordinatorSnapshot(id),
    coordinator.taskId
  );
  assert.equal(previousOwner.tasks[cross.task_id], undefined);
  const takeoverRetry = JSON.parse(
    await call(independentClient, 'take_over_task', {
      task_id: cross.task_id,
      expected_owner: owner.id,
    })
  );
  assert.equal(takeoverRetry.assignment.ownershipHistory.length, 1);
  const afterTransferHead = (
    await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: cross.path })
  ).stdout.trim();
  assert.equal(afterTransferHead, beforeTransferHead);
  await waitForPrompt(transferResult.eventId, independentCapture.sessionId);
  const oldOwnerAck = await replacementClient.callTool({
    name: 'acknowledge_task_results',
    arguments: { event_ids: [transferResult.eventId] },
  });
  assert.equal(oldOwnerAck.isError, true);
  const oldOwnerReview = await replacementClient.callTool({
    name: 'review_task_result',
    arguments: { task_id: cross.task_id, result_version: 2, accepted: true, note: 'Stale owner' },
  });
  assert.equal(oldOwnerReview.isError, true);
  await call(independentClient, 'acknowledge_task_results', {
    event_ids: [transferResult.eventId],
  });
  await call(independentClient, 'review_task_result', {
    task_id: cross.task_id,
    result_version: 2,
    accepted: true,
    note: 'New owner inspected transferred result',
  });
  await page.getByText('Result pending while ownership changes', { exact: true }).waitFor();
  await page.screenshot({ path: join(profile, 'takeover-result.png') });
  const terminalMain = await page.evaluate((input) => window.createTerminalMain(input), {
    projectId: independent.projectId,
    taskId: independent.taskId,
  });
  const terminalMainCapture = await waitForCapture(terminalMain.id);
  await page.getByTestId('coordinator-settings-tab').click();
  await page.getByTestId('coordinator-main-conversation').click();
  await page.getByRole('option', { name: /Terminal main|终端 main/ }).click();
  await page.getByTestId('coordinator-bind-main').click();
  await page.getByText('Main conversation updated', { exact: true }).waitFor();
  const terminalBinding = await page.evaluate(async () =>
    (await window.allCoordinatorSnapshots()).find((entry) => entry.kind === 'cross-project')
  );
  assert.equal(terminalBinding.conversationId, terminalMain.id);
  await independentClient.close();
  independentClient = new Client({ name: 'terminal-main-with-pending-results', version: '1' });
  await independentClient.connect(
    new StreamableHTTPClientTransport(new URL(terminalMainCapture.mcpUrl))
  );
  const terminalResult = JSON.parse(
    await call(crossWorkerClient, 'submit_task_result', {
      task_id: cross.task_id,
      request_id: 'terminal-main-result',
      result: {
        summary: 'Result waiting for terminal main',
        commits: [beforeTransferHead],
        checks: [],
        unresolved: [],
        prUrls: [],
      },
    })
  );
  const resultInbox = page.getByTestId('pending-agent-messages');
  await resultInbox.getByRole('button', { name: 'Pending messages (1)', exact: true }).click();
  await resultInbox.getByText(/Result waiting for terminal main/).waitFor();
  await page.screenshot({ path: join(profile, 'pending-terminal-result.png') });
  await resultInbox.getByRole('button', { name: 'Mark handled', exact: true }).click();
  await resultInbox.waitFor({ state: 'hidden' });
  const afterManualResult = await page.evaluate(async () =>
    (await window.allCoordinatorSnapshots()).find((entry) => entry.kind === 'cross-project')
  );
  assert.equal(
    afterManualResult.events.find((event) => event.id === terminalResult.eventId).state,
    'acknowledged'
  );
  assert.equal(
    afterManualResult.tasks[cross.task_id].state,
    'review',
    'Handling a notification incorrectly completed its task'
  );
  assert.ok(
    !(await readdir(capture)).includes(terminalMain.id + '-input.txt'),
    'Result notification injected input into the main terminal'
  );
  await writeFile(join(capture, 'fail-next-acp-start'), 'Inject one ACP startup failure.\n');
  const failedStartup = await replacementClient.callTool({
    name: 'create_task',
    arguments: {
      name: 'Recover failed startup',
      request_id: 'recover-failed-startup',
      project_id: coordinator.projectId,
      agent: 'opencode',
      connection: 'official',
      effort: null,
      ui: 'chat',
      prompt: 'Continue the saved task after recovery.',
      document_refs: [{ path: 'plan.md' }],
    },
  });
  assert.equal(failedStartup.isError, true, 'The injected startup failure was not reported');
  const tasksAfterFailure = JSON.parse(
    await call(replacementClient, 'list_tasks', { project_id: coordinator.projectId })
  );
  const failedTask = tasksAfterFailure.find((task) => task.name === 'Recover failed startup');
  assert.ok(failedTask, 'The failed task was lost');
  const failedStatus = JSON.parse(
    await call(replacementClient, 'get_task_status', { task_id: failedTask.id })
  );
  assert.equal(failedStatus.delegation.phase, 'starting');
  assert.equal(failedStatus.delegation.canRetry, true);
  assert.ok(failedStatus.delegation.error);
  const failedHead = (
    await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: failedStatus.delegation.path })
  ).stdout.trim();
  await writeFile(
    join(main.cwd, 'plan.md'),
    documentText + '\nChanged while waiting.\nAfter startup failure.\n'
  );
  const failedTransfer = JSON.parse(
    await call(independentClient, 'take_over_task', {
      task_id: failedTask.id,
      expected_owner: owner.id,
    })
  );
  assert.deepEqual(
    failedTransfer.assignment.documents,
    failedStatus.coordination.assignment.documents
  );
  const staleRetry = await replacementClient.callTool({
    name: 'retry_task',
    arguments: { task_id: failedTask.id },
  });
  assert.equal(staleRetry.isError, true, 'The former owner retried a transferred task');
  const snapshotsBeforeRestart = await page.evaluate(() => window.allCoordinatorSnapshots());
  await page.close();
  const backgroundList = JSON.parse(
    await call(replacementClient, 'list_tasks', { project_id: relatedProjectId })
  );
  assert.ok(backgroundList.some((task) => task.id === cross.task_id));
  const backgroundMessage = JSON.parse(
    await call(independentClient, 'send_message', {
      conversation_id: cross.conversation_id,
      request_id: 'after-renderer-close',
      text: 'Follow-up with no renderer',
    })
  );
  assert.equal(backgroundMessage.status, 'accepted');
  await waitForPrompt('Follow-up with no renderer', crossCapture.sessionId);
  await Promise.allSettled([
    client.close(),
    workerClient.close(),
    replacementClient.close(),
    crossWorkerClient.close(),
    independentClient.close(),
    grantedWorkerClient.close(),
  ]);
  const stopped = await quitApplication(app);
  assert.equal(stopped.exitCode, 0, 'The application did not quit cleanly before restart');
  app = undefined;
  app = await _electron.launch({
    executablePath: electronPath,
    args: [appRoot],
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: /^(Settings|设置)$/ }).waitFor();
  await page.addScriptTag({
    type: 'module',
    content: `import { allCoordinatorSnapshots, readCoordinatorDocument, prepareCoordinator, coordinatorDelegationStatus, prepareLegacyCoordinatorFixture } from '/@fs${join(appRoot, 'tooling/acceptance/task-delegation-browser.ts')}'; Object.assign(window, { allCoordinatorSnapshots, readCoordinatorDocument, prepareCoordinator, coordinatorDelegationStatus, prepareLegacyCoordinatorFixture });`,
  });
  await page.waitForFunction(() => typeof window.allCoordinatorSnapshots === 'function');
  const restored = await page.evaluate(() => window.allCoordinatorSnapshots());
  assert.deepEqual(
    restored.map((record) => record.id).sort(),
    snapshotsBeforeRestart.map((record) => record.id).sort()
  );
  for (const saved of snapshotsBeforeRestart) {
    const record = restored.find((entry) => entry.id === saved.id);
    assert.equal(record.taskId, saved.taskId);
    assert.equal(record.conversationId, saved.conversationId);
    assert.deepEqual(record.documentPushTarget, saved.documentPushTarget);
    assert.deepEqual(Object.keys(record.tasks).sort(), Object.keys(saved.tasks).sort());
    for (const [id, task] of Object.entries(saved.tasks)) {
      assert.equal(record.tasks[id].state, task.state);
      assert.deepEqual(record.tasks[id].documents, task.documents);
    }
  }
  const expandSource = page.getByRole('button', { name: /^(Expand|展开) Delegation acceptance$/ });
  if (await expandSource.isVisible()) await expandSource.click();
  await page
    .locator(`[data-testid="project-main-agent"][data-project-id="${coordinator.projectId}"]`)
    .click();
  await page
    .locator(`[data-testid="coordinator-panel"][data-task-id="${coordinator.taskId}"]`)
    .waitFor();
  await page.getByTestId('coordinator-documents-tab').click();
  const restoredDocuments = page.getByTestId('coordinator-documents-panel');
  await restoredDocuments.getByText('plan.md', { exact: true }).last().dblclick();
  await restoredDocuments.getByRole('button', { name: /^(Raw|原始)$/ }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('.monaco-editor .view-lines')).some((element) =>
      element.textContent.replace(/\u00a0/g, ' ').includes('Changed while waiting.')
    )
  );
  await restoredDocuments.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await page.keyboard.insertText('\nAfter full restart.\n');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await waitForDocumentSave(join(main.cwd, 'plan.md'), 'After full restart.');
  await page.screenshot({ path: join(profile, 'management-document-restarted.png') });
  const documentGit = async (...args) =>
    (await promisify(execFile)('git', args, { cwd: main.cwd })).stdout.trim();
  const documentParent = await documentGit('rev-parse', 'HEAD');
  await writeFile(
    join(main.cwd, 'unrelated.md'),
    'Keep this staged, outside the selected document commit.\n'
  );
  await documentGit('add', '--', 'unrelated.md');
  await restoredDocuments
    .getByRole('textbox', { name: 'Document commit message' })
    .fill('Save accepted coordination document');
  await restoredDocuments
    .getByRole('button', { name: 'Commit open document', exact: true })
    .click();
  await restoredDocuments.getByTestId('coordinator-document-commit').waitFor();
  const documentCommit = await documentGit('rev-parse', 'HEAD');
  assert.notEqual(documentCommit, documentParent);
  assert.equal(await documentGit('rev-parse', 'HEAD^'), documentParent);
  assert.equal(await documentGit('show', '--format=', '--name-only', 'HEAD'), 'plan.md');
  assert.equal(await documentGit('diff', '--cached', '--name-only'), 'unrelated.md');
  const committedDocument = await page.evaluate(
    (input) => window.readCoordinatorDocument(input.taskId, 'plan.md', input.revision),
    { taskId: coordinator.taskId, revision: documentCommit }
  );
  assert.equal(committedDocument.revision, documentCommit);
  assert.ok(committedDocument.content.includes('After full restart.'));
  await page.screenshot({ path: join(profile, 'management-document-committed.png') });
  await documentGit(
    'tag',
    '-a',
    'keep-document-tag-local',
    '-m',
    'Do not push this management tag'
  );
  await documentGit('config', 'push.followTags', 'true');
  const restoredPush = restoredDocuments.getByTestId('coordinator-document-push');
  await restoredPush.getByText(/Document remote: personal-documents/).waitFor();
  await restoredPush.getByRole('button', { name: 'Push committed documents', exact: true }).click();
  await restoredPush.getByTestId('coordinator-document-pushed').waitFor();
  const managementRef = await documentGit('symbolic-ref', 'HEAD');
  assert.equal(await forkGit('rev-parse', managementRef), documentCommit);
  assert.equal(await forkGit('rev-parse', 'refs/heads/main'), baseline);
  assert.equal(
    (
      await promisify(execFile)('git', [
        '--git-dir',
        upstreamRepository,
        'for-each-ref',
        '--format=%(refname)',
      ])
    ).stdout.trim(),
    'refs/heads/main'
  );
  assert.equal(
    (
      await promisify(execFile)('git', [
        '--git-dir',
        upstreamRepository,
        'rev-parse',
        'refs/heads/main',
      ])
    ).stdout.trim(),
    baseline
  );
  assert.deepEqual(
    (await forkGit('for-each-ref', '--format=%(refname)')).split('\n').sort(),
    ['refs/heads/main', managementRef].sort()
  );
  await page.screenshot({ path: join(profile, 'management-document-pushed.png') });

  assert.equal(await git('rev-parse', 'HEAD'), baseline);

  await page
    .getByTestId('cross-project-main-agents')
    .getByRole('button', { name: 'Independent integration', exact: true })
    .click();
  await page
    .locator(`[data-testid="coordinator-panel"][data-task-id="${independent.taskId}"]`)
    .waitFor();
  await page.getByTestId('coordinator-tasks-tab').click();
  const startupCard = page.locator(
    `[data-testid="task-startup-status"][data-task-id="${failedTask.id}"]`
  );
  await startupCard.getByText(/Task startup failed/).waitFor();
  await startupCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(profile, 'failed-startup-after-takeover-restart.png') });
  await startupCard.getByTestId('retry-task-startup').click();
  await startupCard.waitFor({ state: 'hidden' });
  const recoveredSession = await waitForCapture(failedStatus.delegation.conversationId);
  await waitForPrompt('Continue the saved task after recovery.', recoveredSession.sessionId);
  const recoveredStatus = await page.evaluate(
    ({ id, taskId }) => window.coordinatorDelegationStatus(id, taskId),
    { id: independent.id, taskId: failedTask.id }
  );
  assert.equal(recoveredStatus.phase, 'started');
  assert.equal(recoveredStatus.canRetry, false);
  assert.equal(recoveredStatus.conversationId, failedStatus.delegation.conversationId);
  assert.equal(recoveredStatus.path, failedStatus.delegation.path);
  assert.equal(
    (
      await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: recoveredStatus.path })
    ).stdout.trim(),
    failedHead
  );
  const recoveredOwner = await page.evaluate(
    async (id) => (await window.allCoordinatorSnapshots()).find((record) => record.taskId === id),
    independent.taskId
  );
  assert.deepEqual(
    recoveredOwner.tasks[failedTask.id].documents,
    failedStatus.coordination.assignment.documents
  );
  await page.screenshot({ path: join(profile, 'task-startup-retried-after-restart.png') });

  let directoryStorage;
  for (const directory of [true, false]) {
    const root = join(profile, directory ? 'directory-project' : 'empty-repository');
    await mkdir(root);
    await writeFile(join(root, 'notes.txt'), 'Keep this project file.\n');
    if (!directory) await promisify(execFile)('git', ['init', '-b', 'main', root]);
    const special = await page.evaluate((input) => window.prepareCoordinator(input), {
      wrapper,
      mainWrapper,
      repository: root,
      worktreeRoot: join(profile, 'special-worktrees'),
      name: directory ? 'Directory coordination' : 'Empty repository coordination',
      directory,
    });
    await page
      .locator(`[data-testid="project-main-agent"][data-project-id="${special.projectId}"]`)
      .click();
    await page
      .locator(`[data-testid="coordinator-panel"][data-task-id="${special.taskId}"]`)
      .waitFor();
    await page.getByTestId('coordinator-tasks-tab').waitFor();
    assert.ok(!(await readdir(capture)).includes(special.conversationId + '.json'));
    await page.getByTestId('coordinator-documents-tab').click();
    if (directory) {
      await page.getByTestId('coordinator-documents-no-git').waitFor();
      await assert.rejects(readFile(join(root, '.git')), { code: 'ENOENT' });
    } else {
      const emptyDocuments = page.getByTestId('coordinator-documents-panel');
      await emptyDocuments.getByRole('textbox', { name: 'Document path' }).fill('empty-plan.md');
      await emptyDocuments.getByRole('button', { name: 'Create document', exact: true }).click();
      await emptyDocuments.getByText('empty-plan.md', { exact: true }).first().waitFor();
      const refs = (
        await promisify(execFile)('git', ['for-each-ref', '--format=%(refname)'], { cwd: root })
      ).stdout.trim();
      assert.equal(refs, `refs/heads/emdash/manage/${special.taskId}`);
    }
    await page.getByTestId('coordinator-conversation-tab').click();
    const prompt = directory ? 'Coordinate this directory.' : 'Coordinate an empty repository.';
    await page.locator('[contenteditable="true"]').first().fill(prompt);
    await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click();
    const specialCapture = await waitForCapture(special.conversationId);
    await waitForPrompt(prompt, specialCapture.sessionId);
    const specialClient = new Client({ name: 'special-project-acceptance', version: '1' });
    try {
      await specialClient.connect(
        new StreamableHTTPClientTransport(new URL(specialCapture.mcpUrl))
      );
      const denied = await specialClient.callTool({
        name: 'create_task',
        arguments: { name: 'No code baseline', project_id: special.projectId },
      });
      assert.equal(denied.isError, true, 'Code delegation used an unavailable baseline');
      assert.match(
        JSON.stringify(denied.content),
        directory ? /needs a Git repository/ : /code baseline/
      );
      if (directory) {
        const originalMain = (await page.evaluate(() => window.allCoordinatorSnapshots())).find(
          (record) => record.taskId === special.taskId
        );
        await page.getByTestId('coordinator-documents-tab').click();
        const setup = page.getByTestId('document-storage-setup');
        await setup.getByTestId('document-storage-project').click();
        await page.getByRole('option', { name: 'Delegation acceptance', exact: true }).click();
        await setup.getByTestId('configure-document-storage').click();
        const associatedDocuments = page.getByTestId('coordinator-documents-panel');
        await associatedDocuments.getByRole('textbox', { name: 'Document path' }).waitFor();
        const stored = (await page.evaluate(() => window.allCoordinatorSnapshots())).find(
          (record) => record.taskId === special.taskId
        );
        assert.equal(stored.documentStorage.projectId, coordinator.projectId);
        assert.equal(stored.documentStorage.state, 'ready');
        assert.notEqual(stored.documentStorage.taskId, stored.taskId);
        assert.equal(stored.documentStorage.params.taskConfig.initialConversation, undefined);
        assert.deepEqual(stored.params, originalMain.params);
        assert.equal(stored.conversationId, special.conversationId);
        const storageBlock = (await git('worktree', 'list', '--porcelain'))
          .split('\n\n')
          .find((block) =>
            block.includes(`branch refs/heads/emdash/manage/${stored.documentStorage.taskId}`)
          );
        assert.ok(storageBlock, 'The independent document worktree was not created');
        const storagePath = storageBlock.split('\n')[0].slice('worktree '.length);
        await associatedDocuments
          .getByRole('textbox', { name: 'Document path' })
          .fill('directory-plan.md');
        await associatedDocuments
          .getByRole('button', { name: 'Create document', exact: true })
          .click();
        await associatedDocuments.getByRole('button', { name: /^(Raw|原始)$/ }).click();
        await associatedDocuments.locator('.monaco-editor .view-lines').first().click();
        await page.keyboard.insertText('# Directory plan\n\nSaved in associated Git storage.\n');
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
        await waitForDocumentSave(
          join(storagePath, 'directory-plan.md'),
          'Saved in associated Git storage.'
        );
        const storedDocument = JSON.parse(
          await call(specialClient, 'read_management_document', { path: 'directory-plan.md' })
        );
        assert.ok(storedDocument.content.includes('Saved in associated Git storage.'));
        const updated = JSON.parse(
          await call(specialClient, 'write_management_document', {
            path: 'directory-plan.md',
            content: storedDocument.content + '\nUpdated by the main agent through MCP.\n',
            expected_revision: storedDocument.revision,
          })
        );
        assert.ok(updated.content.includes('Updated by the main agent through MCP.'));
        const staleWrite = await specialClient.callTool({
          name: 'write_management_document',
          arguments: {
            path: 'directory-plan.md',
            content: 'stale write',
            expected_revision: storedDocument.revision,
          },
        });
        assert.equal(staleWrite.isError, true);
        const foreignWrite = await specialClient.callTool({
          name: 'write_management_document',
          arguments: { coordinator_id: owner.id, path: 'plan.md', content: 'foreign write' },
        });
        assert.equal(foreignWrite.isError, true);
        await assert.rejects(readFile(join(root, 'directory-plan.md')), { code: 'ENOENT' });
        assert.equal(await git('rev-parse', 'HEAD'), baseline);
        await page.screenshot({ path: join(profile, 'directory-associated-document-storage.png') });
        await page.getByTestId('coordinator-conversation-tab').click();
        await call(specialClient, 'send_message', {
          conversation_id: special.conversationId,
          request_id: 'after-document-storage',
          text: 'Conversation stays in its directory after configuring document storage.',
        });
        await waitForPrompt(
          'Conversation stays in its directory after configuring document storage.',
          specialCapture.sessionId
        );
        directoryStorage = {
          ...special,
          storage: stored.documentStorage,
          content: updated.content,
          root,
        };
      }
    } finally {
      await specialClient.close();
    }
    assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'Keep this project file.\n');
    if (directory) await assert.rejects(readFile(join(root, '.git')), { code: 'ENOENT' });
    await page.screenshot({
      path: join(
        profile,
        directory ? 'directory-main-conversation.png' : 'empty-main-conversation.png'
      ),
    });
  }

  assert.ok(directoryStorage);
  const legacyRepository = join(profile, 'legacy-repository');
  await mkdir(legacyRepository);
  const legacyGit = async (...args) =>
    (await promisify(execFile)('git', args, { cwd: legacyRepository })).stdout.trim();
  await legacyGit('init', '-b', 'main');
  await legacyGit('config', 'user.name', 'Legacy acceptance');
  await legacyGit('config', 'user.email', 'legacy@example.invalid');
  await writeFile(join(legacyRepository, 'README.md'), 'Product documentation stays in code.\n');
  await legacyGit('add', 'README.md');
  await legacyGit('commit', '-m', 'Code baseline');
  const legacyBaseline = await legacyGit('rev-parse', 'HEAD');
  const legacy = await page.evaluate((input) => window.prepareLegacyCoordinatorFixture(input), {
    wrapper,
    repository: legacyRepository,
    worktreeRoot: join(profile, 'legacy-worktrees'),
  });
  await mkdir(join(legacy.path, 'plans'));
  const legacyPlan = '# Legacy plan\n\nMove this selected management document only.\n';
  await writeFile(join(legacy.path, 'plans', 'legacy-plan.md'), legacyPlan);
  const beforeStorageRestart = directoryStorage;
  const stoppedWithStorage = await quitApplication(app);
  assert.equal(stoppedWithStorage.exitCode, 0);
  app = undefined;
  // Seed an upgrade fixture only while its isolated application is fully stopped.
  const fixtureDb = new DatabaseSync(join(profile, 'scratch.db'));
  try {
    const key = `coordinators:${legacy.id}`;
    const row = fixtureDb.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    assert.ok(row);
    const record = JSON.parse(row.value);
    assert.equal(record.taskId, legacy.taskId);
    fixtureDb
      .prepare('UPDATE kv SET value = ?, updated_at = ? WHERE key = ?')
      .run(JSON.stringify({ ...record, version: '1', params: legacy.params }), Date.now(), key);
  } finally {
    fixtureDb.close();
  }
  app = await _electron.launch({
    executablePath: electronPath,
    args: [appRoot],
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: /^(Settings|设置)$/ }).waitFor();
  await page.addScriptTag({
    type: 'module',
    content: `import { allCoordinatorSnapshots, readCoordinatorDocument } from '/@fs${join(appRoot, 'tooling/acceptance/task-delegation-browser.ts')}'; Object.assign(window, { allCoordinatorSnapshots, readCoordinatorDocument });`,
  });
  await page.waitForFunction(() => typeof window.allCoordinatorSnapshots === 'function');
  const restoredDirectory = (await page.evaluate(() => window.allCoordinatorSnapshots())).find(
    (record) => record.taskId === beforeStorageRestart.taskId
  );
  assert.deepEqual(restoredDirectory.documentStorage, beforeStorageRestart.storage);
  assert.equal(restoredDirectory.conversationId, beforeStorageRestart.conversationId);
  const restoredStoredDocument = await page.evaluate(
    ({ taskId }) => window.readCoordinatorDocument(taskId, 'directory-plan.md'),
    beforeStorageRestart
  );
  assert.equal(restoredStoredDocument.content, beforeStorageRestart.content);
  const expandDirectory = page.getByRole('button', {
    name: /^(Expand|展开) Directory coordination$/,
  });
  if (await expandDirectory.isVisible()) await expandDirectory.click();
  await page
    .locator(
      `[data-testid="project-main-agent"][data-project-id="${beforeStorageRestart.projectId}"]`
    )
    .click();
  await page
    .locator(`[data-testid="coordinator-panel"][data-task-id="${beforeStorageRestart.taskId}"]`)
    .waitFor();
  await page.getByTestId('coordinator-documents-tab').click();
  const restoredStoragePanel = page.getByTestId('coordinator-documents-panel');
  await restoredStoragePanel.getByText('directory-plan.md', { exact: true }).last().dblclick();
  await restoredStoragePanel.getByRole('button', { name: /^(Raw|原始)$/ }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('.monaco-editor .view-lines')).some((element) =>
      element.textContent.replace(/\u00a0/g, ' ').includes('Updated by the main agent through MCP.')
    )
  );
  await page.screenshot({ path: join(profile, 'associated-document-storage-restarted.png') });
  await assert.rejects(readFile(join(beforeStorageRestart.root, '.git')), { code: 'ENOENT' });

  const expandLegacy = page.getByRole('button', {
    name: /^(Expand|展开) Legacy management fixture$/,
  });
  if (await expandLegacy.isVisible()) await expandLegacy.click();
  await page
    .locator(`[data-testid="project-main-agent"][data-project-id="${legacy.projectId}"]`)
    .click();
  await page
    .locator(`[data-testid="coordinator-panel"][data-task-id="${legacy.taskId}"]`)
    .waitFor();
  await page.getByTestId('coordinator-documents-tab').click();
  const migrationForm = page.getByTestId('document-migration-form');
  await migrationForm.getByTestId('migration-destination-project').click();
  await page.getByRole('option', { name: 'Delegation acceptance', exact: true }).click();
  await migrationForm.getByTestId('migration-document-paths').fill('plans/legacy-plan.md');
  await migrationForm.getByTestId('prepare-document-migration').click();
  await migrationForm.getByTestId('run-document-migration').waitFor();
  const plannedLegacy = (await page.evaluate(() => window.allCoordinatorSnapshots())).find(
    (record) => record.id === legacy.id
  );
  assert.equal(plannedLegacy.documentMigration.phase, 'prepared');
  assert.equal(plannedLegacy.documentStorage, undefined);
  assert.equal(plannedLegacy.documentMigration.files[0].content, legacyPlan);
  await page.screenshot({ path: join(profile, 'legacy-document-migration-prepared.png') });
  const stoppedWithPlan = await quitApplication(app);
  assert.equal(stoppedWithPlan.exitCode, 0);
  app = undefined;
  app = await _electron.launch({
    executablePath: electronPath,
    args: [appRoot],
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: /^(Settings|设置)$/ }).waitFor();
  await page.addScriptTag({
    type: 'module',
    content: `import { allCoordinatorSnapshots, readCoordinatorDocument } from '/@fs${join(appRoot, 'tooling/acceptance/task-delegation-browser.ts')}'; Object.assign(window, { allCoordinatorSnapshots, readCoordinatorDocument });`,
  });
  await page.waitForFunction(() => typeof window.allCoordinatorSnapshots === 'function');
  const resumedLegacy = (await page.evaluate(() => window.allCoordinatorSnapshots())).find(
    (record) => record.id === legacy.id
  );
  assert.deepEqual(resumedLegacy.documentMigration, plannedLegacy.documentMigration);
  const expandResumedLegacy = page.getByRole('button', {
    name: /^(Expand|展开) Legacy management fixture$/,
  });
  if (await expandResumedLegacy.isVisible()) await expandResumedLegacy.click();
  await page
    .locator(`[data-testid="project-main-agent"][data-project-id="${legacy.projectId}"]`)
    .click();
  await page
    .locator(`[data-testid="coordinator-panel"][data-task-id="${legacy.taskId}"]`)
    .waitFor();
  await page.getByTestId('coordinator-documents-tab').click();
  await page.getByTestId('run-document-migration').click();
  await page.getByTestId('document-migration-result').waitFor();
  const migratedPanel = page.getByTestId('coordinator-documents-panel');
  await migratedPanel.getByRole('button', { name: /^(Raw|原始)$/ }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('.monaco-editor .view-lines')).some((element) =>
      element.textContent
        .replace(/\u00a0/g, ' ')
        .includes('Move this selected management document only.')
    )
  );
  const migratedLegacy = (await page.evaluate(() => window.allCoordinatorSnapshots())).find(
    (record) => record.id === legacy.id
  );
  assert.equal(migratedLegacy.documentMigration.phase, 'complete');
  assert.equal(migratedLegacy.taskId, legacy.taskId);
  assert.equal(migratedLegacy.conversationId, legacy.conversationId);
  assert.deepEqual(migratedLegacy.params, legacy.params);
  assert.equal(
    migratedLegacy.documentStorage.taskId,
    plannedLegacy.documentMigration.target.taskId
  );
  assert.equal(migratedLegacy.documentStorageHistory[0].taskId, legacy.taskId);
  assert.equal(await readFile(join(legacy.path, 'plans', 'legacy-plan.md'), 'utf8'), legacyPlan);
  assert.equal(
    await readFile(join(legacy.path, 'README.md'), 'utf8'),
    'Product documentation stays in code.\n'
  );
  assert.equal(await legacyGit('rev-parse', 'HEAD'), legacyBaseline);
  const migratedBlock = (await git('worktree', 'list', '--porcelain'))
    .split('\n\n')
    .find((block) =>
      block.includes(`branch refs/heads/emdash/manage/${migratedLegacy.documentStorage.taskId}`)
    );
  assert.ok(migratedBlock);
  const migratedPath = migratedBlock.split('\n')[0].slice('worktree '.length);
  assert.equal(await readFile(join(migratedPath, 'plans', 'legacy-plan.md'), 'utf8'), legacyPlan);
  await assert.rejects(readFile(join(migratedPath, 'README.md')), { code: 'ENOENT' });
  assert.equal(await git('rev-parse', 'HEAD'), baseline);
  await page.screenshot({ path: join(profile, 'legacy-document-migration-complete.png') });
  await page.getByTestId('coordinator-conversation-tab').click();
  await page
    .locator('[contenteditable="true"]')
    .first()
    .fill('Continue the original legacy conversation after document migration.');
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click();
  const legacyCapture = await waitForCapture(legacy.conversationId);
  await waitForPrompt(
    'Continue the original legacy conversation after document migration.',
    legacyCapture.sessionId
  );
  const legacyMain = await waitForCapture('main-session');
  assert.equal(legacyMain.sessionId, legacyCapture.sessionId);
  assert.equal(
    await readFile(join(legacyMain.cwd, 'README.md'), 'utf8'),
    'Product documentation stays in code.\n'
  );
  const legacyClient = new Client({ name: 'migrated-legacy-main', version: '1' });
  try {
    await legacyClient.connect(new StreamableHTTPClientTransport(new URL(legacyCapture.mcpUrl)));
    const read = JSON.parse(
      await call(legacyClient, 'read_management_document', { path: 'plans/legacy-plan.md' })
    );
    assert.equal(read.content, legacyPlan);
    await page.addScriptTag({
      type: 'module',
      content: `import { archiveFixtureProject, deleteFixtureProject } from '/@fs${join(appRoot, 'tooling/acceptance/task-delegation-browser.ts')}'; Object.assign(window, { archiveFixtureProject, deleteFixtureProject });`,
    });
    await page.waitForFunction(() => typeof window.archiveFixtureProject === 'function');
    const deletion = await page.evaluate(async (projectId) => {
      try {
        await window.deleteFixtureProject(projectId);
        return { deleted: true };
      } catch (error) {
        return { deleted: false, message: String(error) };
      }
    }, coordinator.projectId);
    assert.equal(
      deletion.deleted,
      false,
      'Deleting document storage was allowed while other main agents use it'
    );
    assert.match(deletion.message, /management documents|pending migration/);
    await page.evaluate(
      (projectId) => window.archiveFixtureProject(projectId),
      coordinator.projectId
    );
    const unavailable = await legacyClient.callTool({
      name: 'read_management_document',
      arguments: { path: 'plans/legacy-plan.md' },
    });
    assert.equal(unavailable.isError, true);
    const archivedBinding = (await page.evaluate(() => window.allCoordinatorSnapshots())).find(
      (record) => record.id === legacy.id
    );
    assert.equal(archivedBinding.documentStorage.taskId, migratedLegacy.documentStorage.taskId);
    await page.getByTestId('coordinator-documents-tab').click();
    await page.getByTestId('document-migration-settings').locator('summary').first().click();
    const recoveryForm = page.getByTestId('document-migration-form');
    await recoveryForm.getByTestId('migration-destination-project').click();
    await page.getByRole('option', { name: 'Legacy management fixture', exact: true }).click();
    await recoveryForm.getByTestId('migration-document-paths').fill('plans/legacy-plan.md');
    await recoveryForm.getByTestId('prepare-document-migration').click();
    await recoveryForm.getByTestId('run-document-migration').click();
    await waitForSnapshot(
      async ({ coordinatorId, projectId }) => {
        const record = (await window.allCoordinatorSnapshots()).find(
          (entry) => entry.id === coordinatorId
        );
        if (record?.documentMigration?.error) throw new Error(record.documentMigration.error);
        return (
          record?.documentStorage?.projectId === projectId &&
          record.documentMigration?.phase === 'complete'
        );
      },
      { coordinatorId: legacy.id, projectId: legacy.projectId }
    );
    const recoveredRead = JSON.parse(
      await call(legacyClient, 'read_management_document', { path: 'plans/legacy-plan.md' })
    );
    assert.equal(recoveredRead.content, legacyPlan);
    assert.equal(await readFile(join(migratedPath, 'plans', 'legacy-plan.md'), 'utf8'), legacyPlan);
    assert.equal(await legacyGit('rev-parse', 'HEAD'), legacyBaseline);
    await page.screenshot({ path: join(profile, 'archived-document-storage-migrated.png') });
  } finally {
    await legacyClient.close();
  }

  await writeFile(
    join(profile, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        checks: [
          'real Electron startup and fixed main agent sidebar',
          'main agent ran in an independent management history without code files or baseline changes',
          'management document created, edited and saved in the existing Monaco editor without starting an agent',
          'main MCP read returned saved document text and rejected stale or invalid paths',
          'worker received selected frozen document in its CLI context and MCP while unselected documents stayed denied',
          'document context stayed frozen through a source edit, dependency waiting and duplicate delegation',
          'complete Electron exit and restart preserved main bindings, task states and frozen document snapshots',
          'management document reopened and edited through Monaco after the full restart',
          'document committed through the UI as a child of its management history and read by exact commit ID',
          'selected document commit preserved unrelated staged files and the code baseline',
          'document remote saved before restart without starting a model or publishing refs and restored afterward',
          'explicit document push published only its pinned management branch to a local personal-fork fixture',
          'fork code baseline and local annotated tags stayed outside the management push',
          'failed startup survived ownership transfer and full restart; former owner denied and current owner retried through the UI',
          'task startup retry preserved task, conversation, branch commit and frozen document inputs',
          'directory main opened and exchanged an ACP turn without initializing Git or allowing code delegation',
          'empty repository main created management documents without inventing a code baseline',
          'directory main explicitly selected another Git project for independent document storage without moving its active conversation',
          'associated storage reused Monaco saving and controlled MCP reads and writes; stale and foreign writes refused',
          'independent document storage binding and content survived another complete application restart and reopened in the editor',
          'legacy code worktree and version-1 coordinator fixture upgraded without changing original files, branch or conversation identity',
          'selected management document migration plan survived complete restart and copied only the reviewed file before switching storage',
          'migrated document reopened in Monaco while original main continued in its code worktree and read management content through MCP',
          'deleting an in-use document project was refused before data removal; archived storage stayed bound and explicitly migrated without losing its source files',
          'task worktree contained no copied management documents',
          'real ACP protocol with a simulated OpenCode executable',
          'authenticated main and worker MCP identities',
          'real worktree and worker CLI startup with high effort',
          'simulated code change committed and syntax checked in the worker branch',
          'opening a fresh main agent does not start its process',
          'idempotent delegation and result submission',
          'result delivered through ACP and explicitly acknowledged',
          'active user turn uninterrupted and queued UI follow-up executed before background result',
          'pending PTY message visible and manually handled through the task UI without injected input',
          'undelivered result for a terminal main handled in the same inbox while task stayed in review',
          'human-readable result notice kept internal coordination instructions in hidden context',
          'changes requested and versioned result accepted',
          'one main agent dispatched into two independent repositories',
          'cross-project task used the target develop baseline',
          'worker scope could not expand without an explicit project grant',
          'cross-project MCP task and conversation discovery plus idempotent ACP messaging',
          'project access narrowed and restored through the UI; denied requests created no branches',
          'both repositories returned results to one main agent',
          'renderer closed before cross-project task reads and a new ACP follow-up',
          'independent cross-project main created and opened through the sidebar',
          'task explicitly taken over through the UI without changing its branch or worker',
          'pending result moved to the new owner and old owner could not acknowledge or review it',
          'independent main requires an explicit code target project',
          'dependent task visible without worktree or process until prerequisite result review',
          'waiting task cancelled through the UI remains unstarted after prerequisite acceptance',
          'accepted cross-repository prerequisite automatically released the same task with frozen high effort',
          'approved prerequisite result version and commits persisted in the dependent task',
          'explicit worker grant allowed cross-repository delegation and capped child grants',
          'main conversation switched through the UI without losing task history',
          'unconfirmed result redirected and old main consumption authority revoked',
        ],
        relatedProjectId,
        dependentTaskId: dependentPlan.task_id,
        crossTaskId: cross.task_id,
        workerCommit,
        taskId: created.task_id,
        conversationId: created.conversation_id,
        path: created.path,
      },
      null,
      2
    )
  );
  console.log(`Cross-project coordination acceptance passed: ${profile}`);
} catch (error) {
  await writeFile(
    join(profile, 'failure-error.json'),
    JSON.stringify({ name: error.name, message: error.message, stack: error.stack }, null, 2)
  );
  await page?.screenshot({ path: join(profile, 'failure.png') }).catch(() => {});
  await writeFile(join(profile, 'failure.html'), (await page?.content().catch(() => '')) ?? '');
  console.error(`Acceptance evidence: ${profile}`);
  throw error;
} finally {
  await grantedWorkerClient?.close().catch(() => {});
  await independentClient?.close().catch(() => {});
  await crossWorkerClient?.close().catch(() => {});
  await replacementClient?.close().catch(() => {});
  await workerClient?.close().catch(() => {});
  await client?.close().catch(() => {});
  if (app) await quitApplication(app).catch(() => {});
  await renderer.close();
}
