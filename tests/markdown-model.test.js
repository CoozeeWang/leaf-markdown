import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMarkdown, frontmatter, rowCells, scalarSource, titleInsertion } from '../src/markdown-model.js';
import { parser } from '@lezer/markdown';
import { leafMarkdownExtensions } from '../src/markdown-extensions.js';

test('highlight supports inline nesting without interpreting code or escaped delimiters', () => {
  const highlights = text => {
    const found = [];
    parser.configure(leafMarkdownExtensions).parse(text).iterate({ enter(n) { if (n.name === 'LeafHighlight') found.push(text.slice(n.from, n.to)); } });
    return found;
  };
  assert.deepEqual(highlights('==重点 **内容**=='), ['==重点 **内容**==']);
  for (const text of ['`==code==`', '```\n==code==\n```', '\\==literal==', '===text===', '== unfinished', '标题\n======']) assert.deepEqual(highlights(text), [], text);
  assert.deepEqual(highlights('| 列 |\n| --- |\n| ==表格== |'), ['==表格==']);
});

test('properties edit only scalar bytes, leaving comments and unknown structures intact', () => {
  const source = '---\nversion: v0.1 # keep\nupdated: 2026-09-02\nnested:\n  x: 1\n---\n\nBody';
  const fm = frontmatter(source), field = fm.fields[0];
  assert.equal(fm.fields[2].editable, false);
  const edited = source.slice(0, field.from) + scalarSource('v0.2', field.value) + source.slice(field.to);
  assert.ok(edited.includes('version: "v0.2" # keep'));
  assert.ok(edited.endsWith('nested:\n  x: 1\n---\n\nBody'));
});
test('detect real H1s but not YAML or fenced code', () => {
  assert.equal(analyzeMarkdown('---\nversion: v1\n---\n\n## Section').hasH1, false);
  assert.equal(analyzeMarkdown('Title\n======').hasH1, true);
  assert.equal(analyzeMarkdown('```md\n# example\n```').hasH1, false);
  assert.equal(analyzeMarkdown('# Title').hasH1, true);
});
test('title insertion occurs after frontmatter and does not remove it', () => {
  const source = '---\nversion: v1\n---\n\nBody';
  const change = titleInsertion(source, '测试.md');
  assert.equal(source.slice(0, change.from) + change.insert + source.slice(change.from), '---\nversion: v1\n---\n\n# 测试\n\n\n\nBody');
});
test('table cell ranges preserve escaped pipes, blanks, and alignment', () => {
  assert.deepEqual(rowCells('| x\\|y |  |').map(c => c.value), ['x|y', '']);
  const b = analyzeMarkdown('| A | B |\n| --- | ---: |\n| long text | 中文 |').blocks[0];
  assert.equal(b.columns, 2); assert.equal(b.align[1], 'right');
  assert.equal(b.rows[1].cells[1].value, '中文');
});
test('invalid YAML stays available as source', () => {
  assert.equal(frontmatter('---\nx: [\n---').valid, false);
});
test('Markdown between opening rules is not hidden as document properties', () => {
  const source = '---\n# 正文\n\n这是一段正文。\n\n```js\nconst note = { title: "正文" };\n```\n\n---\n\n## 后文';
  assert.equal(frontmatter(source), null);
  assert.equal(analyzeMarkdown(source).hasH1, true);
  assert.equal(analyzeMarkdown(source).headings.length, 2);
  assert.equal(frontmatter('---\n# 属性注释\ntitle: 正文\n---').fields[0].value, '正文');
  assert.equal(frontmatter('---\n# 属性注释\n---').valid, true);
});

test('heading numbers reset children and ignore YAML and code headings', () => {
  const source = '---\ntitle: heading\n---\n# A\n## B\n### C\n## D\n# E\n```\n# not heading\n```\n## F';
  assert.deepEqual(analyzeMarkdown(source).headings.map(h => h.number), ['1.', '1.1', '1.1.1', '1.2', '2.', '2.1']);
});
test('skipped levels follow actual hierarchy; Setext headings count', () => {
  assert.deepEqual(analyzeMarkdown('Title\n=====\n### Child\n## Next\n# End').headings.map(h => h.number), ['1.', '1.1', '1.2', '2.']);
});

test('manual prefixes are detected conservatively without changing source', () => {
  const source = '# 阅读路线\n# 1.这轮研究\n## 1.1 创业命题\n## 1.2 验证\n# 2026 年计划\n## 3.14 的意义';
  const model = analyzeMarkdown(source);
  assert.deepEqual(model.headings.map(h => h.legacyPrefix ? source.slice(h.legacyPrefix.from, h.legacyPrefix.to) : null), [null, '1.', '1.1 ', '1.2 ', null, null]);
  const setext = analyzeMarkdown('1. 章节\n======\n1.1 子节\n------');
  assert.ok(setext.headings.every(h => h.legacyPrefix));
  assert.equal(analyzeMarkdown('# 2026.计划').headings[0].legacyPrefix, undefined);
});
