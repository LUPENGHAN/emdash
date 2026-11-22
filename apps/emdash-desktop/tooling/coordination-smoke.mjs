import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import electronPath from 'electron';
import { resolveConfig } from 'electron-vite';
import { _electron } from 'playwright';
import { build, createServer } from 'vite';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(join(tmpdir(), 'emdash-coordination-'));
const repository = join(profile, 'repository');
const capture = join(profile, 'spawns');
await mkdir(repository);
await mkdir(capture);
const git = async (...args) =>
  (await promisify(execFile)('git', args, { cwd: repository })).stdout.trim();
await git('init', '-b', 'main');
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
const importRepository = join(profile, 'organization-repository');
await mkdir(importRepository);
const importGit = async (...args) =>
  (await promisify(execFile)('git', args, { cwd: importRepository })).stdout.trim();
await importGit('init', '-b', 'main');
await writeFile(join(importRepository, 'README.md'), 'Organization repository acceptance\n');
await importGit('add', 'README.md');
await importGit(
  '-c',
  'user.name=Emdash test',
  '-c',
  'user.email=test@example.invalid',
  'commit',
  '-m',
  'Initial organization baseline'
);
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
  mcpUrl: mcp ? JSON.parse(mcp.slice('--mcp-config='.length)).mcpServers?.emdash?.url : undefined,
}));
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
        reject(new Error('The simulated agent did not spawn.'));
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
    content: `import { prepareStandaloneCoordinator, seedMainAgentKnowledge, coordinatorSnapshot, createReplacementMain } from '/@fs${join(appRoot, 'tooling/acceptance/task-delegation-browser.ts')}';
      Object.assign(window, { prepareStandaloneCoordinator, seedMainAgentKnowledge, coordinatorSnapshot, createReplacementMain });`,
  });
  await page.waitForFunction(() => typeof window.prepareStandaloneCoordinator === 'function');
  const coordinator = await page.evaluate((input) => window.prepareStandaloneCoordinator(input), {
    wrapper,
    mainWrapper,
    repository,
    worktreeRoot: join(profile, 'worktrees'),
  });
  await page
    .getByTestId('main-agent-workspaces')
    .getByRole('button')
    .filter({ hasText: '独立验收主任务' })
    .first()
    .click();
  assert.equal(coordinator.projectId, '__emdash_main_agent_host__');
  assert.equal(await page.getByText('Emdash 主任务管理', { exact: true }).count(), 0);
  await page.evaluate(
    (projectId) => window.seedMainAgentKnowledge(projectId),
    coordinator.targetProjectId
  );
  await page.getByTestId('coordinator-tasks-tab').waitFor();
  assert.ok(
    !(await readdir(capture)).includes('main-session.json'),
    'Opening a fresh main agent started a process before its first message'
  );
  await page
    .locator('[contenteditable="true"]')
    .first()
    .fill('Delegate an isolated implementation task and inspect the result.');
  const send = page.getByRole('button', { name: /^(Send message|发送消息)$/ });
  await send.click();
  const main = await waitForCapture('main-session');
  assert.ok(main.mcpUrl, 'The main ACP session was not given its authenticated MCP URL');
  await waitForPrompt('Main Agent');
  client = new Client({ name: 'isolated-main-agent', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(main.mcpUrl)));
  const call = async (caller, name, args) => {
    const result = await caller.callTool({ name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result.content.find((item) => item.type === 'text').text;
  };
  const args = {
    name: 'Coordinated implementation',
    prompt: 'Simulated implementation',
    project_id: coordinator.targetProjectId,
    agent: 'claude',
    effort: 'high',
    connection: 'official',
    request_id: 'coordinated-request',
  };
  const workItem = JSON.parse(
    await call(client, 'add_work_item', {
      request_id: 'ffac8d81-c23c-478d-9a24-c624b409517b',
      title: '验证独立 Task 全流程',
      detail: '工作事项与 Project TODO、Task Result 分层保存',
    })
  );
  assert.equal(workItem.workItems['ffac8d81-c23c-478d-9a24-c624b409517b'].state, 'open');
  const checkpointArgs = {
    request_id: 'abf5f197-6bad-4bc0-babb-ae20467cdce6',
    title: '派活前检查点',
  };
  const checkpoint = JSON.parse(await call(client, 'create_checkpoint', checkpointArgs));
  const repeatedCheckpoint = JSON.parse(await call(client, 'create_checkpoint', checkpointArgs));
  assert.equal(checkpoint.checkpoints.length, 1);
  assert.equal(repeatedCheckpoint.checkpoints.length, 1);
  assert.equal(checkpoint.checkpoints[0].id, checkpointArgs.request_id);
  const paused = JSON.parse(await call(client, 'set_main_agent_state', { action: 'pause' }));
  assert.equal(paused.lifecycle.state, 'paused');
  const resumed = JSON.parse(await call(client, 'set_main_agent_state', { action: 'resume' }));
  assert.equal(resumed.lifecycle.state, 'active');
  const created = JSON.parse(await call(client, 'create_task', args));
  const duplicate = JSON.parse(await call(client, 'create_task', args));
  assert.equal(created.task_id, duplicate.task_id);
  const mainContext = JSON.parse(await call(client, 'get_main_agent_context', {}));
  assert.equal(mainContext.projects[0].id, coordinator.targetProjectId);
  assert.equal(mainContext.projects[0].requirements[0].title, '验证项目 TODO 聚合');
  assert.equal(mainContext.projects[0].decisions[0].title, '验证项目决策聚合');
  assert.equal(mainContext.globalMemory[0].title, '验证全局记忆聚合');
  const importArgs = {
    request_id: 'ea9fcf9d-c865-4492-bdb0-6a4bc6f2162a',
    repository_url: importRepository,
    name: '组织协作仓库',
  };
  const importedProject = JSON.parse(await call(client, 'import_project', importArgs));
  const repeatedImport = JSON.parse(await call(client, 'import_project', importArgs));
  assert.equal(importedProject.id, importArgs.request_id);
  assert.equal(repeatedImport.id, importedProject.id);
  await page.getByText('组织协作仓库', { exact: true }).waitFor();
  const importedContext = JSON.parse(await call(client, 'get_main_agent_context', {}));
  assert.ok(importedContext.projects.some((project) => project.id === importedProject.id));
  const spawned = await waitForCapture(created.conversation_id);
  assert.equal(spawned.effort, 'high');
  assert.equal(spawned.cliEffort, 'high');
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
  const receipt = JSON.parse(await call(workerClient, 'submit_task_result', submission));
  const repeated = JSON.parse(await call(workerClient, 'submit_task_result', submission));
  assert.deepEqual(repeated, receipt);
  await page.getByTestId('coordinator-tasks-tab').click();
  await page.getByText('验证独立 Task 全流程', { exact: true }).waitFor();
  await page.getByText('派活前检查点', { exact: true }).waitFor();
  await page.getByText('验证项目 TODO 聚合', { exact: true }).waitFor();
  await page.getByText('最新决策：验证项目决策聚合', { exact: true }).waitFor();
  await page.getByText('最新记录：验证全局记忆聚合', { exact: true }).waitFor();
  await page.getByText('Simulated task result', { exact: true }).waitFor();
  await page.getByTestId('coordinator-accept-result').waitFor();
  await page.waitForFunction(async (id) => {
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
  const reworkedReceipt = JSON.parse(
    await call(workerClient, 'submit_task_result', {
      ...submission,
      request_id: 'result-1-reworked',
      result: { ...submission.result, summary: 'Reworked simulated task result' },
    })
  );
  await waitForPrompt(reworkedReceipt.eventId);
  await call(client, 'acknowledge_task_results', { event_ids: [reworkedReceipt.eventId] });
  await call(client, 'review_task_result', {
    task_id: created.task_id,
    result_version: 2,
    accepted: true,
    note: 'Inspected simulated evidence',
  });
  const final = await page.evaluate((id) => window.coordinatorSnapshot(id), coordinator.taskId);
  assert.equal(final.tasks[created.task_id].state, 'done');
  assert.equal(final.events[0].state, 'acknowledged');
  assert.equal(final.events.length, 2);
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
  await page.waitForFunction(
    async ({ taskId, conversationId }) =>
      (await window.coordinatorSnapshot(taskId)).conversationId === conversationId,
    { taskId: coordinator.taskId, conversationId: replacement.id }
  );
  const replacementCapture = await waitForCapture(replacement.id);
  await waitForPrompt(secondReceipt.eventId, replacementCapture.sessionId);
  assert.notEqual(replacementCapture.mcpUrl, main.mcpUrl);
  await call(client, 'acknowledge_task_results', { event_ids: [secondReceipt.eventId] });
  replacementClient = new Client({ name: 'replacement-main-agent', version: '1' });
  await replacementClient.connect(
    new StreamableHTTPClientTransport(new URL(replacementCapture.mcpUrl))
  );
  await call(replacementClient, 'acknowledge_task_results', { event_ids: [secondReceipt.eventId] });
  await call(replacementClient, 'review_task_result', {
    task_id: created.task_id,
    result_version: 3,
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
  await writeFile(
    join(profile, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        checks: [
          'real Electron startup and fixed main agent sidebar',
          'real ACP protocol with a simulated OpenCode executable',
          'authenticated main and worker MCP identities',
          'real worktree and worker CLI startup with high effort',
          'simulated code change committed and syntax checked in the worker branch',
          'opening a fresh main agent does not start its process',
          'idempotent delegation and result submission',
          'workspace work item persisted independently from code tasks',
          'linked project requirements, decisions and global memory aggregated in UI and MCP context',
          'idempotent repository clone, Emdash project registration and main-workspace linking',
          'idempotent checkpoint creation and ongoing workspace pause/resume lifecycle',
          'result delivered through ACP and explicitly acknowledged',
          'changes requested and versioned result accepted',
          'main conversation switched through the UI without losing task history',
          'unconfirmed result redirected while every main-task conversation retained coordination authority',
        ],
        workerCommit,
        taskId: created.task_id,
        conversationId: created.conversation_id,
        path: created.path,
      },
      null,
      2
    )
  );
  console.log(`Coordination acceptance passed: ${profile}`);
} catch (error) {
  await page?.screenshot({ path: join(profile, 'failure.png') }).catch(() => {});
  await writeFile(join(profile, 'failure.html'), (await page?.content().catch(() => '')) ?? '');
  console.error(`Acceptance evidence: ${profile}`);
  throw error;
} finally {
  await replacementClient?.close().catch(() => {});
  await workerClient?.close().catch(() => {});
  await client?.close().catch(() => {});
  if (app) {
    const child = app.process();
    const exited =
      child.exitCode === null && child.signalCode === null
        ? once(child, 'exit')
        : Promise.resolve();
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }
  await renderer.close();
}
