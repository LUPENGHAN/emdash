import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { _electron } from 'playwright';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(appRoot);
const profile = await mkdtemp(join(tmpdir(), 'emdash-default-effort-'));
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: join(profile, 'claude'),
  CODEX_HOME: join(profile, 'codex'),
  EMDASH_USER_DATA_DIR: profile,
  EMDASH_DB_FILE: join(profile, 'scratch.db'),
  EMDASH_LOG_FILE: join(profile, 'app.log'),
  TELEMETRY_ENABLED: 'false',
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
const closeApp = async () => {
  if (!app) return;
  const child = app.process();
  let timeout;
  try {
    await Promise.race([
      (async () => {
        const exited =
          child.exitCode === null && child.signalCode === null
            ? once(child, 'exit')
            : Promise.resolve();
        await app.evaluate(({ app }) => app.quit()).catch(() => {});
        await exited;
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Isolated app shutdown timed out')), 5000);
      }),
    ]);
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    app = undefined;
  }
};
const openProviders = async () => {
  app = await _electron.launch({
    executablePath: electronPath,
    args: [appRoot],
    env,
    timeout: 30000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForLoadState('domcontentloaded');
  const skip = page.getByRole('button', { name: /暂时跳过|Skip for now/i });
  const settings = page.getByRole('button', { name: /^(Settings|设置)$/ });
  await Promise.race([skip.waitFor(), settings.waitFor()]);
  if (await skip.isVisible()) {
    await skip.click();
    await page
      .getByRole('button', { name: /开始使用|Start shipping|Get started/ })
      .first()
      .click();
  }
  await settings.click();
  await page
    .getByText(/^(Providers|供应商)$/)
    .first()
    .click();
  await page.getByRole('heading', { name: /Agent defaults|Agent 默认设置/ }).waitFor();
  return page;
};
try {
  let page = await openProviders();
  const row = () =>
    page.locator('div.grid').filter({ has: page.getByText('Codex', { exact: true }) });
  const effort = () => row().getByRole('combobox').last();
  await effort().click();
  await page.getByRole('option', { name: /^(High|高)$/ }).click();
  await effort()
    .filter({ hasText: /High|高/ })
    .waitFor();
  await page.screenshot({ path: join(profile, 'effort-saved.png'), fullPage: true });
  await closeApp();
  page = await openProviders();
  assert.match((await effort().textContent()).toLowerCase(), /high|高/);
  await effort().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(profile, 'effort-restored.png'), fullPage: true });
  await effort().click();
  await page.getByRole('option', { name: 'Follow model / agent default' }).click();
  await effort().filter({ hasText: 'Follow model / agent default' }).waitFor();
  await closeApp();
  page = await openProviders();
  assert.match(await effort().textContent(), /Follow model \/ agent default|inherit/);
  await effort().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(profile, 'effort-cleared.png'), fullPage: true });
  await writeFile(
    join(profile, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        checks: [
          'save default effort',
          'restore after application restart',
          'clear and restore adapter default',
        ],
      },
      null,
      2
    )
  );
  console.log(`Default effort UI acceptance passed: ${profile}`);
} catch (error) {
  if (app)
    await (
      await app.firstWindow()
    )
      .screenshot({ path: join(profile, 'failure.png'), fullPage: true })
      .catch(() => {});
  console.error(`Acceptance evidence: ${profile}`);
  throw error;
} finally {
  await closeApp();
}
