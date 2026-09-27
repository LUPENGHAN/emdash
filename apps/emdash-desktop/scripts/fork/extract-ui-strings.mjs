#!/usr/bin/env node
// Lists the English UI strings in the renderer and @emdash/ui sources, for the zh-CN
// dictionary of the UI translation layer (src/core/features/localization).
//
//   node scripts/fork/extract-ui-strings.mjs            # all strings, JSON array
//   node scripts/fork/extract-ui-strings.mjs --missing  # strings the dictionary lacks
//
// Strings with interpolations come out as patterns: `Imported {0} skills`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoDir = path.resolve(appDir, '../..');
const roots = [
  path.join(appDir, 'src'),
  path.join(repoDir, 'packages/ui/src'),
  path.join(repoDir, 'packages/chat-ui/src'),
];
const dictionaryPath = path.join(appDir, 'src/core/features/localization/browser/zh-CN.json');

const SKIP_PATH =
  /\/(node|main|preload|tests?|__tests__|fixtures)\/|\.(test|stories|spec|browser\.test)\.|\.d\.ts$/;
const TEXT_PROPS = new Set([
  'label',
  'title',
  'description',
  'placeholder',
  'message',
  'confirmLabel',
  'cancelLabel',
  'tooltip',
  'text',
  'heading',
  'subtitle',
  'emptyText',
  'emptyMessage',
  'hint',
  'ariaLabel',
  'aria-label',
  'detail',
  'body',
  'caption',
  'helpText',
  'actionLabel',
  'buttonLabel',
  'submitLabel',
  'loadingLabel',
  'displayName',
  'shortDescription',
  'summary',
  'content',
  'reason',
  'status',
  'error',
]);
const NON_TEXT_ATTRS = new Set([
  'className',
  'class',
  'id',
  'key',
  'type',
  'href',
  'src',
  'name',
  'value',
  'defaultValue',
  'variant',
  'size',
  'side',
  'align',
  'role',
  'rel',
  'target',
  'autoComplete',
  'appearance',
  'width',
  'height',
  'viewBox',
  'd',
  'fill',
  'stroke',
  'mode',
  'orientation',
  'lang',
  'htmlFor',
  'form',
  'tabId',
  'testId',
  'data-testid',
]);
const TEXT_CALLS =
  /(^|\.)(toast|success|error|warning|info|message|setError|setTestState|setStatus|setMessage|confirm|alert|notify)$/;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (/\.(ts|tsx)$/.test(name) && !SKIP_PATH.test(full)) yield full;
  }
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  rarr: '→',
  larr: '←',
  times: '×',
};
function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/** JSX text as React renders it: lines trimmed and joined by single spaces. */
function jsxTextValue(raw) {
  if (!raw.includes('\n')) return decodeEntities(raw);
  const lines = raw.split('\n');
  const kept = lines
    .map((line, index) => {
      let out = line;
      if (index > 0) out = out.replace(/^\s+/, '');
      if (index < lines.length - 1) out = out.replace(/\s+$/, '');
      return out;
    })
    .filter((line) => line.length > 0);
  return decodeEntities(kept.join(' '));
}

/**
 * A JSX element's text-only children as one sentence (`Imported {0} skills`), the way
 * the translator joins sibling text nodes. Null when a child is markup.
 */
function jsxSentence(element) {
  let out = '';
  let index = 0;
  let hasExpression = false;
  for (const child of element.children) {
    if (ts.isJsxText(child)) {
      if (child.containsOnlyTriviaWhiteSpaces) continue;
      out += jsxTextValue(child.text);
    } else if (ts.isJsxExpression(child)) {
      const expression = child.expression;
      if (!expression) continue;
      if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
        out += expression.text;
      } else {
        let jsx = false;
        const scan = (node) => {
          if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))
            jsx = true;
          else ts.forEachChild(node, scan);
        };
        scan(expression);
        if (jsx) return null;
        out += `{${index++}}`;
        hasExpression = true;
      }
    } else {
      return null;
    }
  }
  return hasExpression ? out : null;
}

