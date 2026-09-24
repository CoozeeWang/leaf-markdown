import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {history, undoDepth, isolateHistory} from '@codemirror/commands';
import {indexFootnotes, labelPartAt, planLabelFollow} from '../src/footnotes.js';
import {footnoteIndex, footnoteLabelFollow} from '../src/footnote-state.js';

function apply(text, changes) {
  let out = '', at = 0;
  for (const change of changes) { out += text.slice(at, change.from) + change.insert; at = change.to; }
  return out + text.slice(at);
}

// The range a tool would rewrite: the label inside the brackets, never the
// brackets themselves, so a citation keeps its shape and a definition its colon.
// The needle may be either shape -- `[^2]` or `[^2]:` -- what counts is where its
// closing bracket sits.
function labelRange(text, needle) {
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `找不到 ${needle}`);
  return [at + 2, at + needle.indexOf(']')];
}

// One or more edits, stated the way a transaction states them: what each one
// replaced, in the document before and in the document after.
function edit(text, ...list) {
  const sorted = [...list].sort((a, b) => a.from - b.from);
  let after = '', at = 0, delta = 0;
  const spans = [];
  for (const change of sorted) {
    after += text.slice(at, change.from) + change.insert;
    spans.push({fromA: change.from, toA: change.to, fromB: change.from + delta, toB: change.from + delta + change.insert.length});
    delta += change.insert.length - (change.to - change.from);
    at = change.to;
  }
  return {after: after + text.slice(at), spans};
}

const FOLLOWED = '甲[^1] 乙[^READ] 丙[^3]\n\n[^1]: test\n[^READ]: 注释\n[^3]: This is a test.\n';

test('改写正文里的标记，文末的定义跟着改名', () => {
  const text = '甲[^1] 乙[^2] 丙[^3]\n\n[^1]: test\n[^2]: 注释\n[^3]: This is a test.\n';
  const [from, to] = labelRange(text, '[^2]');
  const {after, spans} = edit(text, {from, to, insert: 'READ'});
  const plan = planLabelFollow(indexFootnotes(text), after, spans);
  assert.equal(apply(after, plan), FOLLOWED);
});

test('一个字一个字地打，每一步都跟着走', () => {
  let text = '甲[^2]\n\n[^2]: 注释\n';
  let label = '2';
  for (const next of ['R', 'RE', 'REA', 'READ']) {
    const at = text.indexOf('[^') + 2;
    const step = edit(text, {from: at, to: at + label.length, insert: next});
    text = apply(step.after, planLabelFollow(indexFootnotes(text), step.after, step.spans));
    assert.ok(text.includes(`[^${next}]: 注释`), `打到 ${next} 时定义没跟上：${JSON.stringify(text)}`);
    assert.ok(!text.includes(`[^${label}]:`), '旧定义不该留下');
    label = next;
  }
  assert.equal(text, '甲[^READ]\n\n[^READ]: 注释\n');
});

test('改写定义的名字，正文里的每个标记都跟着改', () => {
  const text = '甲[^2] 乙[^2]\n\n[^2]: 注释\n';
  const [from, to] = labelRange(text, '[^2]: 注释');
  const {after, spans} = edit(text, {from, to, insert: 'READ'});
  const plan = planLabelFollow(indexFootnotes(text), after, spans);
  assert.equal(apply(after, plan), '甲[^READ] 乙[^READ]\n\n[^READ]: 注释\n');
});

test('新名字已经有定义时不动手，合并是作者自己的事', () => {
  const text = '甲[^2] 乙[^READ]\n\n[^2]: 注释\n[^READ]: 别的\n';
  const [from, to] = labelRange(text, '[^2] ');
  const {after, spans} = edit(text, {from, to, insert: 'READ'});
  assert.deepEqual(planLabelFollow(indexFootnotes(text), after, spans), []);
});

test('老名字还有别的引用时不动手，那是在拆一条注释', () => {
  const text = '甲[^2] 乙[^2]\n\n[^2]: 注释\n';
  const [from, to] = labelRange(text, '[^2]');
  const {after, spans} = edit(text, {from, to, insert: 'READ'});
  assert.deepEqual(planLabelFollow(indexFootnotes(text), after, spans), []);
});

