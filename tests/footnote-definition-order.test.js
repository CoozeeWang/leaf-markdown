import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {history,undo,redo} from '@codemirror/commands';
import {footnoteIndex,footnoteRenumber,footnoteReferenceDeletion,footnoteLabelFollow} from '../src/footnote-state.js';
import {planFootnoteDefinitionOrder} from '../src/footnotes.js';
const create=doc=>EditorState.create({doc,extensions:[footnoteIndex,footnoteRenumber,footnoteReferenceDeletion,footnoteLabelFollow,history()]});
test('cut third reference and paste first moves complete definition blocks with one-step paste undo',()=>{
 const original='甲[^1] 乙[^2] 丙[^3]\n\n[^1]: A\n[^2]: B\n    B continuation\n\n[^3]: C\n';
 let state=create(original);const from=original.indexOf('[^3]');
 state=state.update({changes:{from,to:from+4},userEvent:'delete.cut'}).state;
 const cut=state.doc.toString();
 state=state.update({changes:{from:0,insert:'[^3]'},userEvent:'input.paste'}).state;
 const pasted=state.doc.toString();
 assert.equal(pasted,'[^1]甲[^2] 乙[^3] 丙\n\n[^1]: C\n[^2]: A\n\n[^3]: B\n    B continuation\n');
 const target={get state(){return state;},dispatch:tr=>{state=tr.state;}};
 assert.ok(undo(target));assert.equal(state.doc.toString(),cut);
 assert.ok(redo(target));assert.equal(state.doc.toString(),pasted);
 assert.equal(create(pasted).doc.toString(),pasted);
});
test('named labels are retained, CRLF and multiline definition content preserved',()=>{
 const text='A[^name] B[^other]\r\n\r\n[^other]: B\r\n    second\r\n[^name]: A\r\n';
 const [c]=planFootnoteDefinitionOrder(text);
 assert.equal(text.slice(0,c.from)+c.insert+text.slice(c.to),'A[^name] B[^other]\r\n\r\n[^name]: A\r\n[^other]: B\r\n    second\r\n');
});
test('opening, ordinary typing and prose between definitions do not reorder source',()=>{
 const text='A[^1] B[^2]\n\n[^2]: B\n\nOther prose\n\n[^1]: A';
 assert.deepEqual(planFootnoteDefinitionOrder(text),[]);
 const source='A[^1] B[^2]\n\n[^2]: B\n[^1]: A';
 assert.equal(create(source).doc.toString(),source);
 assert.equal(create(source).update({changes:{from:0,insert:'x'},userEvent:'input.type'}).newDoc.toString(),'x'+source);
});
