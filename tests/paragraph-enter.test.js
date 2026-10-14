import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {markdown} from '@codemirror/lang-markdown';
import {history,undo} from '@codemirror/commands';
import {insertPlainParagraphNewline} from '../src/paragraph-enter.js';
import {sourceMode} from '../src/view-mode.js';
import {footnoteIndex} from '../src/footnote-state.js';
const create=(doc,at=doc.length,source=false)=>EditorState.create({doc,selection:{anchor:at},extensions:[markdown(),sourceMode.init(()=>source),footnoteIndex,history()]});
test('prose Enter does not propagate incidental spaces, including consecutive blank lines',()=>{
 for(const source of ['正文',' 正文','  正文','   正文','正文\n ','正文\n  ']){
  let state=create(source);
  const target={get state(){return state;},dispatch:tr=>{state=tr.state;}};
  assert.ok(insertPlainParagraphNewline(target));
  assert.equal(state.doc.lineAt(state.selection.main.head).text,'');
  assert.equal(state.selection.main.head,state.doc.lineAt(state.selection.main.head).from);
  assert.ok(insertPlainParagraphNewline(target));
  assert.equal(state.doc.lineAt(state.selection.main.head).text,'');
 }
});
test('ordinary split preserves existing indentation and hard-break whitespace, and supports undo',()=>{
 let state=create(' 前文 后文',3);
 const target={get state(){return state;},dispatch:tr=>{state=tr.state;}};
 assert.ok(insertPlainParagraphNewline(target));assert.equal(state.doc.toString(),' 前文\n后文');
 assert.ok(undo(target));assert.equal(state.doc.toString(),' 前文 后文');
 state=create('正文  ');assert.ok(insertPlainParagraphNewline(target));assert.equal(state.doc.toString(),'正文  \n');
});
test('source, lists, quotes, literal blocks and footnote definitions retain their Enter command',()=>{
 for(const source of ['- item','> quote','```js\n  code\n```','    code','\tcode','[^a]: note','正文[^a]\n\n[^a]: note\n    next','<div>\n  html\n</div>']){
  let state=create(source,source.startsWith('```')?source.indexOf('\n```'):source.length),changed=false;
  assert.equal(insertPlainParagraphNewline({state,dispatch(){changed=true;}}),false,source);
  assert.equal(changed,false);
 }
 assert.equal(insertPlainParagraphNewline({state:create(' 正文',3,true),dispatch(){assert.fail();}}),false);
});
