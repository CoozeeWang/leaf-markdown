import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorState,Transaction} from '@codemirror/state';
import {history,undo,isolateHistory} from '@codemirror/commands';
import {outlineCollapsed,setOutlineCollapsed,outlineCollapseHistory} from '../src/outline-collapse.js';
import {planOutlineMove,parseOutline} from '../src/outline-sections.js';
test('fold history maps through an unrecorded edit before undoing a section move',()=>{
 const doc='# A\n\nalpha\n\n# B\n\nbeta\n\n';
 let state=EditorState.create({doc,extensions:[history(),outlineCollapsed,outlineCollapseHistory]});
 const dispatch=spec=>{state=spec.state??state.update(spec).state;};
 dispatch({effects:setOutlineCollapsed.of([0]),annotations:Transaction.addToHistory.of(false)});
 const plan=planOutlineMove(doc,0,null,1);
 dispatch({changes:plan.changes,effects:setOutlineCollapsed.of([plan.heading]),annotations:isolateHistory.of('full')});
 dispatch({changes:{from:0,insert:'intro\n\n'},annotations:Transaction.addToHistory.of(false)});
 assert(undo({get state(){return state;},dispatch}));
 assert.equal(state.doc.toString(),'intro\n\n'+doc);
 assert.deepEqual([...state.field(outlineCollapsed)],[parseOutline(state.doc.toString())[0].from]);
});