test('标记被删空、还不成一条引用，就没什么可跟', () => {
  const text = '甲[^2]\n\n[^2]: 注释\n';
  const [from, to] = labelRange(text, '[^2]');
  const {after, spans} = edit(text, {from, to, insert: ''});
  assert.deepEqual(planLabelFollow(indexFootnotes(text), after, spans), []);
});

test('跟的是这次改动落在的那条注释，不是文档里谁的编号对不上', () => {
  // A definition nobody cites is already lying around. The rename has to take
  // the definition of the note it happened in, not the stray one.
  const text = '甲[^1] 乙[^2]\n\n[^1]: A\n[^2]: 注释\n[^OLD]: 没人引用的旧定义\n';
  const [from, to] = labelRange(text, '[^2]');
  const {after, spans} = edit(text, {from, to, insert: 'READ'});
  const plan = planLabelFollow(indexFootnotes(text), after, spans);
  assert.equal(apply(after, plan), '甲[^1] 乙[^READ]\n\n[^1]: A\n[^READ]: 注释\n[^OLD]: 没人引用的旧定义\n');
});

test('没有落在标记或定义上的改动，一律原样放行', () => {
  const text = '甲[^1] 乙[^2]\n\n[^1]: A\n[^2]: B\n';
  const state = EditorState.create({doc: text, extensions: [footnoteIndex, footnoteLabelFollow, history()]});
  const next = state.update({changes: {from: 0, to: 1, insert: '乙'}, userEvent: 'input.type'}).state.doc.toString();
  assert.equal(next, '乙[^1] 乙[^2]\n\n[^1]: A\n[^2]: B\n');
});

test('标记与定义一起改，是一笔事务，一次撤销就回去', () => {
  const text = '甲[^1] 乙[^2] 丙[^3]\n\n[^1]: test\n[^2]: 注释\n[^3]: This is a test.\n';
  const state = EditorState.create({doc: text, extensions: [footnoteIndex, footnoteLabelFollow, history()]});
  const [from, to] = labelRange(text, '[^2]');
  const tr = state.update({
    changes: {from, to, insert: 'READ'},
    selection: {anchor: from + 4},
    userEvent: 'input.type',
    annotations: isolateHistory.of('full'),
  });
  assert.equal(tr.state.doc.toString(), FOLLOWED);
  assert.equal(undoDepth(tr.state), 1, '一次撤销要能回到改之前');
  // Annotations are what the undo history groups by, so they have to survive the
  // transaction being handed back with one more change in it.
  assert.ok(tr.isUserEvent('input.type'));
  assert.equal(tr.annotation(isolateHistory), 'full');
});

test('定义写在句子上面时，光标被它推着走，不会停在旧位置', () => {
  const text = '[^2]: 注释\n\n甲[^2] 丙\n';
  const state = EditorState.create({doc: text, extensions: [footnoteIndex, footnoteLabelFollow, history()]});
  const [from, to] = labelRange(text, '[^2] 丙');   // 正文里那条，不是上面那条定义
  const after = from + 4;                            // 新名字写完时，光标就在它后面
  const tr = state.update({changes: {from, to, insert: 'READ'}, selection: {anchor: after}, userEvent: 'input.type'});
  assert.equal(tr.state.doc.toString(), '[^READ]: 注释\n\n甲[^READ] 丙\n');
  assert.equal(tr.state.selection.main.head, after + 3, '定义在光标上面，它长出来的三个字要把光标推走');
});

test('labelPartAt 认得出改动落在引用还是定义上', () => {
  const text = '甲[^2] 丙\n\n[^2]: 注释\n';
  const index = indexFootnotes(text);
  const [cite] = labelRange(text, '[^2]');
  const [def] = labelRange(text, '[^2]:');
  assert.deepEqual(labelPartAt(index, cite, cite + 1), {id: '2', part: 'citation'});
  assert.deepEqual(labelPartAt(index, def, def + 1), {id: '2', part: 'definition'});
  assert.equal(labelPartAt(index, 0, 1), null);
});
