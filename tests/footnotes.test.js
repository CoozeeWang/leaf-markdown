import {test} from 'node:test';
import assert from 'node:assert/strict';
import {indexFootnotes, footnoteDefinitionText, footnoteBodyText, notePanelRows, planFootnoteDeletion} from '../src/footnotes.js';

test('explicit deletion removes all uses and multiline duplicate definitions, preserving prose and code', () => {
  const text='A[^a] B[^a] C[^b] `[^a]`\n\n[^a]: first\n    continuation\n\n[^a]: duplicate\n[^b]: keep\n\n```\n[^a]: example\n```';
  let result=text;
  for(const change of planFootnoteDeletion(text,'a').reverse())result=result.slice(0,change.from)+result.slice(change.to);
  assert.ok(result.startsWith('A B C[^b] `[^a]`'));
  assert.ok(result.includes('[^b]: keep'));
  assert.ok(result.includes('```\n[^a]: example\n```'));
  assert.equal(indexFootnotes(result).notes.some(n=>n.id==='a'),false);
  assert.ok(!result.includes('continuation')&&!result.includes('duplicate'));
});

const byId = index => new Map(index.notes.map(note => [note.id, note]));
const shape = note => [note.id, note.number, note.state, note.refs.length, note.def ? note.def.body : null];

// Shared invariant check, also driven by the random-document sweep at the end.
function assertConsistent(text) {
  const {notes} = indexFootnotes(text);

  const numbered = notes.filter(note => note.number !== null);
  assert.deepEqual(numbered.map(note => note.number), numbered.map((_, i) => i + 1), 'numbers run 1..n in order');
  for (const note of numbered) assert.ok(note.refs.length > 0, `${note.id} is numbered so it must be cited`);
  for (const note of notes.filter(note => note.number === null)) {
    assert.equal(note.state, 'unreferenced');
    assert.equal(note.refs.length, 0);
    assert.ok(note.def, 'an unnumbered note can only exist because it was defined');
  }

  const definitions = notes.filter(note => note.def).map(note => note.def).sort((a, b) => a.from - b.from);
  for (let i = 1; i < definitions.length; i++) {
    assert.ok(definitions[i - 1].to <= definitions[i].from, 'definition blocks never overlap');
  }
  for (const def of definitions) {
    assert.equal(text.slice(def.from, def.markerTo), `[^${def.id}]:`, 'marker text');
    assert.ok(def.to >= def.markerTo, 'block ends at or after the marker');
  }

  const references = notes.flatMap(note => note.refs).sort((a, b) => a.from - b.from);
  for (let i = 1; i < references.length; i++) {
    assert.ok(references[i - 1].to <= references[i].from, 'citations never overlap');
  }

  // The panel is the document's own list of notes: every note appears in it once,
  // numbered ones in order, and no row is invented.
  const rows = notePanelRows(indexFootnotes(text));
  assert.deepEqual(rows.map(row => row.label).sort(), notes.map(note => note.id).sort(), 'panel rows cover the notes');
  assert.deepEqual(rows.filter(row => row.number !== null).map(row => row.number), rows.filter(row => row.number !== null).map((_, i) => i + 1), 'panel numbers run 1..n');
  for (const row of rows) assert.equal(row.state === 'complete', row.number !== null, 'only a numbered note is complete');
  for (const ref of references) assert.equal(text.slice(ref.from, ref.to), `[^${ref.id}]`, 'citation text');

  for (const note of notes.filter(note => note.def)) {
    const rebuilt = indexFootnotes(`引用[^${note.id}]\n\n${footnoteDefinitionText(note.id, note.def.body)}\n`);
    assert.equal(rebuilt.notes[0].def.body, note.def.body, `body for ${note.id} must survive a rebuild`);
  }
}

test('indexFootnotes numbers a single citation and reads its definition', () => {
  const {notes, warnings} = indexFootnotes('正文第一句。[^1]\n\n[^1]: 第一条注释\n');
  assert.deepEqual(notes.map(shape), [['1', 1, 'complete', 1, '第一条注释']]);
  assert.deepEqual(warnings, []);
});

test('indexing the same document twice yields the same result', () => {
  const text = '甲[^1] 乙[^2] 丙[^1]\n\n[^1]: 一\n[^2]: 二\n';
  assert.deepEqual(indexFootnotes(text), indexFootnotes(text));
});

