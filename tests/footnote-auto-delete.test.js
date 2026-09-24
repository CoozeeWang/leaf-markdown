import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {history,undo,redo} from '@codemirror/commands';
import {footnoteIndex,footnoteRenumber,footnoteReferenceDeletion,footnoteLabelFollow} from '../src/footnote-state.js';
const create=doc=>EditorState.create({doc,extensions:[footnoteIndex,footnoteRenumber,footnoteReferenceDeletion,footnoteLabelFollow,history()]});
const original='甲[^1] 再引[^1] 乙[^2]\n\n[^1]: 第一条\n    续行\n[^2]: 第二条\n[^orphan]: 已有孤立定义';
const remove=(state,marker,event='delete.selection')=>{const from=state.doc.toString().indexOf(marker);return state.update({changes:{from,to:from+marker.length},userEvent:event}).state;};
test('last citation deletes definition, renumbers following note and undoes in one step',()=>{
 let state=remove(create(original),'[^1]');
 assert.ok(state.doc.toString().includes('[^1]: 第一条'));
 const before=state.doc.toString();state=remove(state,'[^1]');
 const deleted=state.doc.toString();
 assert.ok(!deleted.includes('第一条')&&!deleted.includes('续行'));
 assert.ok(deleted.includes('乙[^1]')&&deleted.includes('[^1]: 第二条'));
 assert.ok(deleted.includes('[^orphan]: 已有孤立定义'));
 const target={get state(){return state;},dispatch:tr=>{state=tr.state;}};
 assert.ok(undo(target));assert.equal(state.doc.toString(),before);
 assert.ok(redo(target));assert.equal(state.doc.toString(),deleted);
});
test('cut/paste retains definition and reconnects citation',()=>{
 const text='甲[^1] 乙\n\n[^1]: 保留';
 let state=remove(create(text),'[^1]','delete.cut');
 assert.ok(state.doc.toString().includes('[^1]: 保留'));
 state=state.update({changes:{from:2,insert:'[^1]'},userEvent:'input.paste'}).state;
 assert.equal(state.field(footnoteIndex).notes[0].state,'complete');
 assert.equal(state.field(footnoteIndex).notes[0].def.body,'保留');
});
test('loading, partial marker edits and existing orphans are not cleaned',()=>{
 const text='甲[^name]\n\n[^name]: 保留';
 let state=create(text),at=text.indexOf(']');
 assert.ok(state.update({changes:{from:at,to:at+1},userEvent:'delete.backward'}).newDoc.toString().includes('[^name]: 保留'));
 const loaded=state.update({changes:{from:0,to:state.doc.length,insert:'正文\n\n[^name]: 保留'}}).state;
 assert.ok(loaded.doc.toString().includes('[^name]: 保留'));
});
test('callout block replacements remove only fully erased markers; cuts retain content',()=>{
 const text='> [!NOTE]\n> 甲[^name]乙\n\n[^name]: 内容';
 const end=text.indexOf('\n\n'),insert='> [!NOTE]\n> 甲乙';
 assert.ok(!create(text).update({changes:{from:0,to:end,insert},userEvent:'input'}).newDoc.toString().includes('[^name]:'));
 assert.ok(create(text).update({changes:{from:0,to:end,insert},userEvent:'delete.cut'}).newDoc.toString().includes('[^name]: 内容'));
});
