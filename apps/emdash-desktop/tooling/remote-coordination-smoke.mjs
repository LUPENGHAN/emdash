import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(join(tmpdir(), 'emdash-remote-delegation-'));
const repository = join(profile, 'repo');
const capture = join(profile, 'captures');
await mkdir(repository);
await mkdir(capture);
const execute = promisify(execFile);
const git = async (...args) => (await execute('git', args, { cwd: repository })).stdout.trim();
await git('init', '-b', 'main');
await git('config', 'user.name', 'Coordination acceptance');
await git('config', 'user.email', 'test@example.invalid');
await writeFile(join(repository, 'README.md'), 'Isolated coordination concurrency acceptance\n');
await git('add', '.');
await git('commit', '-m', 'Baseline');
const wrapper = join(profile, 'worker.mjs');
await writeFile(
  wrapper,
  `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) { console.log('2.1.326 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({loggedIn:false})); process.exit(0); }
const mcp = args.find(arg => arg.startsWith('--mcp-config='));
const id = args[args.indexOf('--session-id') + 1];
const record = {mcpUrl: JSON.parse(mcp.slice('--mcp-config='.length)).mcpServers.emdash.url};
fs.writeFileSync(path.join(${JSON.stringify(capture)}, id + '.json'), JSON.stringify(record));
fs.appendFileSync(path.join(${JSON.stringify(capture)}, 'worker-starts.jsonl'), JSON.stringify({id,cwd:process.cwd()}) + '\\n');
process.stdin.resume();
setInterval(() => {}, 1000);
`,
  { mode: 0o755 }
);
const mainWrapper = join(profile, 'main.mjs');
await writeFile(
  mainWrapper,
  `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import readline from 'node:readline';
const capture = ${JSON.stringify(capture)};
if (process.argv.includes('--version')) { console.log('2.2.6'); process.exit(0); }
if (!process.argv.includes('acp')) { console.log('{}'); process.exit(0); }
const failure = path.join(capture, 'fail-next-start');
const failed = fs.existsSync(failure);
fs.appendFileSync(path.join(capture, 'acp-starts.jsonl'), JSON.stringify({cwd:process.cwd(),failed}) + '\\n');
if (failed) { fs.unlinkSync(failure); process.exit(41); }
readline.createInterface({input:process.stdin}).on('line', line => {
 let request; try { request=JSON.parse(line); } catch { return; }
 if (request.id === undefined) return;
 let result={};
 if (request.method==='initialize') result={protocolVersion:1,agentInfo:{name:'isolated-coordination',version:'1'},agentCapabilities:{loadSession:true,mcpCapabilities:{http:true}},authMethods:[]};
 else if (request.method==='session/new' || request.method==='session/load') {
  const sessionId=request.params.sessionId || 'ses_' + randomUUID();
  const mcp=request.params.mcpServers.find(server=>server.name==='emdash');
  const id=new URL(mcp.url).pathname.split('/')[2];
  fs.writeFileSync(path.join(capture,id + '.json'),JSON.stringify({sessionId,mcpUrl:mcp.url}));
  result=request.method==='session/new' ? {sessionId,configOptions:[]} : {configOptions:[]};
 } else if(request.method==='session/prompt') {
  fs.appendFileSync(path.join(capture,'prompts.jsonl'),JSON.stringify({sessionId:request.params.sessionId,prompt:request.params.prompt})+'\\n');
  result={stopReason:'end_turn'};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});
`,
  { mode: 0o755 }
);

const remoteFixture = JSON.parse(
  await readFile('/tmp/emdash-coordination-remote-fixture.json', 'utf8')
);
const mirror = JSON.parse(await readFile('/tmp/emdash-coordination-artifact-mirror.json', 'utf8'));
assert.equal(remoteFixture.fixtureOnly, true);
assert.equal(mirror.fixtureOnly, true);
assert.match(remoteFixture.container, /^emdash-coordination-acceptance-/);
const remoteRoot = '/home/devuser/emdash-delegation-' + randomUUID();
const remoteRepository = remoteRoot + '/repository';
const remoteWorktrees = remoteRoot + '/worktrees';
const remoteCaptureRoot = remoteRoot + '/captures';
const remoteWrapper = remoteRoot + '/worker.mjs';
const remoteNode = '/home/devuser/.emdash/workspace-server/current/node';
const remote = async (command, args) =>
  (
    await execute('docker', [
      'exec',
      '--user',
      'devuser',
      remoteFixture.container,
      command,
      ...args,
    ])
  ).stdout.trim();
