/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { resolveUiLanguage } from '../api';
import { createUiTranslator } from './ui-translator';

const dictionary = {
  strings: { Settings: '设置', Delete: '删除', 'Search settings': '搜索设置' },
  patterns: { 'Imported {0} skills': '已导入 {0} 个技能', 'Delete {0}?': '删除 {0}？' },
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createUiTranslator', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('translates text and attributes, keeping whitespace, and restores them on stop', () => {
    document.body.innerHTML = `<button title="Delete"> Settings </button><input placeholder="Search settings"><textarea placeholder="Search settings">Delete</textarea>`;
    const translator = createUiTranslator(dictionary);
    translator.start();
    expect(document.querySelector('button')!.textContent).toBe(' 设置 ');
    expect(document.querySelector('button')!.title).toBe('删除');
    expect(document.querySelector('input')!.placeholder).toBe('搜索设置');
    expect(document.querySelector('textarea')!.placeholder).toBe('搜索设置');
    expect(document.querySelector('textarea')!.textContent).toBe('Delete');

    translator.stop();
    expect(document.body.innerHTML).toBe(
      `<button title="Delete"> Settings </button><input placeholder="Search settings"><textarea placeholder="Search settings">Delete</textarea>`
    );
  });

  it('fills patterns without translating what they capture', () => {
    document.body.innerHTML = `<p>Imported 3 skills</p><p>Delete Settings?</p>`;
    createUiTranslator(dictionary).start();
    const texts = [...document.querySelectorAll('p')].map((p) => p.textContent);
    expect(texts).toEqual(['已导入 3 个技能', '删除 Settings？']);
  });

  it('follows later changes: new nodes, changed text and attributes', async () => {
    const translator = createUiTranslator(dictionary);
    translator.start();
    const span = document.createElement('span');
    span.textContent = 'Delete';
    document.body.append(span);
    await flush();
    expect(span.textContent).toBe('删除');

    span.firstChild!.textContent = 'Settings';
    await flush();
    expect(span.textContent).toBe('设置');

    span.setAttribute('aria-label', 'Delete');
    await flush();
    expect(span.getAttribute('aria-label')).toBe('删除');
  });

  it('leaves content alone: translate="no", code, terminals and editors', () => {
    document.body.innerHTML = `
      <div translate="no"><p>Delete</p><button translate="yes">Settings</button></div>
      <code>Delete</code><div class="xterm"><span>Delete</span></div>`;
    const translator = createUiTranslator(dictionary);
    translator.start();
    expect(document.querySelector('p')!.textContent).toBe('Delete');
    expect(document.querySelector('button')!.textContent).toBe('设置');
    expect(document.querySelector('code')!.textContent).toBe('Delete');
    expect(document.querySelector('.xterm span')!.textContent).toBe('Delete');
  });

  it('translates a sentence React split into several text nodes, and follows its updates', async () => {
    const p = document.createElement('p');
    p.append('Imported ', '3', ' skills');
    document.body.append(p);
    createUiTranslator(dictionary).start();
    expect(p.textContent).toBe('已导入 3 个技能');

    (p.childNodes[1] as Text).data = '4';
    await flush();
    expect(p.textContent).toBe('已导入 4 个技能');

    const mixed = document.createElement('p');
    mixed.append('Delete', ' ', 'now');
    document.body.append(mixed);
    await flush();
    // No whole-sentence entry: each piece on its own.
    expect(mixed.textContent).toBe('删除 now');
  });

  it('reports untranslated text', () => {
    document.body.innerHTML = `<p>Brand new label</p><p>123</p>`;
    const translator = createUiTranslator(dictionary);
    translator.start();
    expect(translator.missing()).toEqual(['Brand new label']);
  });
});

describe('resolveUiLanguage', () => {
  it('follows the system unless a language is chosen', () => {
    expect(resolveUiLanguage('system', ['zh-Hans-CN', 'en'])).toBe('zh-CN');
    expect(resolveUiLanguage('system', ['en-US'])).toBe('en');
    expect(resolveUiLanguage('en', ['zh-CN'])).toBe('en');
    expect(resolveUiLanguage('zh-CN', ['en-US'])).toBe('zh-CN');
  });
});
