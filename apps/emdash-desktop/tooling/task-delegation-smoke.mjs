import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
const profile = await mkdtemp(join(tmpdir(), 'emdash-delegation-'));
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
  TELEMETRY_ENABLED: 'false',
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
let client;
const sourceTask = randomUUID();
const sourceConversation = randomUUID();
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
try {
  app = await _electron.launch({
    executablePath: electronPath,
    args: [appRoot],
    env,
    timeout: 30000,
  });
  const page = await app.firstWindow();
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
    content: `
    import { prepareDelegationCaller } from '/@fs${join(appRoot, 'tooling/acceptance/task-delegation-browser.ts')}';
    window.prepareDelegationCaller = prepareDelegationCaller;
  `,
  });
  await page.waitForFunction(() => typeof window.prepareDelegationCaller === 'function');
  await page.evaluate((input) => window.prepareDelegationCaller(input), {
    wrapper,
    repository,
    worktreeRoot: join(profile, 'worktrees'),
    sourceTask,
    sourceConversation,
  });
  const source = await waitForCapture(sourceConversation);
  assert.ok(source.mcpUrl, 'The source agent was not given its authenticated Emdash MCP URL');
  client = new Client({ name: 'isolated-delegation-acceptance', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(source.mcpUrl)));
  await page.screenshot({ path: join(profile, 'before-background.png') });
  await page.close();
  const args = {
    name: 'Background change',
    prompt: 'Simulated implementation',
    agent: 'claude',
    effort: 'high',
    connection: 'official',
    request_id: 'background-request',
  };
  const invoke = async () => {
    const result = await client.callTool({ name: 'create_task', arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return JSON.parse(result.content.find((item) => item.type === 'text').text);
  };
  const created = await invoke();
  const duplicate = await invoke();
  assert.equal(created.task_id, duplicate.task_id);
  assert.equal(created.conversation_id, duplicate.conversation_id);
  assert.equal(created.status, 'agent_started');
  const spawned = await waitForCapture(created.conversation_id);
  assert.equal(spawned.effort, 'high');
  assert.equal(spawned.cliEffort, 'high');
  const head = (
    await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: created.path })
  ).stdout.trim();
  assert.equal(head, baseline);
  await writeFile(
    join(profile, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        checks: [
          'real Electron startup',
          'authenticated MCP',
          'renderer closed before delegation',
          'real registry worktree',
          'simulated CLI startup with effort',
          'request retry returns same task and session',
        ],
        taskId: created.task_id,
        conversationId: created.conversation_id,
        path: created.path,
      },
      null,
      2
    )
  );
  console.log(`Background delegation acceptance passed: ${profile}`);
} catch (error) {
  console.error(`Acceptance evidence: ${profile}`);
  throw error;
} finally {
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