const remoteWrite = (file, content) =>
  remote(remoteNode, [
    '-e',
    'require("node:fs").writeFileSync(process.argv[1], process.argv[2]);',
    file,
    content,
  ]);
await remote('mkdir', ['-p', remoteRepository, remoteCaptureRoot]);
await remote('git', ['-C', remoteRepository, 'init', '-b', 'main']);
await remote('git', ['-C', remoteRepository, 'config', 'user.name', 'Remote acceptance']);
await remote('git', ['-C', remoteRepository, 'config', 'user.email', 'test@example.invalid']);
await remoteWrite(remoteRepository + '/README.md', 'Real remote delegation baseline\n');
await remote('git', ['-C', remoteRepository, 'add', '.']);
await remote('git', ['-C', remoteRepository, 'commit', '-m', 'Remote baseline']);
const remoteBaseline = await remote('git', ['-C', remoteRepository, 'rev-parse', 'HEAD']);
await remoteWrite(
  remoteWrapper,
  `#!${remoteNode}
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if(args.includes('--version') || args.includes('-v')) {console.log('2.1.326 (Claude Code)');process.exit(0);}
if(args[0] === 'auth') {console.log(JSON.stringify({loggedIn:false}));process.exit(0);}
const id = args[args.indexOf('--session-id') + 1];
const record={id,pid:process.pid,cwd:process.cwd(),args,effort:process.env.CLAUDE_CODE_EFFORT_LEVEL,
 mcpProvided:args.some(arg=>arg.startsWith('--mcp-config=')),gatewayEnv:Boolean(process.env.ANTHROPIC_BASE_URL)};
fs.writeFileSync(path.join(${JSON.stringify(remoteCaptureRoot)},id+'.json'),JSON.stringify(record));
fs.appendFileSync(path.join(${JSON.stringify(remoteCaptureRoot)},'starts.jsonl'),JSON.stringify({id,pid:process.pid,cwd:process.cwd()})+String.fromCharCode(10));
console.log('Isolated remote task is running');
process.stdin.resume();setInterval(()=>{},1000);
`
);
await remote('chmod', ['755', remoteWrapper]);
const readRemoteCapture = async (id) =>
  JSON.parse(
    await remote(remoteNode, [
      '-e',
      'const fs=require("node:fs");const p=process.argv[1];console.log(fs.existsSync(p)?fs.readFileSync(p,"utf8"):"null");',
      remoteCaptureRoot + '/' + id + '.json',
    ])
  );
