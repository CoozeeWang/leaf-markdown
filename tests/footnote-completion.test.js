import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {history,undo,redo} from '@codemirror/commands';
import {sourceMode} from '../src/view-mode.js';
import {footnoteIndex,footnoteRenumber,footnoteReferenceCompletion,footnoteReferenceDeletion,footnoteLabelFollow} from '../src/footnote-state.js';
const create=(doc,source=false)=>EditorState.create({doc,extensions:[sourceMode.init(()=>source),footnoteIndex,footnoteRenumber,footnoteReferenceCompletion,footnoteReferenceDeletion,footnoteLabelFollow,history()]});
const type=(state,at,insert,userEvent='input.type')=>state.update({changes:{from:at,insert},selection:{anchor:at+insert.length},userEvent}).state;
test('typed closing bracket creates an ordered empty definition and preserves caret, undo and redo',()=>{
 const original='甲[^1] 中间[^Test 乙[^2]\n\n[^1]: A\n[^2]: B';
 let state=create(original),at=original.indexOf(' 乙');
 state=type(state,at,']');
 const expected='甲[^1] 中间[^Test] 乙[^3]\n\n[^1]: A\n[^Test]:\n[^3]: B';
 assert.equal(state.doc.toString(),expected);
 assert.equal(state.selection.main.head,at+1);
 assert.equal(state.field(footnoteIndex).notes.find(n=>n.id==='Test').state,'complete');
 const target={get state(){return state;},dispatch:tr=>{state=tr.state;}};
 assert.ok(undo(target)); assert.equal(state.doc.toString(),original);
 assert.ok(redo(target)); assert.equal(state.doc.toString(),expected);
});
test('highlighted inline numeric citation becomes a complete note',()=>{
 const original='==高亮正文[^6=='; const state=type(create(original),original.indexOf('==',2),']');
 assert.equal(state.doc.toString(),'==高亮正文[^1]==\n\n[^1]:');
});
test('loading, paste, source, code, metadata, existing undefined citations and potential definitions retain source',()=>{
 for (const [text,at,source,event] of [
  ['正文',2,false,'input.paste'],['正文',2,true,'input.type'],
  ['代码 `[^name`',10,false,'input.type'],
  ['```\n[^name\n```',10,false,'input.type'],
  ['---\nkey: "[^name"\n---\n正文',16,false,'input.type'],
  ['[^name',6,false,'input.type'],
 ]) {
  const state=create(text,source),insert=event==='input.paste'?'[^name]':']';
  assert.equal(type(state,at,insert,event).doc.toString(),text.slice(0,at)+insert+text.slice(at));
 }
 const missing='正文[^name]';
 assert.equal(create(missing).doc.toString(),missing);
 assert.equal(type(create(missing),missing.length,']').doc.toString(),missing+']');
});
test('another reference reuses the existing definition',()=>{
 const original='正文[^name] 另一处[^name\n\n[^name]: 内容',at=original.indexOf('\n');
 assert.equal(type(create(original),at,']').doc.toString(),original.slice(0,at)+']'+original.slice(at));
});
