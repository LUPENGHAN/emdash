import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
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
const profile = await mkdtemp(join(tmpdir(), 'emdash-complete-coordination-'));
const repository = join(profile, 'repo');
const capture = join(profile, 'captures');
await mkdir(repository);
await mkdir(capture);
const execute = promisify(execFile);
const git = async (...args) => (await execute('git', args, { cwd: repository })).stdout.trim();
await git('init', '-b', 'main');
await git('config', 'user.name', 'Selection acceptance');
await git('config', 'user.email', 'test@example.invalid');
await writeFile(join(repository, 'README.md'), 'Isolated model selection acceptance');
await git('add', '.');
await git('commit', '-m', 'Baseline');
const baseline = await git('rev-parse', 'HEAD');
const gitAt = async (cwd, ...args) => (await execute('git', args, { cwd })).stdout.trim();
const sdkRepository = join(profile, 'sdk');
const consumerRepository = join(profile, 'consumer');
for (const target of [sdkRepository, consumerRepository]) {
  await execute('git', ['clone', repository, target]);
  await gitAt(target, 'config', 'user.name', 'Complete acceptance');
  await gitAt(target, 'config', 'user.email', 'test@example.invalid');
  await gitAt(target, 'remote', 'remove', 'origin');
}
const forge = await startGitForgeFixture(join(profile, 'forge'), sdkRepository, {
  separateAccounts: true,
});
// Only this temporary repository uses these fake native Git credentials.
await gitAt(sdkRepository, 'config', 'credential.helper', '');
await gitAt(
  sdkRepository,
  'config',
  '--add',
  'credential.helper',
  "!f() { printf 'username=fixture-pusher\\npassword=fixture-source-token\\n'; }; f"
);
for (const [name, owner] of [
  ['upstream', 'org'],
  ['personal', 'personal'],
]) {
  await gitAt(sdkRepository, 'remote', 'add', name, forge.gitUrl(owner));
  await gitAt(sdkRepository, 'fetch', name);
}

