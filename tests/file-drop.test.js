import test from 'node:test';
import assert from 'node:assert/strict';
import {ChangeSet} from '@codemirror/state';
import {fileDropTarget,setFileDropTarget} from '../src/file-drop.js';
import {bodyStart} from '../src/markdown-model.js';

function viewFor(source,hit) {
  return {
    state:{doc:{toString:()=>source}},
    scrollDOM:{getBoundingClientRect:()=>({left:0,right:500,top:0,bottom:500})},
    contentDOM:{getBoundingClientRect:()=>({left:20,right:480})},
    posAndSideAtCoords:()=>hit,
  };
}
for(const assoc of [-1,1]) test(`file-drop hit preserves the visual side ${assoc}`,()=>{
  assert.deepEqual(fileDropTarget(viewFor('Body text',{pos:4,assoc}),{x:100,y:100}),{pos:4,assoc,protected:false});
});
test('property clamp discards the hidden property-side association',()=>{
  const source='---\ntitle: Guard\n---\n\nBody';
  assert.deepEqual(fileDropTarget(viewFor(source,{pos:2,assoc:-1}),{x:100,y:100}),{pos:bodyStart(source),assoc:1,protected:true});
});
test('outside the editor or an unresolved hit offers no drop position',()=>{
  const view=viewFor('Body',null);
  assert.equal(fileDropTarget(view,{x:100,y:100}),null);
  assert.equal(fileDropTarget(view,{x:600,y:100}),null);
  assert.equal(fileDropTarget(view,null),null);
});
test('mapping a drop target keeps the wrap side and insertion affinity',()=>{
  const changes=ChangeSet.of({from:4,insert:'x'},8);
  assert.deepEqual(setFileDropTarget.of({pos:4,assoc:-1}).map(changes).value,{pos:4,assoc:-1});
  assert.deepEqual(setFileDropTarget.of({pos:4,assoc:1}).map(changes).value,{pos:5,assoc:1});
  assert.equal(setFileDropTarget.of(null).map(changes).value,null);
});
