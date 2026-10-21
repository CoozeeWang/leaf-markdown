import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createCompositionGuard, isCommittedCompositionInput} from '../src/composition-state.js';

// Exercise the actual production registration and begin/finish methods, with
// synthetic DOM/CodeMirror adapters. This does not emulate a native macOS IME.
const source = readFileSync(new URL('../src/editor.js', import.meta.url), 'utf8');
function harness() {
  const listeners = new Map(), nodes = new Set(), nested = [];
  let focused = true;
  const document = {activeElement: null, hasFocus: () => focused};
  const scope = {ownerDocument: document, contains: node => nodes.has(node),
    addEventListener(name, fn) { const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list); },
    removeEventListener(name, fn) { listeners.set(name, (listeners.get(name) ?? []).filter(f => f !== fn)); },
    querySelectorAll: selector => selector === '.cm-editor' ? nested : [], querySelector: () => null};
  const view = {compositionStarted: false, dispatch() {}, focus() {}, dom: {},
    state: {doc: {toString: () => 'Synthetic unchanged text'}, field: () => 'lf',
      selection: {main: {from: 0, to: 0}}}};
  const content = {isConnected: true, closest: selector => selector === '.cm-content' ? content : null};
  const control = {isConnected: true, closest: selector => selector === 'input,textarea' ? control : null};
  nodes.add(content); nodes.add(control);
  const context = {controlScope: scope, view, document, createCompositionGuard,
    MutationObserver: class {observe() {}}, footnoteBoxView: null, footnoteBox: null, lineEnding: Symbol(),
    AiTaskHistory: class {constructor(task) {this.id = task.task_id;}},
    EditorState: {readOnly: {of: value => value}}, EditorView: {contentAttributes: {of: value => value}}};
  vm.createContext(context);
  const setupStart = source.indexOf('  const observer=new MutationObserver(');
  const setupEnd = source.indexOf("  view.dom.addEventListener('leaf-comment-activate'", setupStart);
  const beginStart = source.indexOf('    beginAiTask(task) {');
  const snapshotStart = source.indexOf('    mcpSnapshot() {');
  const beginEnd = source.indexOf('    async applyMcpBatch', beginStart);
  const finishStart = source.indexOf('    finishAiTask(task) {');
  const finishEnd = source.indexOf('    queryRendererMutation', finishStart);
  assert.ok(setupStart >= 0 && setupEnd > setupStart && beginEnd > beginStart && finishEnd > finishStart);
  vm.runInContext(`let aiTask=null, taskFocus=null, bufferRevision=0;
    const editability={reconfigure:x=>x}, changedControls=new Map();
    const syncLockedControls=()=>{};const options={};
    ${source.slice(setupStart, setupEnd)}
    globalThis.editor={${source.slice(snapshotStart, beginStart)}
      ${source.slice(beginStart, beginEnd)}${source.slice(finishStart, finishEnd)}};
    globalThis.locked=()=>aiTask!==null;`, context);
  const emit = (type, target = content, rest = {}) => {
    for (const fn of listeners.get(type) ?? []) fn({type, target, ...rest});
  };
  const task = id => ({task_id: id, revision: 0});
  return {view, control, content, nested, emit, nodes, task, editor: context.editor,
    locked: context.locked, blur() {focused = false; emit('blur');}, refocus() {focused = true; emit('focus');}};
}

test('CodeMirror internal IME completion without DOM compositionend does not leave a second lock', () => {
  const h = harness(); h.view.compositionStarted = true; h.emit('compositionstart');
  assert.equal(h.editor.mcpSnapshot().content, 'Synthetic unchanged text');
  assert.equal(h.editor.mcpSnapshot().composition.pending, true);
  assert.equal(h.editor.mcpSnapshot().revision, 0);
  assert.throws(() => h.editor.beginAiTask(h.task('pending')), /composition_pending/);
  assert.equal(h.locked(), false);
  // Safari recovery in CodeMirror clears its state without dispatching a DOM event.
  h.view.compositionStarted = false;
  assert.equal(h.editor.beginAiTask(h.task('first')).task_id, 'first');
  h.editor.finishAiTask(h.task('first'));
  assert.equal(h.editor.beginAiTask(h.task('second')).task_id, 'second');
  assert.equal(h.editor.mcpSnapshot().content, 'Synthetic unchanged text');
});