const seen = [];
const upstream = createHttpServer((request, response) => {
  void (async () => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    const anthropic = request.url.startsWith('/anthropic/');
    seen.push({
      model: body.model,
      effort: anthropic ? body.output_config?.effort : body.reasoning_effort,
      path: request.url,
    });
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        anthropic
          ? {
              id: 'msg_fixture',
              type: 'message',
              role: 'assistant',
              model: body.model,
              content: [{ type: 'text', text: 'ACCEPTED' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 2 },
            }
          : {
              id: 'chat_fixture',
              object: 'chat.completion',
              created: 1,
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'ACCEPTED' },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 17,
                completion_tokens: 5,
                total_tokens: 22,
                prompt_tokens_details: { cached_tokens: 3 },
              },
            }
      )
    );
  })().catch(() => {
    response.statusCode = 500;
    response.end('Fixture request failed');
  });
});
await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${upstream.address().port}`;
const wrapper = join(profile, 'selection-claude.mjs');
const codexWrapper = join(profile, 'selection-codex.mjs');
for (const [agent, file] of [
  ['claude', wrapper],
  ['codex', codexWrapper],
]) {
  await writeFile(
    file,
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const agent = ${JSON.stringify(agent)};
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) { console.log(agent === 'claude' ? '2.1.326 (Claude Code)' : 'codex-cli 0.169.0'); process.exit(0); }
if (['auth', 'login'].includes(args[0])) { console.log(JSON.stringify({loggedIn:false})); process.exit(0); }
const flags = {};
for (let i = 0; i < args.length; i++) if (args[i] === '-c') {
  const raw = args[i + 1]; const at = raw.indexOf('='); const value = raw.slice(at + 1);
  try { flags[raw.slice(0, at)] = JSON.parse(value); } catch { flags[raw.slice(0, at)] = value; }
}
const base = agent === 'claude' ? process.env.ANTHROPIC_BASE_URL : flags['model_providers.' + flags.model_provider + '.base_url'];
if (!base) throw new Error('Missing actual gateway launch URL');
const id = decodeURIComponent(new URL(base).pathname.split('/')[2]);
const model = agent === 'claude' ? process.env.ANTHROPIC_MODEL : flags.model;
const effort = agent === 'claude' ? process.env.CLAUDE_CODE_EFFORT_LEVEL : flags.model_reasoning_effort;
const cliEffort = agent === 'claude' ? args[args.indexOf('--effort') + 1] : flags.model_reasoning_effort;
const key = agent === 'claude' ? (process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY) : process.env[flags['model_providers.' + flags.model_provider + '.env_key']];
if (!model || !effort || !key) throw new Error('Missing actual model, effort or gateway credential');
const mcp = args.find(arg => arg.startsWith('--mcp-config='));
const record = { model, effort, cliEffort, args, mcpUrl: mcp ? JSON.parse(mcp.slice('--mcp-config='.length)).mcpServers.emdash.url : undefined };
const output = path.join(${JSON.stringify(capture)}, id + '.json');
fs.writeFileSync(output, JSON.stringify(record));
setInterval(() => {}, 1000);
try {
 const response = await fetch(base + (agent === 'claude' ? '/v1/messages' : '/responses'), {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
  body: JSON.stringify(agent === 'claude' ? { model, max_tokens: 32, stream: false, messages: [{role:'user',content:'Check selection'}], output_config: {effort} } : { model, input: 'Check selection', stream: false, reasoning: {effort} }),
 });
 const text = await response.text();
 fs.writeFileSync(output, JSON.stringify({...record, status: response.status, accepted: text.includes('ACCEPTED')}));
} catch (error) { fs.writeFileSync(output, JSON.stringify({...record, error: error.message})); }
`,
    { mode: 0o755 }
  );
}
const mainWrapper = join(profile, 'selection-main.mjs');
await writeFile(
  mainWrapper,
  `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline'; import crypto from 'node:crypto';
if (process.argv.includes('--version')) { console.log('2.2.6'); process.exit(0); }
if (!process.argv.includes('acp')) { console.log('{}'); process.exit(0); }
readline.createInterface({input:process.stdin}).on('line', line => {
 let q; try {q=JSON.parse(line);} catch {return;} if (q.id === undefined) return; let result = {};
 if (q.method === 'initialize') result = { protocolVersion:1, agentInfo:{name:'fixture',version:'1'}, agentCapabilities:{loadSession:true,mcpCapabilities:{http:true}}, authMethods:[] };
 if (q.method === 'session/new' || q.method === 'session/load') {
  const mcp=q.params.mcpServers.find(s=>s.name==='emdash'); const id=new URL(mcp.url).pathname.split('/')[2];
  fs.writeFileSync(path.join(${JSON.stringify(capture)}, id+'.json'),JSON.stringify({mcpUrl:mcp.url}));
  result=q.method==='session/new'?{sessionId:'ses_'+crypto.randomUUID(),configOptions:[]}:{configOptions:[]};
 }
 if (q.method === 'session/prompt') { fs.appendFileSync(path.join(${JSON.stringify(capture)}, 'prompts.jsonl'),JSON.stringify(q.params)+'\\n'); result={stopReason:'end_turn'}; }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
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
  CLAUDE_CONFIG_DIR: join(profile, 'claude'),
  CODEX_HOME: join(profile, 'codex'),
  OPENCODE_CONFIG_DIR: join(profile, 'opencode'),
  XDG_CONFIG_HOME: join(profile, 'config'),
  TELEMETRY_ENABLED: 'false',
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
let onboarded = false;
const clients = [];
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
const connect = async (id) => {
  const record = await wait(
    async () => (await readCapture(id))?.mcpUrl && (await readCapture(id)),
    'Missing fixture MCP identity'
  );
  const client = new Client({ name: 'selection-acceptance', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(record.mcpUrl)));
  clients.push(client);
  return client;
};
const call = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  const text = result.content.find((part) => part.type === 'text').text;
  return text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text;
};
async function launch() {
  app = await _electron.launch({
    executablePath: electronPath,
    args: [appRoot],
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
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
    content: `import {prepareCoordinator,coordinatorDelegationStatus,prepareAdditionalProject,configurePrAccountsFixture,openBaselineFixtureSettings,baselineFixtureState,observeMergedPrFixture} from '/@fs${join(appRoot, 'tooling/acceptance/task-delegation-browser.ts')}'; import {configureSelectionFixture,createOrdinarySelectionFixture,changeSelectionDefaultsFixture,selectionFixtureUsage,setSelectionSupplierKeyFixture} from '/@fs${join(appRoot, 'tooling/acceptance/model-selection-browser.ts')}'; import {getCoordinationClient} from '/@fs${join(appRoot, 'src/core/features/coordination/api/browser/client.ts')}'; Object.assign(window,{coordination:await getCoordinationClient(),prepareCoordinator,coordinatorDelegationStatus,prepareAdditionalProject,configurePrAccountsFixture,openBaselineFixtureSettings,baselineFixtureState,observeMergedPrFixture,configureSelectionFixture,createOrdinarySelectionFixture,changeSelectionDefaultsFixture,selectionFixtureUsage,setSelectionSupplierKeyFixture});`,
  });
  await page.waitForFunction(() => typeof window.configureSelectionFixture === 'function');
}
async function quit() {
  const child = app.process();
  const exited = once(child, 'exit');
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
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
    clearTimeout(timer);
    app = undefined;
  }
}
const worker = (id) =>
  wait(async () => {
    const value = await readCapture(id);
    return value?.status || value?.error ? value : null;
  }, 'The fixture worker did not complete its gateway request');
async function openMain(main, send = false) {
  const expand = page.getByRole('button', { name: /^(Expand|展开) Delegation acceptance$/ });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator(`[data-testid="project-main-agent"][data-project-id="${main.projectId}"]`)
    .click();
  await page.getByTestId('coordinator-conversation-tab').click();
  if (send) {
    await page
      .locator('[contenteditable="true"]')
      .first()
      .fill('Check the model selection fixture.');
    await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click();
  }
}
try {
  await launch();
  const main = await page.evaluate((input) => window.prepareCoordinator(input), {
    wrapper,
    mainWrapper,
    repository,
    worktreeRoot: join(profile, 'worktrees'),
  });
  const codeProjectId = await page.evaluate((input) => window.prepareAdditionalProject(input), {
    wrapper,
    repository: sdkRepository,
    worktreeRoot: join(profile, 'sdk-worktrees'),
    name: 'SDK combined acceptance',
    baselineBranch: 'main',
  });
  const consumerProjectId = await page.evaluate((input) => window.prepareAdditionalProject(input), {
    wrapper,
    repository: consumerRepository,
    worktreeRoot: join(profile, 'consumer-worktrees'),
    name: 'Consumer combined acceptance',
    baselineBranch: 'main',
  });
  const accounts = await page.evaluate((input) => window.configurePrAccountsFixture(input), {
    projectId: codeProjectId,
    apiBaseUrl: forge.origin,
  });
  assert.notEqual(accounts.defaultAccountId, accounts.targetAccountId);
  await page.evaluate((input) => window.coordination.update(input), {
    id: main.id,
    projectIds: [codeProjectId, consumerProjectId],
  });
  await page.evaluate((id) => window.coordination.open({ id }), main.id);
  const planText = 'COMBINED_PLAN_V1: SDK and consumer stay on separate task branches.\n';
  await page.evaluate((input) => window.coordination.writeDocument(input), {
    id: main.id,
    path: 'plan.md',
    content: planText,
  });
  const documentWorkspace = await page.evaluate(
    (id) => window.coordination.documentWorkspace({ id }),
    main.id
  );
  const documentCommit = await page.evaluate(
    (input) => window.coordination.commitDocuments(input),
    {
      id: main.id,
      paths: ['plan.md'],
      message: 'Commit combined execution plan',
      expectedRevision: documentWorkspace.revision,
    }
  );
  assert.equal(await git('show', documentCommit.hash + ':plan.md'), planText.trim());
  await page.evaluate((input) => window.configureSelectionFixture(input), {
    origin,
    codexWrapper,
    mainId: main.id,
  });
  const ordinary = await page.evaluate(
    (id) => window.createOrdinarySelectionFixture(id),
    main.projectId
  );
  assert.deepEqual(
    await worker(ordinary.conversationId).then((v) => [
      v.model,
      v.effort,
      v.cliEffort,
      v.status,
      v.accepted,
    ]),
    ['shared-code', 'high', 'high', 200, true]
  );
  await openMain(main, true);
  let mainClient = await connect(main.conversationId);
  await page.evaluate((id) => window.openBaselineFixtureSettings(id), codeProjectId);
  const baselineSection = page.getByRole('region', { name: 'Code baseline', exact: true });
  await baselineSection
    .getByLabel('Baseline verification command', { exact: true })
    .fill('test -f README.md && printf combined-baseline-verified');
  await baselineSection
    .getByRole('button', { name: 'Save baseline settings', exact: true })
    .click();
  await baselineSection.getByRole('button', { name: 'Check baseline', exact: true }).click();
  await baselineSection.getByText('Ready for delegation', { exact: true }).waitFor();
  const initialBaseline = await page.evaluate(
    (id) => window.baselineFixtureState(id),
    codeProjectId
  );
  assert.equal(initialBaseline.proof.oid, baseline);
  assert.equal(initialBaseline.proof.verification, 'succeeded');
  await openMain(main);

  const a = await call(mainClient, 'create_task', {
    name: 'Inherit main defaults',
    request_id: 'selection-a',
    project_id: codeProjectId,
    document_refs: [{ path: 'plan.md', revision: documentCommit.hash }],
    prompt: 'Check inherited main configuration',
    ui: 'terminal',
  });
  assert.equal(a.selection_snapshot.sources.effort, 'main-default');
  assert.deepEqual(
    await worker(a.conversation_id).then((v) => [v.effort, v.cliEffort, v.status, v.accepted]),
    ['medium', 'medium', 200, true]
  );
  const explicit = await call(mainClient, 'create_task', {
    name: 'Explicit effort wins',
    request_id: 'selection-explicit',
    prompt: 'Check explicit effort',
    ui: 'terminal',
    effort: 'low',
  });
  assert.equal(explicit.selection_snapshot.sources.effort, 'request');
  assert.equal((await worker(explicit.conversation_id)).effort, 'low');
  const bRequest = {
    name: 'Frozen supplier consumer',
    project_id: consumerProjectId,
    document_refs: [{ path: 'plan.md', revision: documentCommit.hash }],
    request_id: 'selection-b',
    prompt: 'Use the accepted result',
    ui: 'terminal',
    agent: 'codex',
    connection: 'gateway',
    supplier_id: 'selection-b',
    model: 'custom-b',
    effort: 'high',
    depends_on: [a.task_id],
  };
  const b = await call(mainClient, 'create_task', bRequest);
  assert.equal(b.status, 'blocked');
  assert.equal(await readCapture(b.conversation_id), null);
  assert.deepEqual(b.selection_snapshot.values, {
    agent: 'codex',
    transport: 'pty',
    modelSource: 'gateway:models',
    model: 'custom-b',
    supplierId: 'selection-b',
    effort: 'high',
  });
  const aGit = (...args) => gitAt(a.path, ...args);
  await writeFile(join(a.path, 'sdk.mjs'), 'export const value = 21;\n');
  const aCheck = await execute(process.execPath, ['--check', 'sdk.mjs'], { cwd: a.path });
  await aGit('add', 'sdk.mjs');
  await aGit('commit', '-m', 'Implement SDK for combined acceptance');
  const aOid = await aGit('rev-parse', 'HEAD');
  const aBranch = await aGit('branch', '--show-current');
  assert.ok((await worker(a.conversation_id)).args.join(' ').includes('COMBINED_PLAN_V1'));
  const aStatus = await page.evaluate(
    (input) => window.coordinatorDelegationStatus(input.id, input.taskId),
    { id: main.id, taskId: a.task_id }
  );
  assert.equal(aStatus.baselineSelection.oid, baseline);
  assert.equal(aStatus.baselineSelection.verification, 'succeeded');
  const aClient = await connect(a.conversation_id);
  const submitted = await call(aClient, 'submit_task_result', {
    task_id: a.task_id,
    request_id: 'a-result',
    result: {
      summary: 'Configuration inspected',
      commits: [aOid],
      checks: [{ command: 'node --check sdk.mjs', passed: true, output: aCheck.stdout }],
      unresolved: [],
      prUrls: [],
    },
  });
  await wait(async () => {
    try {
      return (await readFile(join(capture, 'prompts.jsonl'), 'utf8')).includes(submitted.eventId);
    } catch {
      return false;
    }
  }, 'The result was not delivered to the main');
  await call(mainClient, 'acknowledge_task_results', { event_ids: [submitted.eventId] });
  await page.getByTestId('coordinator-tasks-tab').click();
  const bRow = page.locator('article').filter({ hasText: 'Frozen supplier consumer' });
  await bRow.getByTestId('task-execution-configuration').locator('summary').click();
  await bRow.locator('dd').filter({ hasText: 'custom-b' }).waitFor();
  await bRow.screenshot({ path: join(profile, 'selection-waiting.png') });
  await page.evaluate((id) => window.changeSelectionDefaultsFixture(id), main.id);
  const editablePlan = await page.evaluate(
    (id) => window.coordination.readDocument({ id, path: 'plan.md' }),
    main.id
  );
  await page.evaluate((input) => window.coordination.writeDocument(input), {
    id: main.id,
    path: 'plan.md',
    content: 'COMBINED_PLAN_V2: edited while consumer is waiting.\n',
    expectedRevision: editablePlan.revision,
  });
  const documentV2Base = await page.evaluate(
    (id) => window.coordination.documentWorkspace({ id }),
    main.id
  );
  const documentV2 = await page.evaluate((input) => window.coordination.commitDocuments(input), {
    id: main.id,
    paths: ['plan.md'],
    message: 'Revise combined execution plan',
    expectedRevision: documentV2Base.revision,
  });

  for (const client of clients.splice(0)) await client.close();
  await unlink(join(capture, main.conversationId + '.json'));
  await quit();
  await launch();
  const restored = await page.evaluate(
    (input) => window.coordinatorDelegationStatus(input.id, input.taskId),
    { id: main.id, taskId: b.task_id }
  );
  assert.deepEqual(restored.selectionSnapshot, b.selection_snapshot);
  await openMain(main, true);
  mainClient = await connect(main.conversationId);
  await page.evaluate(() => window.setSelectionSupplierKeyFixture(false));
  await call(mainClient, 'review_task_result', {
    task_id: a.task_id,
    result_version: 1,
    accepted: true,
    note: 'Verified configuration and upstream evidence',
  });
  const failed = await wait(async () => {
    const status = await page.evaluate(
      (input) => window.coordinatorDelegationStatus(input.id, input.taskId),
      { id: main.id, taskId: b.task_id }
    );
    return status?.error && status.canRetry ? status : null;
  }, 'Missing credentials did not leave a retryable startup failure');
  assert.deepEqual(failed.selectionSnapshot, b.selection_snapshot);
  assert.equal(await readCapture(b.conversation_id), null);
  assert.ok(failed.path);
  await page.getByTestId('coordinator-tasks-tab').click();
  const retryRow = page.locator('article').filter({ hasText: 'Frozen supplier consumer' });
  await retryRow.getByTestId('retry-task-startup').waitFor();
  await retryRow.screenshot({ path: join(profile, 'selection-startup-failed.png') });
  await page.evaluate(() => window.setSelectionSupplierKeyFixture(true));
  await retryRow.getByTestId('retry-task-startup').click();
  const launched = await worker(b.conversation_id);
  assert.deepEqual(
    [launched.model, launched.effort, launched.cliEffort, launched.status, launched.accepted],
    ['task-model', 'high', 'high', 200, true]
  );
  const retried = await page.evaluate(
    (input) => window.coordinatorDelegationStatus(input.id, input.taskId),
    { id: main.id, taskId: b.task_id }
  );
  assert.deepEqual(retried.selectionSnapshot, b.selection_snapshot);
  assert.equal(retried.path, failed.path);
  assert.equal(retried.phase, 'started');

  assert.ok(launched.args.join(' ').includes('COMBINED_PLAN_V1'));
  assert.ok(!launched.args.join(' ').includes('COMBINED_PLAN_V2'));
  assert.ok(launched.args.join(' ').includes(aOid));
  const frozen = await call(mainClient, 'get_task_status', { task_id: b.task_id });
  assert.equal(frozen.coordination.assignment.documents[0].content, planText);
  assert.equal(frozen.coordination.assignment.dependencyResults[0].version, 1);
  assert.deepEqual(frozen.coordination.assignment.dependencyResults[0].commits, [aOid]);
  const bGit = (...args) => gitAt(retried.path, ...args);
  await writeFile(
    join(retried.path, 'consumer.mjs'),
    'export const answer = sdk => sdk.value * 2;\n'
  );
  const integratedCommand = `import {value} from ${JSON.stringify(join(a.path, 'sdk.mjs'))}; import {answer} from ${JSON.stringify(join(retried.path, 'consumer.mjs'))}; if(answer({value})!==42) process.exit(1); console.log('SDK and consumer: 42');`;
  const bCheck = await execute(process.execPath, ['--input-type=module', '-e', integratedCommand]);
  await bGit('add', 'consumer.mjs');
  await bGit('commit', '-m', 'Consume SDK on independent task branch');
  const bOid = await bGit('rev-parse', 'HEAD');
  const bResult = await call(mainClient, 'submit_task_result', {
    task_id: b.task_id,
    request_id: 'combined-consumer-result',
    result: {
      summary: 'Executed SDK and consumer together',
      commits: [bOid],
      checks: [
        {
          command: 'node: import task SDK and execute consumer',
          passed: true,
          output: bCheck.stdout,
        },
      ],
      unresolved: [],
      prUrls: [],
    },
  });
  await wait(
    async () => (await readFile(join(capture, 'prompts.jsonl'), 'utf8')).includes(bResult.eventId),
    'The combined result was not delivered'
  );
  await call(mainClient, 'acknowledge_task_results', { event_ids: [bResult.eventId] });
  await call(mainClient, 'review_task_result', {
    task_id: b.task_id,
    result_version: 1,
    accepted: true,
    note: 'Executed the SDK and consumer and inspected both task commits',
  });
  assert.equal(
    (await call(mainClient, 'get_task_status', { task_id: b.task_id })).coordination.assignment
      .state,
    'done'
  );
  assert.equal(await aGit('ls-tree', '--name-only', 'HEAD', 'plan.md'), '');
  assert.equal(await bGit('ls-tree', '--name-only', 'HEAD', 'plan.md'), '');
  const prArguments = {
    task_id: a.task_id,
    request_id: 'combined-pr',
    title: 'Combined SDK change',
    push_remote: 'personal',
    target_repository: forge.repositoryUrl('org'),
    target_branch: 'main',
  };
  forge.loseNextCreateResponse();
  assert.equal(
    (await mainClient.callTool({ name: 'create_pull_request', arguments: prArguments })).isError,
    true
  );
  assert.equal(forge.prs.length, 1);
  assert.equal(
    (await call(mainClient, 'get_task_status', { task_id: a.task_id })).pullRequests[0].phase,
    'creating'
  );
  const prPosts = forge.requests.filter(
    (r) => r.method === 'POST' && r.path.endsWith('/merge_requests')
  );
  assert.equal(prPosts.length, 1);
  assert.equal(prPosts[0].identity, 'target-api');
  const gitPosts = forge.requests.filter(
    (r) => r.method === 'POST' && r.path.endsWith('/git-receive-pack')
  );
  assert.ok(gitPosts.length > 0);
  assert.ok(gitPosts.every((r) => r.identity === 'source-git'));
  const evidence = await wait(async () => {
    const value = await page.evaluate(() => window.selectionFixtureUsage());
    return value.usage.some((row) => row.sessionId === b.conversation_id) ? value : null;
  }, 'Missing durable gateway usage');
  const aUsage = evidence.usage.find((row) => row.sessionId === a.conversation_id);
  const bUsage = evidence.usage.find((row) => row.sessionId === b.conversation_id);
  assert.equal(aUsage.accountId, 'selection-a');
  assert.equal(aUsage.upstreamModel, 'upstream-a');
  assert.equal(bUsage.accountId, 'selection-b');
  assert.equal(bUsage.upstreamModel, 'custom-b');
  assert.equal(bUsage.requestedModel, 'custom-b');
  assert.equal(evidence.usage.filter((row) => row.sessionId === b.conversation_id).length, 1);
  assert.equal(bUsage.inboundProtocol, 'openai-responses');
  assert.equal(bUsage.upstreamProtocol, 'openai-chat');
  assert.equal(bUsage.failed, false);
  assert.equal(bUsage.status, 'complete');
  assert.deepEqual([bUsage.inputTokens, bUsage.outputTokens, bUsage.cachedTokens], [17, 5, 3]);
  assert.ok(seen.some((row) => row.model === 'custom-b' && row.effort === 'high'));
  assert.ok(seen.some((row) => row.model === 'upstream-a' && row.effort === 'medium'));
  const route = evidence.routes.find((row) => row.conversationId === b.conversation_id);
  assert.equal(route.upstreamModel, 'custom-b');
  assert.equal(route.requestedModel, 'custom-b');
  await page.getByRole('button', { name: /^(Settings|设置)$/ }).click();
  await page
    .getByText(/^(Providers|供应商)$/)
    .first()
    .click();
  await page.getByRole('button', { name: /^(Router usage|路由用量)$/ }).click();
  await page
    .getByRole('row')
    .filter({ hasText: 'custom-b' })
    .getByText('Selection provider B', { exact: true })
    .waitFor();
  await page.screenshot({ path: join(profile, 'selection-usage.png') });
  for (const client of clients.splice(0)) await client.close();
  await quit();
  await launch();
  const retained = await page.evaluate(() => window.selectionFixtureUsage());
  assert.deepEqual(
    retained.usage.find((row) => row.id === bUsage.id),
    bUsage
  );
  assert.deepEqual(
    (
      await page.evaluate((input) => window.coordinatorDelegationStatus(input.id, input.taskId), {
        id: main.id,
        taskId: b.task_id,
      })
    ).selectionSnapshot,
    b.selection_snapshot
  );

  await openMain(main, true);
  const restoredMain = await connect(main.conversationId);
  assert.equal(
    (await call(restoredMain, 'get_task_status', { task_id: a.task_id })).pullRequests[0].phase,
    'creating'
  );
  await page.getByTestId('coordinator-tasks-tab').click();
  await page
    .getByTestId('task-pr-status')
    .getByText('Combined SDK change · PR creating', { exact: true })
    .click();
  await page.getByTestId('retry-task-pr').click();
  await page
    .getByTestId('task-pr-status')
    .getByText('Combined SDK change · PR complete', { exact: true })
    .waitFor();
  const recoveredPr = (await call(restoredMain, 'get_task_status', { task_id: a.task_id }))
    .pullRequests[0];
  assert.equal(recoveredPr.phase, 'complete');
  assert.equal(recoveredPr.plan.oid, aOid);
  assert.equal(forge.prs.length, 1);
  assert.equal(
    forge.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/merge_requests')).length,
    prPosts.length
  );
  const organizationBare = join(profile, 'forge', 'org', 'sdk.git');
  const personalBare = join(profile, 'forge', 'personal', 'sdk.git');
  const author = join(profile, 'upstream-author');
  await execute('git', ['clone', organizationBare, author]);
  await gitAt(author, 'config', 'user.name', 'Combined upstream');
  await gitAt(author, 'config', 'user.email', 'test@example.invalid');
  await gitAt(author, 'fetch', personalBare, aBranch);
  await gitAt(author, 'merge', '--no-ff', '--no-edit', 'FETCH_HEAD');
  const mergedOid = await gitAt(author, 'rev-parse', 'HEAD');
  await gitAt(author, 'push', organizationBare, 'main');
  await page.evaluate((id) => window.openBaselineFixtureSettings(id), codeProjectId);
  const mergedSection = page.getByRole('region', { name: 'Code baseline', exact: true });
  await mergedSection
    .getByLabel('Baseline verification command', { exact: true })
    .fill('test -f sdk.mjs && node --check sdk.mjs && printf combined-upstream-verified');
  await mergedSection.getByRole('button', { name: 'Save baseline settings', exact: true }).click();
  const pushesBeforeSync = forge.requests.filter((r) =>
    r.path.endsWith('/git-receive-pack')
  ).length;
  forge.markMerged(recoveredPr.result.number);
  await page.evaluate((input) => window.observeMergedPrFixture(input), {
    repositoryUrl: forge.repositoryUrl('org'),
    number: recoveredPr.result.number,
  });
  const mergedState = await wait(async () => {
    const v = await page.evaluate((id) => window.baselineFixtureState(id), codeProjectId);
    return v.status === 'ready' &&
      v.proof?.oid === mergedOid &&
      v.attempts.some((a) => a.trigger === 'pr-merged' && a.observation?.oid === mergedOid)
      ? v
      : null;
  }, 'The organization merge did not synchronize and verify the local SDK baseline');
  assert.equal(mergedState.proof.verification, 'succeeded');
  assert.equal(await gitAt(sdkRepository, 'rev-parse', 'main'), mergedOid);
  assert.equal(await aGit('rev-parse', 'HEAD'), aOid);
  assert.equal(await bGit('rev-parse', 'HEAD'), bOid);
  assert.equal(await git('rev-parse', `refs/heads/emdash/manage/${main.taskId}`), documentV2.hash);
  assert.equal(
    (await execute('git', ['--git-dir', personalBare, 'rev-parse', 'main'])).stdout.trim(),
    baseline
  );
  assert.equal(
    forge.requests.filter((r) => r.path.endsWith('/git-receive-pack')).length,
    pushesBeforeSync
  );
  const verifiedAttempt = mergedState.attempts.find(
    (a) =>
      a.verification?.status === 'succeeded' &&
      a.verification.workspacePath &&
      a.observation?.oid === mergedOid
  );
  assert.ok(verifiedAttempt);
  const verificationPath = verifiedAttempt.verification.workspacePath;
  await appendFile(join(sdkRepository, '.git/info/exclude'), '\ncombined-verification-cache/\n');
  await mkdir(join(verificationPath, 'combined-verification-cache'));
  await writeFile(
    join(verificationPath, 'combined-verification-cache', 'output'),
    'Retain this verification artifact'
  );
  await mergedSection.getByText('Verification checkout history', { exact: true }).click();
  const checkRow = mergedSection.locator('details > div').filter({ hasText: verificationPath });
  await checkRow.getByRole('button', { name: 'Clean verification checkout', exact: true }).click();
  await checkRow.getByText(/contains changes, untracked files, or ignored files/).waitFor();
  assert.equal(
    await readFile(join(verificationPath, 'combined-verification-cache', 'output'), 'utf8'),
    'Retain this verification artifact'
  );
  await rm(join(verificationPath, 'combined-verification-cache'), { recursive: true });
  await checkRow.getByRole('button', { name: /^(Retry|重试) cleanup$/ }).click();
  await checkRow
    .getByText('Checkout removed; verification evidence retained.', { exact: true })
    .waitFor();
  await assert.rejects(lstat(verificationPath));
  await page.screenshot({ path: join(profile, 'combined-baseline-and-cleanup.png') });
  for (const client of clients.splice(0)) await client.close();
  await quit();
  await launch();
  const finalOwner = await page.evaluate(
    (taskId) => window.coordination.getByTask({ taskId }),
    main.taskId
  );
  assert.equal(finalOwner.tasks[a.task_id].state, 'done');
  assert.equal(finalOwner.tasks[b.task_id].state, 'done');
  assert.equal(finalOwner.tasks[b.task_id].documents[0].content, planText);
  const finalBaseline = await page.evaluate((id) => window.baselineFixtureState(id), codeProjectId);
  assert.equal(finalBaseline.proof.oid, mergedOid);
  assert.equal(
    finalBaseline.attempts.find((a) => a.id === verifiedAttempt.id).cleanup.status,
    'removed'
  );
  assert.equal(
    finalBaseline.attempts.find((a) => a.id === verifiedAttempt.id).verification.output,
    'combined-upstream-verified'
  );
  assert.deepEqual(
    (await page.evaluate(() => window.selectionFixtureUsage())).usage.find(
      (r) => r.id === bUsage.id
    ),
    bUsage
  );
  await openMain(main, true);
  const finalMain = await connect(main.conversationId);
  assert.equal(
    (await call(finalMain, 'get_task_status', { task_id: a.task_id })).pullRequests[0].phase,
    'complete'
  );
  await page.getByTestId('coordinator-tasks-tab').click();
  await page.screenshot({ path: join(profile, 'combined-restored-results.png') });
  await writeFile(
    join(profile, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        checks: [
          'one isolated application profile coordinates a management repository, SDK repository and consumer repository',
          'management plan commits are independent, and both tasks receive the frozen version across edits and restarts',
          'approved SDK commit becomes the consumer prerequisite, and an actual Node execution validates both task branches together',
          'native Git pushes use the source identity while the project-pinned target API identity creates the organization PR',
          'a lost PR response survives restart, and UI recovery restores the same receipt without another create request',
          'organization merge advances and verifies only the local code baseline, preserving task branches, documents and fork main',
          'ignored verification artifacts prevent cleanup, and explicit retry removes the checkout while retaining durable evidence',
          'final restart retains completed reviews, frozen documents, PR receipt, verification cleanup and exact gateway usage',
          'ordinary session consumes saved Agent model and high effort through the real gateway',
          'main delegation defaults override Agent settings and explicit task effort overrides main defaults',
          'selection values, origin and version fingerprint are durable and visible while waiting',
          'changing Agent defaults, main defaults and public catalog then restarting preserves the waiting supplier/model/effort snapshot',
          'accepted prerequisite starts the same Codex task with high effort in actual CLI configuration',
          'credential loss blocks startup and the UI retries the same workspace and frozen selection after restoring the key',
          'real Go SDK converts Responses to Chat and upstream receives the bound custom model and effort',
          'durable ledger attributes model, protocols, provider, session and exact tokens to the executed request',
          'usage UI shows the executed supplier/model and ledger plus selection evidence survive another full restart',
        ],
        accounts,
        forgeRequests: forge.requests,
        revisions: {
          aOid,
          bOid,
          mergedOid,
          documentV1: documentCommit.hash,
          documentV2: documentV2.hash,
        },
        seen,
        usage: retained.usage,
      },
      null,
      2
    )
  );
  await quit();
  process.stdout.write(`Complete coordination acceptance passed: ${profile}\n`);
} catch (error) {
  await writeFile(
    join(profile, 'failure-error.json'),
    JSON.stringify({ message: error.message, stack: error.stack, seen }, null, 2)
  );
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(profile, 'failure.png') }).catch(() => {});
    await writeFile(join(profile, 'failure.html'), await page.content()).catch(() => {});
  }
  process.stdout.write(`Complete coordination acceptance failed: ${profile}\n`);
  process.exitCode = 1;
} finally {
  for (const client of clients) await client.close().catch(() => {});
  if (app) await quit().catch(() => app?.process().kill('SIGKILL'));
  await renderer.close();
  await forge.close();
  upstream.closeAllConnections();
  await new Promise((done) => upstream.close(done));
}
