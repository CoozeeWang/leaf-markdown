import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { history, undo, redo, isolateHistory } from '@codemirror/commands';
import { parser } from '@lezer/markdown';
import { leafMarkdownExtensions } from '../src/markdown-extensions.js';
import { planInlineFormat } from '../src/inline-format.js';

const markdown = parser.configure(leafMarkdownExtensions);
const formats = [['italic', '*', 'Emphasis'], ['bold', '**', 'StrongEmphasis'], ['strike', '~~', 'Strikethrough']];
function apply(source, from, to, type, options) {
  const plan = planInlineFormat(source, from, to, type, options);
  let result = source;
  for (const change of [...(plan?.changes ?? [])].reverse()) result = result.slice(0, change.from) + change.insert + result.slice(change.to);
  return { result, plan };
}
function nodes(source, name) {
  const found = [];
  markdown.parse(source).iterate({ enter(node) {
    if (node.name === name) found.push(source.slice(node.from, node.to));
  } });
  return found;
}

for (const [type, marker, name] of formats) {
  test(`${type}: fixes both Chinese punctuation boundaries, only when necessary`, () => {
    for (const [before, selected, after, left, right] of [
      ['', '重点。', '后文', '', ' '], ['前文', '“重点”', '', ' ', ''],
      ['前文', '“重点。”', '后文', ' ', ' '], ['前文', '重点', '后文', '', ''],
      ['前文 ', '“重点。”', ' 后文', '', ''], ['前文：', '“重点。”', '，后文', '', ''],
      ['😀', '“重点。”', '后文', ' ', ' '],
    ]) {
      const source = before + selected + after;
      const { result } = apply(source, before.length, before.length + selected.length, type);
      assert.equal(result, before + left + marker + selected + marker + right + after);
      assert.deepEqual(nodes(result, name), [marker + selected + marker]);
    }
  });
  test(`${type}: existing whitespace stays outside; selecting the result toggles without duplicate spaces`, () => {
    const source = '前文 \t重点。  后文';
    const { result } = apply(source, 2, source.indexOf('后文'), type);
    assert.equal(result, `前文 \t${marker}重点。${marker}  后文`);
    const marked = marker + '重点。' + marker;
    const start = result.indexOf(marked);
    const plain = apply(result, start, start + marked.length, type).result;
    assert.equal(plain, '前文 \t重点。  后文');
    const spaced = apply('重点。后文', 0, 3, type).result;
    const unmarked = apply(spaced, 0, 3 + marker.length * 2, type).result;
    assert.equal(unmarked, '重点。 后文', 'cancel never guesses which existing spaces are disposable');
    assert.equal(apply(unmarked, 0, 3, type).result, spaced, 'no accumulated spaces');
  });
}

test('whitespace-only selections are unchanged, including empty paragraphs', () => {
  for (const type of ['italic', 'bold', 'strike', 'highlight', 'code']) {
    assert.equal(planInlineFormat('前文 \t  后文', 2, 6, type), null);
    assert.equal(planInlineFormat('\n\n', 0, 2, type), null);
  }
});

test('line and paragraph formatting retains CRLF, structural prefixes and hard breaks', () => {
  const source = '# 标题 #\r\n\r\n正文  \r\n续行\r\n\r\n- [ ] 任务\r\n\r\n> 引用\r\n> 下一行\r\n\r\n结尾';
  const { result } = apply(source, 0, source.length, 'italic');
  assert.equal(result, '# *标题* #\r\n\r\n*正文*  \r\n*续行*\r\n\r\n- [ ] *任务*\r\n\r\n> *引用*\r\n> *下一行*\r\n\r\n*结尾*');
  assert.equal(nodes(result, 'Emphasis').length, 7);
  assert.equal(apply(result, 0, result.length, 'italic').result, source);
});

test('highlights handle whitespace and paragraphs without adding punctuation spaces', () => {
  const source = '前文“重点。”后文\n\n 下一段 ';
  assert.equal(apply(source, 2, source.length, 'highlight').result, '前文==“重点。”后文==\n\n ==下一段== ');
  assert.equal(apply(' “重点。” ', 0, 7, 'highlight').result, ' ==“重点。”== ');
});