test('nested CodeMirror completion is authoritative after blur/refocus', () => {
  const h = harness(), note = {compositionStarted: true};
  h.nested.push({_leafNoteEditor: {view: note}}); h.emit('compositionstart');
  h.blur(); h.refocus();
  assert.throws(() => h.editor.beginAiTask(h.task('pending')), /composition_pending/);
  note.compositionStarted = false;
  assert.equal(h.editor.beginAiTask(h.task('ready')).task_id, 'ready');
});

test('plain controls reconcile only an explicit committed input, never blur/Esc/app switch', () => {
  const h = harness(); h.emit('compositionstart', h.control);
  h.blur(); h.emit('keydown', h.control, {key: 'Escape'}); h.refocus();
  assert.throws(() => h.editor.beginAiTask(h.task('pending')), /composition_pending/);
  h.emit('input', h.control, {isComposing: false, inputType: 'insertCompositionText'});
  assert.throws(() => h.editor.beginAiTask(h.task('still-pending')), /composition_pending/);
  h.emit('input', h.control, {isComposing: false, inputType: 'insertFromComposition'});
  assert.equal(h.editor.beginAiTask(h.task('ready')).task_id, 'ready');
});

test('compositionend releases a plain control; widgets inside CodeMirror still block', () => {
  const h = harness();
  h.control.closest = selector => selector === '.cm-content' ? h.content : h.control;
  h.emit('compositionstart', h.control);
  assert.throws(() => h.editor.beginAiTask(h.task('pending')), /composition_pending/);
  h.emit('compositionend', h.control);
  assert.equal(h.editor.beginAiTask(h.task('ready')).task_id, 'ready');
});

test('diagnostics are read-only, identify each source, and clean up removed controls/listeners', () => {
  const h = harness(), popup = {_leafComposing: true};
  const guard = createCompositionGuard({scope: {
    ownerDocument: {hasFocus: () => false}, contains: node => h.nodes.has(node),
    querySelectorAll: () => [{_leafNoteEditor: {view: {compositionStarted: true}}}],
    addEventListener() {}, removeEventListener() {},
  }, view: {compositionStarted: true}, popup: () => popup});
  assert.deepEqual(guard.status(), {pending: true,
    sources: ['main-editor', 'nested-editor', 'footnote-popup'], document_focused: false});
  assert.equal(h.locked(), false); guard.destroy();
  const listeners = new Map();
  const scope = {ownerDocument: {}, contains: () => false, querySelectorAll: () => [],
    addEventListener: (n, f) => listeners.set(n, f), removeEventListener: n => listeners.delete(n)};
  const removed = {isConnected: false};
  const plain = createCompositionGuard({scope, view: {compositionStarted: false}});
  listeners.get('compositionstart')({target: removed});
  assert.equal(plain.status().pending, false);
  plain.destroy(); assert.equal(listeners.size, 0);
});

test('a final plain-input commit requires isComposing=false and an explicit commit input type', () => {
  assert.equal(isCommittedCompositionInput({type: 'input', isComposing: false, inputType: 'insertText'}), true);
  for (const event of [{type: 'input', inputType: 'insertText'},
    {type: 'input', isComposing: true, inputType: 'insertText'},
    {type: 'input', isComposing: false, inputType: 'insertCompositionText'},
    {type: 'blur', isComposing: false, inputType: 'insertText'}]) {
    assert.equal(isCommittedCompositionInput(event), false);
  }
});