function looksLikeText(value) {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!/[A-Za-z]{2,}/.test(text)) return null;
  if (/^(https?:|\/|\.\/|@|#|--|[a-z0-9]+:\/\/)/.test(text)) return null;
  // Identifiers, css classes, keys and ids.
  if (/^[a-z][\w.:/-]*$/.test(text)) return null;
  // Tailwind class lists.
  if (
    !/[.?!,]/.test(text) &&
    /(^|\s)(flex|grid|px-|py-|text-|bg-|w-|h-|gap-|rounded|border|items-|justify-)/.test(text)
  )
    return null;
  if (/^[A-Z_][A-Z0-9_]+$/.test(text)) return null;
  return text;
}

function templatePattern(node) {
  let out = node.head.text;
  node.templateSpans.forEach((span, index) => {
    out += `{${index}}${span.literal.text}`;
  });
  return out;
}

/** Whether a string node sits somewhere its text is shown to the user. */
function isUiPosition(node) {
  let child = node;
  let parent = node.parent;
  // Climb through ?:, ??, ||, parentheses, `as`, arrays and JSX expression wrappers.
  while (
    parent &&
    (ts.isConditionalExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      (ts.isBinaryExpression(parent) &&
        [
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.AmpersandAmpersandToken,
        ].includes(parent.operatorToken.kind) &&
        parent.right === child))
  ) {
    if (ts.isConditionalExpression(parent) && parent.condition === child) return false;
    child = parent;
    parent = parent.parent;
  }
  if (!parent) return false;
  if (ts.isJsxExpression(parent)) {
    const owner = parent.parent;
    if (ts.isJsxAttribute(owner))
      return !NON_TEXT_ATTRS.has(owner.name.getText()) && !owner.name.getText().startsWith('data-');
    return ts.isJsxElement(owner) || ts.isJsxFragment(owner);
  }
  if (ts.isJsxAttribute(parent)) {
    const name = parent.name.getText();
    return !NON_TEXT_ATTRS.has(name) && !name.startsWith('data-') && !name.startsWith('on');
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === child) {
    return TEXT_PROPS.has(parent.name.getText().replace(/['"]/g, ''));
  }
  if (ts.isCallExpression(parent) && parent.arguments.includes(child)) {
    const callee = parent.expression.getText();
    return TEXT_CALLS.test(callee) || /toast/.test(callee);
  }
  if (ts.isNewExpression(parent) && parent.expression.getText() === 'Error') return true;
  if (ts.isReturnStatement(parent)) return true;
  return false;
}

const found = new Set();
for (const root of roots) {
  for (const file of files(root)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const visit = (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isJsxElement(node)) {
        const sentence = jsxSentence(node);
        const text = sentence && looksLikeText(sentence);
        if (text && /[A-Za-z]{2,}/.test(text.replace(/\{\d+\}/g, ''))) found.add(text);
      }
      if (ts.isJsxText(node)) {
        const text = looksLikeText(jsxTextValue(node.text));
        if (text) found.add(text);
      } else if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        isUiPosition(node)
      ) {
        const text = looksLikeText(node.text);
        if (text) found.add(text);
      } else if (ts.isTemplateExpression(node) && isUiPosition(node)) {
        const text = looksLikeText(templatePattern(node));
        if (text && /[A-Za-z]{2,}/.test(text.replace(/\{\d+\}/g, ''))) found.add(text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

let strings = [...found].sort((a, b) => a.localeCompare(b));
if (process.argv.includes('--missing')) {
  const dictionary = JSON.parse(readFileSync(dictionaryPath, 'utf8'));
  strings = strings.filter(
    (text) => !(text in dictionary.strings) && !(text in dictionary.patterns)
  );
}
process.stdout.write(`${JSON.stringify(strings, null, 1)}\n`);
