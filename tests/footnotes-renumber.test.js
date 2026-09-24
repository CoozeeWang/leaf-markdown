import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planFootnoteRenumbering} from '../src/footnotes.js';
const source='甲[^1] 乙[^Test] 丙[^2] 丁[^3]\n\n[^1]: A\n[^Test]: Test\n[^2]: B\n[^3]: C';
function settled(text, options) {
 const {changes}=planFootnoteRenumbering(text,options);
 let result=text;
 for (const change of [...changes].reverse()) result=result.slice(0,change.from)+change.insert+result.slice(change.to);
 return result;
}
test('数字标签与显示顺序一致，引用和定义一起变更',()=>{
 assert.equal(settled(source),'甲[^1] 乙[^Test] 丙[^3] 丁[^4]\n\n[^1]: A\n[^Test]: Test\n[^3]: B\n[^4]: C');
});
test('可以把文字标签也统一成连续编号',()=>{
 const text=settled(source,{includeNamed:true});
 assert.equal(text,'甲[^1] 乙[^2] 丙[^3] 丁[^4]\n\n[^1]: A\n[^2]: Test\n[^3]: B\n[^4]: C');
 assert.deepEqual(planFootnoteRenumbering(text,{includeNamed:true}).changes,[]);
});
test('标签交换不会合并注释，重复引用和定义一起跟随',()=>{
 assert.equal(settled('甲[^2] 乙[^1] 再引[^2]\n\n[^2]: A\n[^2]: 重复\n[^1]: B'),
  '甲[^1] 乙[^2] 再引[^1]\n\n[^1]: A\n[^1]: 重复\n[^2]: B');
});
test('保留尚未补全的脚注，避免数字冲突时串内容',()=>{
 const text='甲[^Test] 乙[^1]\n\n[^Test]: Test';
 assert.equal(planFootnoteRenumbering(text,{includeNamed:true}).blocked,true);
 assert.equal(settled(text,{includeNamed:true}),text);
});

import {EditorState} from '@codemirror/state';
import {history, undo, redo, isolateHistory} from '@codemirror/commands';
import {footnoteIndex, footnoteLabelFollow, footnoteRenumber, footnoteLabelMap} from '../src/footnote-state.js';
function editor(text) { return EditorState.create({doc:text,extensions:[footnoteIndex,footnoteRenumber,footnoteLabelFollow,history()]}); }
test('手写新引用后补定义，同一事务同步后续数字标签并支持撤销重做',()=>{
 let state=editor('甲[^1] 乙[^Test] 丙[^2] 丁[^3]\n\n[^1]: A\n[^2]: B\n[^3]: C');
 const original=state.doc.toString();
 const tr=state.update({changes:{from:state.doc.length,insert:'\n[^Test]: Test'},userEvent:'input',annotations:isolateHistory.of('full')});
 const labels=footnoteLabelMap(state.field(footnoteIndex),tr.state.field(footnoteIndex),tr.changes);
 assert.equal(labels.get('2'),'3');assert.equal(labels.get('3'),'4');
 state=tr.state;
 const next='甲[^1] 乙[^Test] 丙[^3] 丁[^4]\n\n[^1]: A\n[^3]: B\n[^4]: C\n[^Test]: Test';
 assert.equal(state.doc.toString(),next);
 const target={get state(){return state;},dispatch(tr){state=tr.state;}};
 undo(target);assert.equal(state.doc.toString(),original);
 redo(target);assert.equal(state.doc.toString(),next);
});
test('载入旧文件不自动改写，整理命令可以一次修正现有数字标签',()=>{
 const state=editor('空');
 const loaded=state.update({changes:{from:0,to:state.doc.length,insert:source}}).state;
 assert.equal(loaded.doc.toString(),source);
 const fixed=loaded.update({userEvent:'input.footnote-renumber'}).state;
 assert.equal(fixed.doc.toString(),settled(source));
});
