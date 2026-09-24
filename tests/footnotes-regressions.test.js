import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EditorState, StateEffect} from '@codemirror/state';
import {history, undo, redo, isolateHistory} from '@codemirror/commands';
import {indexFootnotes, displayNotes, planFootnoteInsertion} from '../src/footnotes.js';
import {footnoteIndex, footnoteLabelFollow} from '../src/footnote-state.js';

function editor(text) {
  return EditorState.create({doc: text, extensions: [footnoteIndex, footnoteLabelFollow, history()]});
}
function insert(state, at) {
  const plan = planFootnoteInsertion(state.doc.toString(), at);
  const next = state.update({changes: plan.changes, selection: {anchor: plan.caret},
    userEvent: 'input', annotations: isolateHistory.of('full')}).state;
  assert.equal(next.doc.toString(), state.update({changes: plan.changes, filter: false}).newDoc.toString(),
    '自动改名不能再次改写插入计划');
  return {state: next, plan};
}

test('冒号前插入脚注仍占一个编号，后续内容保持对应', () => {
  const {state, plan} = insert(editor('来源: 甲[^1] 乙[^2]\n\n[^1]: A\n[^2]: B'), 2);
  assert.equal(plan.renumberBlocked, false);
  assert.equal(state.doc.toString(), '来源[^1]: 甲[^2] 乙[^3]\n\n[^1]:\n[^2]: A\n[^3]: B');
  assert.deepEqual(displayNotes(state.field(footnoteIndex)).list.map(n=>[n.number,n.body]), [[1,''],[2,'A'],[3,'B']]);
});

test('YAML、链接地址、脚注里的代码示例不参与编号和改名', () => {
  const header = '---\ntitle: "[^2]"\nexample: |\n  [^8]: metadata\n---\n';
  const text = header + '甲[^1] 乙[^2] [链接](https://example.com/[^2])\n\n[^1]: `[^2]`\n    真的引用[^2] 与 `[^9]`\n\n    ```\n    [^10]\n    ```\n[^2]: B';
  const {state} = insert(editor(text), header.length+1);
  const next = state.doc.toString();
  assert.ok(next.startsWith(header));
  assert.ok(next.includes('https://example.com/[^2]'));
  assert.ok(next.includes('[^2]: `[^2]`\n    真的引用[^3] 与 `[^9]`'));
  assert.ok(next.includes('    [^10]'));
  assert.deepEqual(state.field(footnoteIndex).notes.map(n=>n.id), ['1','2','3']);
  const refs = state.field(footnoteIndex).notes.flatMap(n=>n.refs);
  for (const ref of refs) assert.equal(next.slice(ref.from,ref.to),`[^${ref.id}]`);
});

test('重复定义随原脚注一起重排，不挂到新脚注下面', () => {
  const {state} = insert(editor('甲[^1] 乙[^2]\n\n[^1]: A\n[^1]: 重复\n[^2]: B'), 1);
  assert.equal(state.doc.toString(), '甲[^1][^2] 乙[^3]\n\n[^1]:\n[^2]: A\n[^2]: 重复\n[^3]: B');
  assert.deepEqual(state.field(footnoteIndex).warnings, [{code:'duplicate-definition',id:'2',line:5}]);
});

test('三个光标把同一个标签改成不同名字时不崩溃或串联定义', () => {
  const text = '甲[^1] 乙[^1] 丙[^1]\n\n[^1]: A';
  const state = editor(text);
  const changes = [...text.matchAll(/\[\^1\]/g)].slice(0,3).map((m,i)=>({from:m.index+2,to:m.index+3,insert:String(i+2)}));
  const tr = state.update({changes,userEvent:'input.type'});
  assert.equal(tr.newDoc.toString(),'甲[^2] 乙[^3] 丙[^4]\n\n[^1]: A');
});

test('连续在正文中间插入，跨越 9→10，重复引用与正文关联始终不变且可撤销重做', () => {
  const original = Array.from({length:12},(_,i)=>`段${i+1}[^${i+1}]`).join(' ') + ' 再引[^2]\n\n' +
    Array.from({length:12},(_,i)=>`[^${i+1}]: 内容${i+1}`).join('\n');
  let state = editor(original);
  const snapshots = [original];
  for(let i=0;i<20;i++) {
    const at=state.doc.toString().indexOf(`段${i%12+1}`)+`段${i%12+1}`.length;
    state=insert(state,at).state;
    const text=state.doc.toString();
    const index=state.field(footnoteIndex);
    assert.deepEqual(displayNotes(index).list.map(n=>n.label), Array.from({length:13+i},(_,j)=>String(j+1)));
    for(let n=1;n<=12;n++) {
      const note=index.notes.find(note=>note.def.body===`内容${n}`);
      assert.ok(note,`内容${n} 未丢失`);
      const marker=`[^${note.id}]`;
      assert.ok(new RegExp(`段${n}(?:\\[\\^\\d+\\])*${marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`).test(text));
      assert.equal(note.refs.length,n===2?2:1);
    }
    snapshots.push(text);
  }
  const target={get state(){return state;},dispatch(tr){state=tr.state;}};
  for(let i=snapshots.length-2;i>=0;i--){assert.equal(undo(target),true);assert.equal(state.doc.toString(),snapshots[i]);}
  for(let i=1;i<snapshots.length;i++){assert.equal(redo(target),true);assert.equal(state.doc.toString(),snapshots[i]);}
});

test('联动改名映射事务附带的位置效果', () => {
  const position=StateEffect.define({map:(value,mapping)=>mapping.mapPos(value)});
  const text='[^1]: A\n\n甲[^1]';
  const state=editor(text),from=text.lastIndexOf('[^1]')+2;
  const tr=state.update({changes:{from,to:from+1,insert:'name'},effects:position.of(text.length+3)});
  assert.equal(tr.effects.find(e=>e.is(position)).value,tr.newDoc.length);
});

test('逐字在已有角标前手写新引用，任何一步都不能劫持旧定义', () => {
  for (const gap of ['', ' ']) {
    for (const label of ['Test','行业','3']) {
      const original=`甲[^1] 乙${gap}[^2]\n\n[^1]: A\n[^2]: B`;
      let state=editor(original),at=original.indexOf('乙')+1,typed='';
      for (const key of `[^${label}]`) {
        typed+=key;
        state=state.update({changes:{from:at,insert:key},selection:{anchor:at+key.length},userEvent:'input.type'}).state;
        at=state.selection.main.head;
        assert.equal(state.doc.toString(), original.slice(0,original.indexOf('乙')+1)+typed+original.slice(original.indexOf('乙')+1));
        assert.deepEqual(displayNotes(state.field(footnoteIndex)).list.map(n=>[n.label,n.body]),[['1','A'],['2','B']]);
      }
      assert.equal(state.field(footnoteIndex).notes.find(n=>n.id===label).state,'undefined');
    }
  }
});

test('未闭合的新角标不把后面的角标吞进标签', () => {
  const text='甲[^Test[^2]\n\n[^2]: B';
  assert.deepEqual(indexFootnotes(text).notes.map(n=>[n.id,n.def?.body]),[['2','B']]);
});
