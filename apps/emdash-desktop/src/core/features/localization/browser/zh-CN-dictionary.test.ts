/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { createUiTranslator } from './ui-translator';
import zhCN from './zh-CN.json';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('zh-CN dictionary', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('translates a provider row, key status included, as the status loads', async () => {
    // How React renders `{n} models · {status} · for {agents}`: one text node per part.
    const row = document.createElement('p');
    for (const part of ['2', ' models · ', 'no key', ' · for', ' ', 'Codex, Pi']) {
      row.appendChild(document.createTextNode(part));
    }
    document.body.appendChild(row);
    const translator = createUiTranslator(zhCN);
    translator.start();
    expect(row.textContent).toBe('2 个模型 · 没有 Key · 用于 Codex, Pi');

    (row.childNodes[2] as Text).data = 'key saved';
    await flush();
    expect(row.textContent).toBe('2 个模型 · Key 已保存 · 用于 Codex, Pi');
    translator.stop();
  });
});