test('numbering follows the first citation, not the definition order', () => {
  const {notes} = indexFootnotes('[^b]: 后定义的\n[^a]: 先定义的\n\n引用甲[^b] 引用乙[^a]\n');
  assert.deepEqual(notes.map(shape), [['b', 1, 'complete', 1, '后定义的'], ['a', 2, 'complete', 1, '先定义的']]);
});

test('citations repeat without renumbering', () => {
  const {notes} = indexFootnotes('甲[^1] 乙[^2] 丙[^1]\n\n[^1]: 一\n[^2]: 二\n');
  assert.deepEqual(notes.map(note => [note.id, note.number, note.refs.length]), [['1', 1, 2], ['2', 2, 1]]);
});

test('indented continuation lines stay inside the definition', () => {
  const text = '引用。[^1]\n\n[^1]: 第一段\n    第二行\n    - 列表项\n\n下一段正文。\n';
  const note = byId(indexFootnotes(text)).get('1');
  assert.equal(note.def.body, '第一段\n第二行\n- 列表项');
  assert.equal(text.slice(note.def.from, note.def.to), '[^1]: 第一段\n    第二行\n    - 列表项');
});

test('a blank line only continues the definition when an indented line follows', () => {
  const text = '引用。[^1]\n\n[^1]: 甲\n\n    乙\n\n不是缩进的一段。\n';
  const note = byId(indexFootnotes(text)).get('1');
  assert.equal(note.def.body, '甲\n\n乙');
  assert.equal(text.slice(note.def.to), '\n\n不是缩进的一段。\n');
});

test('a marker with nothing on its line puts the body on the next line', () => {
  const note = byId(indexFootnotes('引用。[^4]\n\n[^4]:\n    正文另起一行\n')).get('4');
  assert.equal(note.def.body, '\n正文另起一行');
  assert.equal(note.state, 'complete');
});

test('an empty definition is allowed and stays complete', () => {
  const note = byId(indexFootnotes('引用。[^2]\n\n[^2]:\n')).get('2');
  assert.equal(note.def.body, '');
  assert.equal(note.state, 'complete');
});

test('a citation with no definition is reported as undefined', () => {
  const {notes} = indexFootnotes('引用。[^x]\n');
  assert.deepEqual(notes.map(shape), [['x', 1, 'undefined', 1, null]]);
});

test('definitions nobody cites trail the list unnumbered', () => {
  const {notes} = indexFootnotes('引用。[^1]\n\n[^1]: 有引用\n[^9]: 没人引用\n');
  assert.deepEqual(notes.map(shape), [['1', 1, 'complete', 1, '有引用'], ['9', null, 'unreferenced', 0, '没人引用']]);
});

test('the definition marker is never counted as a citation', () => {
  const {notes} = indexFootnotes('[^1]: 内容\n\n引用[^1]\n');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].refs.length, 1);
  assert.equal(notes[0].refs[0].line, 3);
});

test('a repeated definition keeps the first and warns about the rest', () => {
  const {notes, warnings} = indexFootnotes('引用[^1]\n\n[^1]: 第一个\n[^1]: 第二个\n');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].def.body, '第一个');
  assert.deepEqual(warnings, [{code: 'duplicate-definition', id: '1', line: 4}]);
});

test('code never contributes citations or definitions', () => {
  const text = [
    '正文。[^1]',
    '',
    '```js',
    '[^8]: 围栏内的定义',
    '围栏内引用 [^8]',
    '```',
    '',
    '行内 `[^9]` 与 `[^9]: 定义`',
    '',
    '    缩进代码块 [^7]',
    '',
    '[^1]: 真的定义',
    '',
  ].join('\n');
  const {notes} = indexFootnotes(text);
  assert.deepEqual(notes.map(note => note.id), ['1']);
  assert.equal(notes[0].def.body, '真的定义');
});

test('citations inside tables, callouts and block quotes still count', () => {
  const text = [
    '| 表头 |',
    '| --- |',
    '| 格子[^t] |',
    '',
    '> 引用块[^q]',
    '',
    '> [!note] 标题',
    '> callout 里[^c]',
    '',
    '[^t]: 表',
    '[^q]: 引',
    '[^c]: 呼',
    '',
  ].join('\n');
  const {notes} = indexFootnotes(text);
  assert.deepEqual(notes.map(note => [note.id, note.number, note.state]),
    [['t', 1, 'complete'], ['q', 2, 'complete'], ['c', 3, 'complete']]);
});

