import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { _electron } from 'playwright';
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(join(tmpdir(), 'emdash-gateway-smoke-'));
const env = {
  ...process.env,
  EMDASH_USER_DATA_DIR: profile,
  EMDASH_DB_FILE: join(profile, 'scratch.db'),
  TELEMETRY_ENABLED: 'false',
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({
  executablePath: electronPath,
  args: [appRoot],
  env,
  timeout: 30000,
});
const diagnostics = [];
app.process().stderr?.on('data', (value) => diagnostics.push(value.toString()));
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForLoadState('domcontentloaded');
  const skip = page.getByRole('button', { name: /暂时跳过|Skip for now/i });
  await skip.waitFor({ state: 'visible' });
  await skip.click();
  await page
    .getByRole('button', { name: /开始使用|Start shipping|Get started/ })
    .first()
    .click();
  await page.waitForTimeout(1000);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  await page.getByText('Providers', { exact: true }).first().click();
  await page.getByRole('heading', { name: /Local routing|本地路由/ }).waitFor();
  await page
    .getByRole('status')
    .filter({ hasText: /Running|运行/ })
    .first()
    .waitFor();
  assert.equal(
    app
      .context()
      .pages()
      .filter((candidate) => candidate.url().startsWith('http://127.0.0.1:')).length,
    0,
    'Providers opened a nested management website'
  );
  for (const [name, protocol] of [
    ['Responses preview', 'OpenAI Responses'],
    ['Chat preview', 'OpenAI Chat Completions'],
    ['Messages preview', 'Anthropic Messages'],
  ]) {
    await page
      .getByRole('button', { name: /^(Add provider|添加 Provider|添加.*商|新增.*商)$/ })
      .click();
    await page.getByPlaceholder('DeepSeek', { exact: true }).fill(name);
    await page
      .getByRole('combobox')
      .filter({
        hasText:
          /Anthropic Messages|OpenAI Responses|OpenAI Chat Completions|Multiple protocols|多协议/,
      })
      .first()
      .click();
    await page.getByRole('option').first().waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('option').count(), 4);
    await page
      .getByRole('option')
      .nth(protocol === 'Anthropic Messages' ? 0 : protocol === 'OpenAI Chat Completions' ? 1 : 2)
      .click();
    await page
      .getByPlaceholder('https://api.example.com', { exact: true })
      .fill('https://fake-ui-provider.example' + (protocol === 'Anthropic Messages' ? '' : '/v1'));
    await page.getByPlaceholder('sk-…', { exact: true }).fill('fake-ui-key');
    await page.getByPlaceholder(/Add a model|手动.*模型|模型.*ID/).fill('test-model');
    await page.getByRole('button', { name: /^(Add|添加)$/ }).click();
    await page.getByRole('button', { name: /^(Save|保存)$/ }).click();
    await page.getByText(name, { exact: true }).first().waitFor();
  }
  await page.getByRole('button', { name: /^(Add provider|添加 Provider)$/ }).click();
  await page.getByPlaceholder('DeepSeek', { exact: true }).fill('Unified preview');
  await page
    .getByPlaceholder('https://api.example.com', { exact: true })
    .fill('https://shared.example/v1');
  await page
    .getByLabel('Anthropic Messages URL', { exact: true })
    .fill('https://messages.example/anthropic');
  await page
    .getByLabel('OpenAI Chat Completions URL', { exact: true })
    .fill('https://chat.example/v1');
  await page
    .getByLabel('OpenAI Responses URL', { exact: true })
    .fill('https://responses.example/v1');
  await page
    .getByRole('combobox')
    .filter({ hasText: /Automatic|自动/ })
    .click();
  await page.getByRole('option', { name: 'OpenAI Responses', exact: true }).click();
  await page.getByPlaceholder('sk-…', { exact: true }).fill('fake-visible-shared');
  await page.getByLabel(/^Anthropic Messages API [Kk]ey$/).fill('fake-visible-messages');
  await page.getByPlaceholder(/Add a model|手动.*模型|模型.*ID/).fill('test-model');
  await page.getByRole('button', { name: /^(Add|添加)$/ }).click();
  await page.getByRole('button', { name: /^(Save|保存)$/ }).click();
  await page.getByText('Unified preview', { exact: true }).waitFor();
  await page
    .getByText('Unified preview', { exact: true })
    .locator('..')
    .locator('..')
    .getByRole('button', { name: /Edit|编辑/ })
    .click();
  const sharedKey = page.getByPlaceholder('sk-…', { exact: true });
  await page.waitForFunction(
    () => document.querySelector('input[placeholder="sk-…"]')?.value === 'fake-visible-shared'
  );
  assert.equal(await sharedKey.getAttribute('type'), 'text');
  assert.equal(
    await page.getByPlaceholder('https://api.example.com', { exact: true }).inputValue(),
    'https://shared.example/v1'
  );
  assert.equal(await page.getByRole('combobox').filter({ hasText: 'OpenAI Responses' }).count(), 1);
  assert.equal(
    await page.getByLabel(/^Anthropic Messages API [Kk]ey$/).inputValue(),
    'fake-visible-messages'
  );
  await sharedKey
    .locator('..')
    .getByRole('button', { name: /Copy|复制/ })
    .click();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'fake-visible-shared');
  await page.getByRole('button', { name: /^(Cancel|取消)$/ }).click();
  await page
    .getByRole('heading', { name: /Providers|供应商/ })
    .first()
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(profile, 'providers.png') });
  await page.getByRole('button', { name: /Gateway accounts|网关账号|路由授权账号/ }).click();
  await page.getByRole('button', { name: /Connect Codex OAuth|连接 Codex OAuth/ }).waitFor();
  await page.getByRole('button', { name: /Connect Claude OAuth|连接 Claude OAuth/ }).waitFor();
  await page.screenshot({ path: join(profile, 'accounts.png') });
  console.log(`Unified Providers UI smoke passed. Isolated profile and screenshots: ${profile}`);
} catch (error) {
  const page = app
    .context()
    .pages()
    .find((p) => !p.url().startsWith('devtools:'));
  if (page) {
    console.error((await page.locator('body').innerText()).slice(-9000));
    await page.screenshot({ path: join(profile, 'failure.png') });
  }
  throw error;
} finally {
  await Promise.race([app.close(), new Promise((done) => setTimeout(done, 8000))]);
  if (app.process().exitCode === null) app.process().kill('SIGKILL');
  await writeFile(join(profile, 'stderr.log'), diagnostics.join(''));
}
