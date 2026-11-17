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
const profile = await mkdtemp(join(tmpdir(), 'emdash-multiwindow-coordination-'));
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
const baseline = await git('rev-parse', 'HEAD');
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
 const client=await getCoordinationClient();
 window.fixture={prepareCoordinator,client,
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
async function popout(record) {
  const opened = app.waitForEvent('window');
  const result = await page.evaluate((id) => window.fixture.popout(id), record.id);
  const target = await opened;
  await attach(target);
  await target.getByTestId('coordinator-panel').waitFor();
  assert.ok(target.url().includes('popout=' + result.id));
  return target;
}
const snapshot = (target, id) =>
  target.evaluate((id) => window.fixture.client.getByTask({ taskId: id }), id);
const status = (target, owner, task) =>
  target.evaluate(
    (input) => window.fixture.client.delegationStatus({ id: input.owner, taskId: input.task }),
    { owner, task }
  );
async function inspect(target, task) {
  await target.getByTestId('coordinator-tasks-tab').click();
  await target.getByTestId('takeover-task-id').fill(task);
  await target.getByTestId('inspect-task-takeover').click();
  await target.getByTestId('confirm-task-takeover').waitFor();
}
async function openMain(record) {
  await page.evaluate((id) => window.fixture.open(id), record.id);
  await page.getByTestId('coordinator-conversation-tab').click();
  await page
    .locator('[contenteditable="true"]')
    .first()
    .fill('Coordinate isolated concurrency checks.');
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click();
}
try {
  await launch();
  const owner = await page.evaluate((input) => window.fixture.prepareCoordinator(input), {
    wrapper,
    mainWrapper,
    repository,
    worktreeRoot: join(profile, 'worktrees'),
  });
  await openMain(owner);
  const main = await connect(owner.conversationId);
  const document = await page.evaluate(
    (id) =>
      window.fixture.client.writeDocument({
        id,
        path: 'plan.md',
        content: 'Frozen coordination input\n',
      }),
    owner.id
  );
  const a = await call(main, 'create_task', {
    name: 'Prerequisite',
    request_id: 'prerequisite',
    ui: 'terminal',
    agent: 'claude',
    connection: 'official',
    effort: null,
    prompt: 'Prepare an independently reviewed result',
  });
  const dependent = await call(main, 'create_task', {
    name: 'Waiting takeover',
    request_id: 'waiting-takeover',
    ui: 'terminal',
    agent: 'claude',
    connection: 'official',
    effort: null,
    prompt: 'Consume the accepted result',
    depends_on: [a.task_id],
    document_refs: [{ path: 'plan.md' }],
  });
  assert.equal(dependent.status, 'blocked');
  const before = await status(page, owner.id, dependent.task_id);
  const destinations = [];
  for (const name of ['Destination A', 'Destination B'])
    destinations.push(
      await page.evaluate((input) => window.fixture.client.createCrossProject(input), {
        id: randomUUID(),
        name,
        projectId: owner.projectId,
        projectIds: [owner.projectId],
        primary: { agent: 'opencode', connection: 'official', effort: null },
      })
    );
  const left = await popout(destinations[0]);
  const right = await popout(destinations[1]);
  const leftPopoutUrl = left.url();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 3);
  await Promise.all([inspect(left, dependent.task_id), inspect(right, dependent.task_id)]);
  await left.getByTestId('confirm-task-takeover').click();
  await wait(
    async () => (await left.getByTestId('takeover-task-id').inputValue()) === '',
    'The first takeover did not finish'
  );
  await wait(
    async () => !(await right.getByTestId('confirm-task-takeover').isDisabled()),
    'The stale takeover action is unavailable'
  );
  await right.getByTestId('confirm-task-takeover').click();
  await right.getByText(/The task owner changed/).waitFor();
  await right.getByText('Managed by: Destination A', { exact: true }).waitFor();
  const after = await snapshot(left, destinations[0].taskId);
  assert.equal(after.tasks[dependent.task_id].taskCreated, false);
  assert.equal(after.tasks[dependent.task_id].ownershipHistory.length, 1);
  assert.equal((await snapshot(right, destinations[1].taskId)).tasks[dependent.task_id], undefined);
  assert.equal((await snapshot(page, owner.taskId)).tasks[dependent.task_id], undefined);
  assert.deepEqual(
    (await status(left, destinations[0].id, dependent.task_id)).selectionSnapshot,
    before.selectionSnapshot
  );
  assert.equal(await readCapture(dependent.conversation_id), null);
  await right.screenshot({ path: join(profile, 'takeover-conflict.png') });
  checks.push(
    'two native popout windows retain one owner for a waiting task; stale takeover is rejected and its preview refreshes'
  );
  const worker = await connect(a.conversation_id);
  await call(worker, 'submit_task_result', {
    task_id: a.task_id,
    request_id: 'result-one',
    result: {
      summary: 'Concurrency result',
      commits: [baseline],
      checks: [],
      unresolved: [],
      prUrls: [],
    },
  });
  await page.getByTestId('coordinator-tasks-tab').click();
  await page.getByText('Concurrency result', { exact: true }).waitFor();
  await left.evaluate((id) => window.fixture.open(id), owner.id);
  await left.getByTestId('coordinator-tasks-tab').click();
  await left.getByText('Concurrency result', { exact: true }).waitFor();
  const decisions = await Promise.all([
    page.evaluate(
      async (input) => {
        try {
          await window.fixture.client.review(input);
          return { accepted: true };
        } catch (error) {
          return { error: String(error) };
        }
      },
      {
        id: owner.id,
        taskId: a.task_id,
        accepted: true,
        note: 'First window verified',
        resultVersion: 1,
      }
    ),
    left.evaluate(
      async (input) => {
        try {
          await window.fixture.client.review(input);
          return { accepted: true };
        } catch (error) {
          return { error: String(error) };
        }
      },
      {
        id: owner.id,
        taskId: a.task_id,
        accepted: false,
        note: 'Other window requests changes',
        resultVersion: 1,
      }
    ),
  ]);
  assert.equal(decisions.filter((value) => value.accepted).length, 1);
  assert.match(decisions.find((value) => value.error).error, /already reviewed/);
  const reviewed = await snapshot(page, owner.taskId);
  const decision = reviewed.tasks[a.task_id].review;
  assert.ok(decision);
  await Promise.all([
    page.getByText('Review: ' + decision.note, { exact: true }).waitFor(),
    left.getByText('Review: ' + decision.note, { exact: true }).waitFor(),
  ]);
  await left.screenshot({ path: join(profile, 'review-decision.png') });
  checks.push(
    'opposite reviews from separate renderer Wire connections accept one decision and both native windows display the saved result'
  );
  if (!decision.accepted) {
    await call(worker, 'submit_task_result', {
      task_id: a.task_id,
      request_id: 'result-two',
      result: {
        summary: 'Accepted prerequisite revision',
        commits: [baseline],
        checks: [],
        unresolved: [],
        prUrls: [],
      },
    });
    await page.evaluate((input) => window.fixture.client.review(input), {
      id: owner.id,
      taskId: a.task_id,
      accepted: true,
      note: 'Accept the next version',
      resultVersion: 2,
    });
  }
  await wait(
    () => readCapture(dependent.conversation_id),
    'The transferred waiting task did not start after prerequisite review'
  );
  const started = await status(page, destinations[0].id, dependent.task_id);
  assert.equal(started.phase, 'started');
  assert.deepEqual(started.selectionSnapshot, before.selectionSnapshot);
  const starts = await captureLines('worker-starts.jsonl');
  assert.equal(starts.filter((entry) => entry.id === dependent.conversation_id).length, 1);
  const finalOwner = await snapshot(page, destinations[0].taskId);
  assert.equal(finalOwner.tasks[dependent.task_id].documents[0].content, document.content);
  checks.push(
    'a waiting task starts once under its destination owner with the original selection and document snapshot'
  );
  const baseVersion = await page.evaluate(
    (id) => window.fixture.client.readDocument({ id, path: 'plan.md' }),
    owner.id
  );
  const edits = await Promise.all([
    page.evaluate(
      async (input) => {
        try {
          return { saved: await window.fixture.client.writeDocument(input) };
        } catch (error) {
          return { error: String(error) };
        }
      },
      {
        id: owner.id,
        path: 'plan.md',
        content: 'First window document\n',
        expectedRevision: baseVersion.revision,
      }
    ),
    left.evaluate(
      async (input) => {
        try {
          return { saved: await window.fixture.client.writeDocument(input) };
        } catch (error) {
          return { error: String(error) };
        }
      },
      {
        id: owner.id,
        path: 'plan.md',
        content: 'Second window document\n',
        expectedRevision: baseVersion.revision,
      }
    ),
  ]);
  assert.equal(edits.filter((entry) => entry.saved).length, 1);
  assert.match(edits.find((entry) => entry.error).error, /changed/);
  const savedDocument = edits.find((entry) => entry.saved).saved;
  assert.deepEqual(
    await left.evaluate(
      (id) => window.fixture.client.readDocument({ id, path: 'plan.md' }),
      owner.id
    ),
    savedDocument
  );
  assert.equal(finalOwner.tasks[dependent.task_id].documents[0].content, document.content);
  checks.push(
    'concurrent document writes from native windows require the same disk revision; one wins and frozen task input remains unchanged'
  );
  await writeFile(join(capture, 'fail-next-start'), 'Fail one isolated ACP startup');
  const failed = await main.callTool({
    name: 'create_task',
    arguments: {
      name: 'Concurrent retry',
      request_id: 'retry-race',
      agent: 'opencode',
      ui: 'chat',
      connection: 'official',
      effort: null,
      prompt: 'Recover one task from two windows',
    },
  });
  assert.equal(failed.isError, true);
  const ownerWithFailure = await snapshot(page, owner.taskId);
  const failedTask = Object.values(ownerWithFailure.tasks).find(
    (task) => task.name === 'Concurrent retry'
  );
  assert.ok(failedTask);
  const failedStatus = await status(page, owner.id, failedTask.taskId);
  assert.equal(failedStatus.canRetry, true);
  const attemptsBefore = (await captureLines('acp-starts.jsonl')).length;
  await Promise.all([
    page.evaluate((input) => window.fixture.client.retryTask(input), {
      id: owner.id,
      taskId: failedTask.taskId,
    }),
    left.evaluate((input) => window.fixture.client.retryTask(input), {
      id: owner.id,
      taskId: failedTask.taskId,
    }),
  ]);
  const retried = await status(page, owner.id, failedTask.taskId);
  assert.equal(retried.phase, 'started');
  assert.equal(retried.path, failedStatus.path);
  assert.deepEqual(retried.selectionSnapshot, failedStatus.selectionSnapshot);
  assert.equal((await captureLines('acp-starts.jsonl')).length, attemptsBefore + 1);
  checks.push(
    'two native renderer retries of a failed ACP startup reuse one task, workspace and successful runtime launch'
  );
  const savedTaskHead = (
    await execute('git', ['rev-parse', 'HEAD'], { cwd: started.path })
  ).stdout.trim();
  const worktreesBefore = await git('worktree', 'list', '--porcelain');
  const durableReview = (await snapshot(page, owner.taskId)).tasks[a.task_id].review;
  for (const client of clients.splice(0)) await client.close();
  await quit();
  await launch();
  const restoredOwner = await snapshot(page, destinations[0].taskId);
  assert.equal(restoredOwner.tasks[dependent.task_id].ownershipHistory.length, 1);
  assert.equal(restoredOwner.tasks[dependent.task_id].taskCreated, true);
  assert.deepEqual(
    restoredOwner.tasks[dependent.task_id].documents,
    finalOwner.tasks[dependent.task_id].documents
  );
  assert.deepEqual((await snapshot(page, owner.taskId)).tasks[a.task_id].review, durableReview);
  assert.equal(
    (await execute('git', ['rev-parse', 'HEAD'], { cwd: started.path })).stdout.trim(),
    savedTaskHead
  );
  assert.equal(await git('worktree', 'list', '--porcelain'), worktreesBefore);
  assert.equal(
    (
      await page.evaluate(
        (id) => window.fixture.client.readDocument({ id, path: 'plan.md' }),
        owner.id
      )
    ).content,
    savedDocument.content
  );
  assert.equal((await status(page, owner.id, failedTask.taskId)).phase, 'started');
  const restoredPopout = await wait(
    async () => app.windows().find((candidate) => candidate.url() === leftPopoutUrl),
    'The saved popout window was not restored'
  );
  await attach(restoredPopout);
  await restoredPopout.getByTestId('coordinator-tasks-tab').click();
  await restoredPopout.getByText('Waiting takeover', { exact: true }).waitFor();
  await restoredPopout.screenshot({ path: join(profile, 'restored-popout.png') });
  checks.push(
    'full Electron restart preserves ownership, accepted reviews, document contents and workspace identities without replaying terminal delegations'
  );
  if (process.env.EMDASH_COORDINATION_FORCE_RECOVERY === '1') {
    const crashClient = await connect(owner.conversationId);
    const receipt = await call(crashClient, 'submit_task_result', {
      task_id: a.task_id,
      request_id: 'result-before-process-death',
      result: {
        summary: 'Result persisted before forced process death',
        commits: [baseline],
        checks: [],
        unresolved: [],
        prUrls: [],
      },
    });
    await wait(async () => {
      const saved = await snapshot(page, owner.taskId);
      return saved.events.find((event) => event.id === receipt.eventId)?.state === 'queued';
    }, 'The result notification did not reach its durable queued state');
    const deliveries = async () =>
      (await captureLines('prompts.jsonl')).filter((entry) =>
        JSON.stringify(entry.prompt).includes(receipt.eventId)
      ).length;
    await wait(async () => (await deliveries()) === 1, 'The first notification was not delivered');
    for (const client of clients.splice(0)) await client.close();
    await unlink(join(capture, owner.conversationId + '.json'));
    const killed = app.process();
    const exited = once(killed, 'exit');
    assert.equal(killed.kill('SIGKILL'), true);
    await exited;
    assert.equal(killed.signalCode, 'SIGKILL');
    app = undefined;
    await launch();
    const recovered = await snapshot(page, owner.taskId);
    assert.equal(recovered.events.filter((event) => event.id === receipt.eventId).length, 1);
    assert.equal(recovered.tasks[a.task_id].resultVersion, receipt.version);
    assert.equal(recovered.tasks[a.task_id].state, 'review');
    assert.equal(await git('worktree', 'list', '--porcelain'), worktreesBefore);
    await wait(
      async () => (await deliveries()) === 2,
      'The unacknowledged result was not recovered'
    );
    const receiver = await connect(owner.conversationId);
    await call(receiver, 'acknowledge_task_results', { event_ids: [receipt.eventId] });
    assert.equal(
      (await snapshot(page, owner.taskId)).events.find((event) => event.id === receipt.eventId)
        .state,
      'acknowledged'
    );
    checks.push(
      'actual Electron main SIGKILL between notification delivery and acknowledgment recovers one result event and redelivers its stable ID without recreating workspaces'
    );
  }
  await writeFile(
    join(profile, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        checks,
        owner: owner.id,
        destination: destinations[0].id,
        task: dependent.task_id,
        decisions: decisions.map((value) =>
          value.error ? { error: value.error } : { accepted: true }
        ),
      },
      null,
      2
    )
  );
  await quit();
  process.stdout.write('Multiwindow coordination acceptance passed: ' + profile + '\n');
} catch (error) {
  await writeFile(
    join(profile, 'failure-error.json'),
    JSON.stringify({ message: error.message, stack: error.stack, checks }, null, 2)
  );
  if (page && !page.isClosed())
    await page.screenshot({ path: join(profile, 'failure.png') }).catch(() => {});
  process.stdout.write('Multiwindow coordination acceptance failed: ' + profile + '\n');
  process.exitCode = 1;
} finally {
  for (const client of clients) await client.close().catch(() => {});
  if (app) await quit().catch(() => app?.process().kill('SIGKILL'));
  await renderer.close();
}