test('code uses longer delimiters and removable padding around literal backticks', () => {
  for (const content of ['a`b', 'a``b', '`未闭合', '未闭合`', 'a ``` b', 'a`b``c']) {
    const { result } = apply(content, 0, content.length, 'code');
    assert.deepEqual(nodes(result, 'InlineCode'), [result], content);
    assert.equal(apply(result, 0, result.length, 'code').result, content);
  }
  const source = 'one\n\ntwo';
  assert.equal(apply(source, 0, source.length, 'code').result, '`one`\n\n`two`');
});

test('nested constructs are preserved and separate runs are not mistaken for one wrapper', () => {
  assert.equal(apply('**粗体** 与正文', 0, 10, 'italic').result, '***粗体** 与正文*');
  const source = '**甲** 和 **乙**';
  const { result } = apply(source, 0, source.length, 'bold');
  // If an exact enclosing node cannot be made, do not strip both unrelated ends.
  assert.ok(result.includes('**甲**') && result.includes('**乙**'));
  assert.equal(apply('**甲**', 0, 5, 'bold').result, '甲');
  assert.equal(apply('**甲**', 2, 3, 'bold').result, '甲', 'selecting displayed content cancels the same format');
  assert.equal(apply('前文 *“重点。”* 后文', 4, 9, 'italic').result, '前文 “重点。” 后文');
});

test('literal blocks, properties, URLs and partial code remain untouched', () => {
  const source = '---\ntitle: Sample\n---\n\n正文\n\n```js\nconst value = 1;\n```\n\n    literal\n\n[link]: https://example.com\n';
  const bodyFrom = source.indexOf('正文');
  const { result } = apply(source, 0, source.length, 'bold', { bodyFrom });
  assert.equal(result, source.replace('正文', '**正文**'));
  assert.equal(planInlineFormat(source, 5, 5, 'bold', { bodyFrom }), null);
  assert.equal(planInlineFormat(source, source.indexOf('value'), source.indexOf('value') + 5, 'bold'), null);
  const code = 'before `literal` after';
  assert.equal(planInlineFormat(code, 9, 12, 'italic'), null);
  const link = '[label](https://example.com)';
  assert.equal(planInlineFormat(link, 12, 18, 'bold'), null);
});

test('a single transaction undoes and redoes all paragraph edits and inserted spaces', () => {
  const source = '前文“重点。”后文\n\n下一段。后文';
  let state = EditorState.create({ doc: source, extensions: [history()] });
  const plan = planInlineFormat(source, 2, source.length - 2, 'bold');
  state = state.update({ changes: plan.changes, selection: { anchor: plan.anchor },
    userEvent: 'input', annotations: isolateHistory.of('full') }).state;
  const formatted = state.doc.toString();
  const target = { get state() { return state; }, dispatch(tr) { state = tr.state; } };
  assert.ok(undo(target)); assert.equal(state.doc.toString(), source);
  assert.ok(redo(target)); assert.equal(state.doc.toString(), formatted);
  assert.ok(plan.anchor <= state.doc.length);
});

test('footnote bodies retain formatting commands without editing identifiers or indentation', () => {
  const source = '正文[^sample]\r\n\r\n[^sample]: “重点。”后文\r\n    下一段。后文\r\n\r\n末尾';
  const start = source.indexOf('“重点。”');
  const { result } = apply(source, start, start + 5, 'bold');
  assert.equal(result, source.replace('“重点。”', '**“重点。”** '));
  const all = apply(source, 0, source.length, 'italic').result;
  assert.ok(all.includes('[^sample]: *“重点。”后文*\r\n    *下一段。后文*'));
  assert.equal(apply(all, 0, all.length, 'italic').result, source);
  const literal = '[^sample]: ```js\n    literal\n    ```';
  assert.equal(apply(literal, literal.indexOf('literal'), literal.indexOf('literal') + 7, 'bold').result, literal);
  const short = '[^sample]: 示例';
  const empty = apply(short, short.length, short.length, 'italic');
  assert.equal(empty.result, short + '**');
  assert.equal(empty.plan.anchor, short.length + 1);
});
