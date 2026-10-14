import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {history,undo,redo} from '@codemirror/commands';
import {sourceMode} from '../src/view-mode.js';
import {footnoteIndex,footnoteRenumber,footnoteReferenceCompletion,footnoteReferenceDeletion,footnoteLabelFollow,finishFootnoteComposition} from '../src/footnote-state.js';
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
test('typing a label inside existing brackets completes the new inline citation',()=>{
 const original='正文[^1]。\n\n跨段落[]\n\n[^1]: 第一条';
 let state=create(original), at=original.indexOf('[]')+1;
 state=type(state,at,'^');
 state=type(state,at+1,'6');
 assert.equal(state.doc.toString(),original.replace('[]','[^6]'));
 state=state.update({selection:{anchor:at+3},userEvent:'select'}).state;
 assert.equal(state.doc.toString(),'正文[^1]。\n\n跨段落[^2]\n\n[^1]: 第一条\n\n[^2]:');
 const target={get state(){return state;},dispatch:tr=>{state=tr.state;}};
 assert.ok(undo(target));assert.equal(state.doc.toString(),original);
 assert.ok(redo(target));assert.ok(state.doc.toString().endsWith('[^2]:'));
});
test('composition waits until commit and joins completion to the same undo event',()=>{
 const original='甲[^1]。\n\n正文[]\n\n[^1]: A',at=original.indexOf('[]')+1;
 let state=type(create(original),at,'^','input.type.compose.start');
 state=type(state,at+1,'6','input.type.compose');
 assert.equal(state.doc.toString(),original.replace('[]','[^6]'));
 state=state.update({effects:finishFootnoteComposition.of(null),userEvent:'input.type.compose'}).state;
 assert.equal(state.doc.toString(),original.replace('[]','[^6]'));
 state=state.update({selection:{anchor:at+3},userEvent:'select'}).state;
 const completed=original.replace('[]','[^2]')+'\n\n[^2]:';
 assert.equal(state.doc.toString(),completed);
 assert.equal(state.selection.main.head,at+3);
 const target={get state(){return state;},dispatch:tr=>{state=tr.state;}};
 assert.ok(undo(target));assert.equal(state.doc.toString(),original);
 assert.ok(redo(target));assert.equal(state.doc.toString(),completed);
});
test('a label can keep growing inside paired brackets before completion',()=>{
 const original='正文[]';let state=create(original);
 let at=3;
 for(const c of '^66'){state=type(state,at,c);at=state.selection.main.head;}
 assert.equal(state.doc.toString(),'正文[^66]');
 state=state.update({selection:{anchor:at+1},userEvent:'select'}).state;
 assert.equal(state.doc.toString(),'正文[^1]\n\n[^1]:');
});
test('a partial new label never renames an existing note with the same first digit',()=>{
 const original='甲[^1]。\n\n正文[]\n\n[^1]: 原注';let state=create(original),at=original.indexOf('[]')+1;
 for(const c of '^12'){state=type(state,at,c);at=state.selection.main.head;}
 assert.equal(state.doc.toString(),original.replace('[]','[^12]'));
 state=state.update({selection:{anchor:at+1},userEvent:'select'}).state;
 assert.equal(state.doc.toString(),original.replace('[]','[^2]')+'\n\n[^2]:');
});
test('cancelled composition and edits near old undefined references do not add definitions',()=>{
 let state=type(create('正文[]'),3,'^6','input.type.compose.start');
 state=state.update({changes:{from:3,to:5,insert:''},userEvent:'input.type.compose'}).state;
 state=state.update({effects:finishFootnoteComposition.of(null),userEvent:'input.type.compose'}).state;
 assert.equal(state.doc.toString(),'正文[]');
 const original='甲[^old] 乙';
 state=type(create(original),0,'新','input.type.compose.start');
 state=state.update({effects:finishFootnoteComposition.of(null),userEvent:'input.type.compose'}).state;
 assert.equal(state.doc.toString(),'新'+original);
});