test('link references and escaped brackets are not footnotes', () => {
  assert.deepEqual(indexFootnotes('[1]: https://example.com\n\n见 [1]。\n').notes, []);
  assert.deepEqual(indexFootnotes('转义 \\[^1\\] 不算。\n').notes, []);
});

test('definitions nested in a block quote are out of scope for now', () => {
  const {notes} = indexFootnotes('> [^1]: 引号里的定义\n\n引用[^1]\n');
  assert.deepEqual(notes.map(note => [note.id, note.state]), [['1', 'undefined']]);
});

test('a canonical body survives a rebuild', () => {
  for (const body of ['单行', '第一段\n第二行', '甲\n\n乙', '\n另起一行', '', '- 列表\n- 第二项']) {
    const note = byId(indexFootnotes(`引用。[^1]\n\n${footnoteDefinitionText('1', body)}\n`)).get('1');
    assert.equal(note.def.body, body, JSON.stringify(body));
  }
});

test('footnoteDefinitionText indents only what continues the block', () => {
  assert.equal(footnoteDefinitionText('1', '第一段\n第二行'), '[^1]: 第一段\n    第二行');
  assert.equal(footnoteDefinitionText('1', '甲\n\n乙'), '[^1]: 甲\n\n    乙');
  assert.equal(footnoteDefinitionText('1', ''), '[^1]:');
  assert.equal(footnoteDefinitionText('1', '\n另起一行'), '[^1]:\n    另起一行');
});

// The last line of the note box is where the caret is, not something written: a
// body that ends on a newline must not leave a blank line in the file, where it
// would end the definition above it and read as an empty paragraph.
test('a body ending on a newline writes no blank line', () => {
  assert.equal(footnoteBodyText('甲\n'), '甲');
  assert.equal(footnoteBodyText('甲\n\n'), '甲\n');
  assert.equal(footnoteDefinitionText('1', '甲\n'), '[^1]: 甲');
  assert.equal(footnoteDefinitionText('1', '甲\n\n'), '[^1]: 甲\n');
  // An empty line between lines is a paragraph break and survives.
  assert.equal(footnoteDefinitionText('1', '甲\n\n乙\n'), '[^1]: 甲\n\n    乙');
});

// The panel lists what the document holds, in reading order, and keeps the notes
// it has lost track of: a definition nobody cites, and a citation whose
// definition was never written. Neither has a number, and both are still words
// the author can see and fix, so neither may fall out of the list.
test('notePanelRows lists numbered notes in order and keeps the strays', () => {
  const rows = notePanelRows(indexFootnotes(
    '丙[^c] 甲[^a] 乙[^b] 悬空[^d]\n\n[^a]: A\n[^b]: B\n[^c]: C\n[^orphan]: 没人引用\n'));
  assert.deepEqual(rows.map(row => [row.label, row.number, row.body, row.state]), [
    ['c', 1, 'C', 'complete'],
    ['a', 2, 'A', 'complete'],
    ['b', 3, 'B', 'complete'],
    ['d', null, '', 'undefined'],
    ['orphan', null, '没人引用', 'unreferenced'],
  ]);
});

test('notePanelRows is empty for a document without notes', () => {
  assert.deepEqual(notePanelRows(indexFootnotes('只有正文。\n')), []);
  assert.deepEqual(notePanelRows(indexFootnotes('引用[^1] 但没有定义。\n')).map(row => row.state), ['undefined']);
});

test('random documents keep the index self-consistent', () => {
  const tokens = ['a', ' ', '\n', '\n\n', '[^1]', '[^2]', '[^x]', '[^1]: 定义', '[^1]:', '[^2]: 二',
    '    续行', '    缩进代码', '`[^1]`', '```\n', '```', '| 表[^2] |', '> 引[^1]', '\\[^1\\]'];
  let seed = 20260910;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let n = 0; n < 800; n++) {
    let text = '';
    for (let i = 0, len = 1 + Math.floor(random() * 14); i < len; i++) text += tokens[Math.floor(random() * tokens.length)];
    assertConsistent(text);
  }
});