const remoteStarts = async () =>
  JSON.parse(
    await remote(remoteNode, [
      '-e',
      'const fs=require("node:fs");const p=process.argv[1];console.log(JSON.stringify(fs.existsSync(p)?fs.readFileSync(p,"utf8").trim().split(String.fromCharCode(10)).filter(Boolean).map(x=>JSON.parse(x)):[]));',
      remoteCaptureRoot + '/starts.jsonl',
    ])
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
env.EMDASH_WORKSPACE_SERVER_ARTIFACTS_URL = mirror.installBaseUrlRemote;
const clients = [];
const checks = [];
let app;
let page;
let onboarded = false;
const wait = async (read, message) => {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(message);
};
const readCapture = async (id) => {
  try {
    return JSON.parse(await readFile(join(capture, id + '.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
};
const captureLines = async (name) => {
  try {
    return (await readFile(join(capture, name), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
};
const connect = async (id) => {
  const record = await wait(() => readCapture(id), 'Missing authenticated MCP identity');
  const client = new Client({ name: 'multiwindow-acceptance', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(record.mcpUrl)));
  clients.push(client);
  return client;
};
const call = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  const value = result.content.find((part) => part.type === 'text').text;
  return value.startsWith('{') || value.startsWith('[') ? JSON.parse(value) : value;
};
async function attach(target) {
  target.setDefaultTimeout(30000);
  await target.waitForLoadState('domcontentloaded');
  await target.addScriptTag({
    type: 'module',
    content: `
 import {prepareCoordinator} from '/@fs${join(appRoot, 'tooling/acceptance/task-delegation-browser.ts')}';
 import {getCoordinationClient} from '/@fs${join(appRoot, 'src/core/features/coordination/api/browser/client.ts')}';
 import {getHostClient} from '/@fs${join(appRoot, 'src/core/primitives/desktop-host/browser/host-client.ts')}';
 import {getProjectManagerStore} from '/@fs${join(appRoot, 'src/core/features/projects/api/browser/stores/project-selectors.ts')}';
 import {getNavigation} from '/@fs${join(appRoot, 'src/core/primitives/navigation/browser/navigation-selectors.ts')}';
 import {taskViewDef} from '/@fs${join(appRoot, 'src/core/features/tasks/contributions/views.ts')}';
 import {prepareRemoteDelegationProject,setRemoteDelegationConnection,prepareUnsupportedRemoteGateway,isolateRemoteDelegationSkills} from '/@fs${join(appRoot, 'tooling/acceptance/remote-delegation-browser.ts')}';
 const client=await getCoordinationClient();
 window.fixture={prepareCoordinator,client,prepareRemoteDelegationProject,setRemoteDelegationConnection,prepareUnsupportedRemoteGateway,isolateRemoteDelegationSkills,
 async open(id){const record=await client.open({id});await getProjectManagerStore().hydrateProjectContext(record.projectId);getNavigation().navigate(taskViewDef({projectId:record.projectId,taskId:record.taskId}));return record;},
 async popout(id){const record=await client.open({id});return (await getHostClient()).openPopoutWindow({projectId:record.projectId,taskId:record.taskId,title:record.name,layout:null});}};
 `,
  });
  await target.waitForFunction(() => !!window.fixture);
}
async function launch() {
  app = await _electron.launch({
    executablePath: electronPath,
    args: [appRoot],
    env,
    timeout: 30000,
  });
  page = await wait(
    async () =>
      app.windows().find((candidate) => {
        const url = candidate.url();
        return (
          url.startsWith(env.ELECTRON_RENDERER_URL) && !new URL(url).searchParams.has('popout')
        );
      }),
    'The primary application window did not load'
  );
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
  await attach(page);
}
async function quit() {
  const child = app.process();
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    const confirmation = (async () => {
      const button = page.getByTestId('confirm-action-submit');
      await button.waitFor({ timeout: 5000 });
      await button.click();
    })();
    await Promise.race([exited, confirmation]).catch(() => {});
    await exited;
    assert.equal(child.exitCode, 0);
  } finally {
    clearTimeout(timer);
    app = undefined;
  }
}

const delegation = (owner, taskId) =>
  page.evaluate(
    (input) => window.fixture.client.delegationStatus({ id: input.owner, taskId: input.taskId }),
    { owner, taskId }
  );
const snapshot = (taskId) =>
  page.evaluate((id) => window.fixture.client.getByTask({ taskId: id }), taskId);
async function openMain(record) {
  await page.evaluate((id) => window.fixture.open(id), record.id);
  await page.getByTestId('coordinator-conversation-tab').click();
  await page
    .locator(`[data-acp-conversation-id="${record.conversationId}"]`)
    .locator('[contenteditable="true"]')
    .fill('Coordinate the isolated remote task.');
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click();
}
try {
  await launch();
  if (process.env.EMDASH_REMOTE_ACCEPTANCE_PERSONAL_SKILLS !== '1') {
    await page.evaluate(() => window.fixture.isolateRemoteDelegationSkills());
  }
  const owner = await page.evaluate((input) => window.fixture.prepareCoordinator(input), {
    wrapper,
    mainWrapper,
    repository,
    worktreeRoot: join(profile, 'local-worktrees'),
  });
  const target = await page.evaluate(
    (input) => window.fixture.prepareRemoteDelegationProject(input),
    {
      port: mirror.port,
      repository: remoteRepository,
      wrapper: remoteWrapper,
      worktreeRoot: remoteWorktrees,
    }
  );
  assert.equal((await remoteStarts()).length, 0);
  checks.push('Adding a real SSH project creates its main entry without starting an Agent');
  await openMain(owner);
  let main = await connect(owner.conversationId);
  const document = await page.evaluate(
    (id) =>
      window.fixture.client.writeDocument({
        id,
        path: 'plan.md',
        content: 'REMOTE_FROZEN_INPUT_v1\n',
      }),
    owner.id
  );
  const task = await call(main, 'create_task', {
    project_id: target.projectId,
    request_id: 'remote-task',
    name: 'Remote document consumer',
    agent: 'claude',
    ui: 'terminal',
    connection: 'official',
    effort: 'high',
    prompt: 'Inspect the frozen plan and change remote-proof.txt in this task branch.',
    document_refs: [{ path: 'plan.md', revision: document.revision }],
  });
  const captured = await wait(
    () => readRemoteCapture(task.conversation_id),
    'Remote Agent did not start'
  );
  assert.ok(captured.cwd.startsWith(remoteWorktrees + '/'));
  assert.equal(captured.cwd, task.path);
  assert.equal(captured.effort, 'high');
  assert.equal(captured.args[captured.args.indexOf('--effort') + 1], 'high');
  assert.ok(captured.args.join(' ').includes('REMOTE_FROZEN_INPUT_v1'));
  assert.ok(!captured.args.join(' ').includes(repository));
  assert.equal(captured.mcpProvided, false);
  assert.equal(captured.gatewayEnv, false);
  assert.equal(await remote('git', ['-C', captured.cwd, 'rev-parse', 'HEAD']), remoteBaseline);
  const before = await delegation(owner.id, task.task_id);
  assert.equal(before.phase, 'started');
  assert.equal(before.selectionSnapshot.values.effort, 'high');
  checks.push(
    'Authenticated local main delegated into the actual remote worktree with frozen document contents and high effort'
  );
  checks.push(
    'Remote Agent received no desktop-only document path, loopback MCP URL or gateway environment'
  );
  await page.evaluate((input) => window.fixture.client.writeDocument(input), {
    id: owner.id,
    path: 'plan.md',
    content: 'REMOTE_CHANGED_INPUT_v2\n',
    expectedRevision: document.revision,
  });
  assert.equal(
    (await snapshot(owner.taskId)).tasks[task.task_id].documents[0].content,
    document.content
  );
  await page.evaluate(
    (id) => window.fixture.setRemoteDelegationConnection(id, false),
    target.connectionId
  );
  await remote('kill', ['-0', String(captured.pid)]);
  await page.evaluate(
    (id) => window.fixture.setRemoteDelegationConnection(id, true),
    target.connectionId
  );
  const connected = await delegation(owner.id, task.task_id);
  assert.equal(connected.path, before.path);
  assert.deepEqual(connected.selectionSnapshot, before.selectionSnapshot);
  assert.equal((await remoteStarts()).filter((row) => row.id === task.conversation_id).length, 1);
  checks.push(
    'Explicit SSH disconnect and reconnect retained the running Agent, worktree and selection'
  );
  await page.evaluate(() => window.fixture.prepareUnsupportedRemoteGateway());
  const rejected = await main.callTool({
    name: 'create_task',
    arguments: {
      project_id: target.projectId,
      request_id: 'remote-gateway',
      name: 'Rejected remote gateway',
      agent: 'claude',
      ui: 'terminal',
      connection: 'gateway',
      effort: 'high',
      supplier_id: 'remote-rejected-supplier',
      model: 'remote-model',
      prompt: 'This must not run locally or fall back.',
    },
  });
  assert.equal(rejected.isError, true);
  const rejectedOwner = await snapshot(owner.taskId);
  const failedTask = Object.values(rejectedOwner.tasks).find(
    (row) => row.name === 'Rejected remote gateway'
  );
  assert.ok(failedTask);
  const failed = await delegation(owner.id, failedTask.taskId);
  assert.equal(failed.canRetry, true);
  assert.match(failed.error, /local|remote|loopback/i);
  assert.equal((await remoteStarts()).length, 1);
  checks.push(
    'Unsupported remote gateway leaves a retryable receipt without a local run or authentication fallback'
  );
  await page.getByTestId('coordinator-tasks-tab').click();
  await page.screenshot({ path: join(profile, 'remote-tasks.png') });
  for (const client of clients.splice(0)) await client.close();
  await unlink(join(capture, owner.conversationId + '.json'));
  await quit();
  await launch();
  await openMain(owner);
  main = await connect(owner.conversationId);
  const restored = await delegation(owner.id, task.task_id);
  assert.equal(restored.path, before.path);
  assert.deepEqual(restored.selectionSnapshot, before.selectionSnapshot);
  assert.deepEqual((await snapshot(owner.taskId)).tasks[task.task_id].documents[0], document);
  assert.equal((await delegation(owner.id, failedTask.taskId)).canRetry, true);
  await remote('kill', ['-0', String(captured.pid)]);
  assert.equal((await remoteStarts()).filter((row) => row.id === task.conversation_id).length, 1);
  checks.push(
    'Full Electron restart restored remote ownership, frozen document and failed-route receipt without starting another Agent'
  );
  await remoteWrite(captured.cwd + '/remote-proof.txt', 'Actual remote worker branch result\n');
  await remote('git', ['-C', captured.cwd, 'add', 'remote-proof.txt']);
  await remote('git', ['-C', captured.cwd, 'commit', '-m', 'Remote task change']);
  const commit = await remote('git', ['-C', captured.cwd, 'rev-parse', 'HEAD']);
  const result = await call(main, 'submit_task_result', {
    task_id: task.task_id,
    request_id: 'remote-result',
    result: {
      summary: 'Inspected actual remote commit and task input',
      commits: [commit],
      checks: [
        {
          command: 'git show HEAD:remote-proof.txt',
          passed: true,
          output: await remote('git', ['-C', captured.cwd, 'show', 'HEAD:remote-proof.txt']),
        },
      ],
      unresolved: [],
      prUrls: [],
    },
  });
  await wait(
    async () =>
      (await captureLines('prompts.jsonl')).some((entry) =>
        JSON.stringify(entry.prompt).includes(result.eventId)
      ),
    'The remote result was not delivered to the local main'
  );
  await call(main, 'acknowledge_task_results', { event_ids: [result.eventId] });
  await call(main, 'review_task_result', {
    task_id: task.task_id,
    result_version: 1,
    accepted: true,
    note: 'Checked actual remote code, document context and reconnect evidence',
  });
  assert.equal((await snapshot(owner.taskId)).tasks[task.task_id].state, 'done');
  assert.equal(await remote('git', ['-C', remoteRepository, 'rev-parse', 'main']), remoteBaseline);
  assert.equal(await remote('git', ['-C', captured.cwd, 'ls-files', 'plan.md']), '');
  checks.push(
    'The responsible main recorded and reviewed the actual remote commit; code baseline and management document isolation stayed intact'
  );
  await page.getByTestId('coordinator-tasks-tab').click();
  await page.screenshot({ path: join(profile, 'remote-result-reviewed.png') });
  await writeFile(
    join(profile, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        checks,
        hostVersion: mirror.version,
        remoteBaseline,
        commit,
        selection: before.selectionSnapshot,
        remoteStarts: await remoteStarts(),
        taskId: task.task_id,
        projectId: target.projectId,
      },
      null,
      2
    )
  );
  await quit();
  process.stdout.write(`Remote coordination acceptance passed: ${profile}\n`);
} catch (error) {
  await writeFile(
    join(profile, 'failure-error.json'),
    JSON.stringify({ message: error.message, stack: error.stack }, null, 2)
  );
  if (page && !page.isClosed())
    await page.screenshot({ path: join(profile, 'failure.png') }).catch(() => {});
  process.stderr.write(`Remote coordination acceptance failed; evidence: ${profile}\n`);
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
} finally {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  if (app) await quit().catch(() => app?.close());
  await renderer.close();
  await remote(remoteNode, [
    '-e',
    `
    const fs=require('node:fs'); const file=process.argv[1]; const wrapper=process.argv[2];
    if(fs.existsSync(file)) for(const line of fs.readFileSync(file,'utf8').trim().split(String.fromCharCode(10)).filter(Boolean)) {
      const row=JSON.parse(line);try { if(fs.readFileSync('/proc/'+row.pid+'/cmdline','utf8').includes(wrapper)) process.kill(row.pid,'SIGTERM'); } catch {}
    }`,
    remoteCaptureRoot + '/starts.jsonl',
    remoteWrapper,
  ]).catch(() => {});
}
