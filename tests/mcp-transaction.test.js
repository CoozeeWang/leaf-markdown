import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
// Node does not render icons/styles; all transaction logic is the real module.
registerHooks({load(url,context,next){
  if(url.includes('.svg')||url.endsWith('.css')) return {format:'module',source:'export default "synthetic asset"',shortCircuit:true};
  return next(url,context);
}});
const {planMcpChanges,RendererMutationReceipts}=await import('../src/editor.js');

test('batch keeps touching patches separate and rejects overlapping/equal-offset edits',()=>{
  assert.deepEqual(planMcpChanges('abcd',[{from:2,to:4,expected:'cd',insert:'CD'},{from:0,to:2,expected:'ab',insert:'AB'}],{from:0,to:4}),[{from:0,to:2,insert:'AB'},{from:2,to:4,insert:'CD'}]);
  assert.throws(()=>planMcpChanges('abcd',[{from:0,to:3,expected:'abc',insert:'x'},{from:2,to:4,expected:'cd',insert:'y'}],{from:0,to:4}),/overlapping/);
  assert.throws(()=>planMcpChanges('',[{from:0,to:0,expected:'',insert:'x'},{from:0,to:0,expected:'',insert:'y'}],{from:0,to:0}),/overlapping/);
});
test('empty and invalid batches have explicit no-change results',()=>{
  assert.deepEqual(planMcpChanges('',[],{from:0,to:0}),[]);
  assert.throws(()=>planMcpChanges('same',[{from:0,to:4,expected:'stale',insert:'new'}],{from:0,to:4}),/invalid/);
  assert.throws(()=>planMcpChanges('same',[{from:1,to:2,expected:'a',insert:'x'}],{from:2,to:4}),/invalid/);
});
test('UTF-16 coordinates preserve surrogate pairs and combining graphemes',()=>{
  const source='A😀e\u0301Z';
  assert.deepEqual(planMcpChanges(source,[{from:1,to:3,expected:'😀',insert:'🐾'}],{from:0,to:source.length}),[{from:1,to:3,insert:'🐾'}]);
  assert.throws(()=>planMcpChanges(source,[{from:1,to:2,expected:source.slice(1,2),insert:''}],{from:0,to:source.length}),/invalid/);
  assert.throws(()=>planMcpChanges(source,[{from:3,to:4,expected:'e',insert:''}],{from:0,to:source.length}),/invalid/);
});
test('renderer mutation receipt prevents dispatch replay after acknowledgement loss',async()=>{
  assert.equal(typeof RendererMutationReceipts,'function','renderer must hold queryable idempotent mutation receipts');
  const receipts=new RendererMutationReceipts();let dispatches=0;
  const applied={mutation_id:'mutation-synthetic',request_id:'request-synthetic',task_id:'task-synthetic',session_id:'session-synthetic',applied_revision:7,source_digest:'source',result_digest:'result'};
  const mutation=()=>{dispatches++;return applied;};
  assert.deepEqual(await receipts.apply('mutation-synthetic','digest',mutation),applied);
  assert.deepEqual(receipts.query('mutation-synthetic'),applied);
  assert.deepEqual(await receipts.apply('mutation-synthetic','digest',mutation),applied);
  assert.equal(dispatches,1);
  await assert.rejects(receipts.apply('mutation-synthetic','different',mutation),/mutation_id_conflict/);
  assert.equal(receipts.query('unknown'),null);
});
