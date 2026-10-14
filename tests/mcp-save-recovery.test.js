import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDocumentSession } from '../src/document-session.js';

test('native registration preserves active session and close retires it', () => {
  const run=spawnSync(join(homedir(),'.cargo/bin/cargo'),['test','--locked','--bin','leaf','repeated_registration_preserves_live_session_and_task'],{cwd:new URL('../src-tauri/',import.meta.url),encoding:'utf8'});
  assert.equal(run.status,0,run.stdout + run.stderr);
});

test('AI save distinguishes applied buffer pending disk and recoverable failure', async () => {
  let content='original';const checkpoints=[],results=[];
  let rejectSave=true;
  const session=createDocumentSession({content:()=>content,load:async c=>{content=c;},status:()=>{},checkpoint:async c=>checkpoints.push(c),observe:async()=>({path:'/synthetic.md',content:'original'}),write:async()=>{if(rejectSave)throw new Error('synthetic permission failure');},saved:()=>{},aiSaveResult:async result=>results.push(result)});
  await session.initialize('/synthetic.md','original');
  content='applied';session.edited();
  assert.equal(typeof session.aiApplied,'function','applied receipts must connect to the existing save session');
  session.aiApplied({session_id:'session',mutation_id:'mutation',applied_revision:1,changed:true});
  assert.equal(session.aiEditResult.bufferResult.revision,1);
  assert.equal(session.aiEditResult.diskResult.state,'pending');
  assert.equal(await session.save({manual:false}),false);
  assert.equal(content,'applied');assert(checkpoints.includes('applied'));
  assert.equal(session.aiEditResult.bufferResult.revision,1);
  assert.equal(session.aiEditResult.diskResult.state,'failed');
  assert.equal(session.aiEditResult.checkpoint.state,'protected');
  rejectSave=false;assert.equal(await session.save(),true);
  assert.equal(session.aiEditResult.diskResult.state,'saved');
  assert.equal(results.at(-1).diskResult.state,'saved');
});

test('zero-edit AI receipts do not write or checkpoint', async () => {
  let writes=0,checkpoints=0;
  const session=createDocumentSession({content:()=>'',load:async()=>{},status:()=>{},write:async()=>writes++,checkpoint:async()=>checkpoints++});
  await session.initialize(null,'');
  assert.equal(typeof session.aiApplied,'function','empty receipts require an explicit unchanged result');
  session.aiApplied({session_id:'session',mutation_id:'empty',applied_revision:0,changed:false});
  assert.equal(session.aiEditResult.diskResult.state,'unchanged');
  assert.equal(writes,0);assert.equal(checkpoints,0);
});

test('external disk change stops AI and pauses autosave while retaining both drafts', async () => {
  let content='original',active=true,stops=0,writes=0;const checkpoints=[];
  const session=createDocumentSession({content:()=>content,load:async c=>{content=c;},status:()=>{},aiActive:()=>active,aiConflict:async()=>{active=false;stops++;},checkpoint:async c=>checkpoints.push(c),observe:async()=>({path:'/synthetic.md',content:'external draft'}),write:async()=>writes++,saved:()=>{}});
  await session.initialize('/synthetic.md','original');content='AI draft';session.edited();
  await session.poll();
  assert.equal(active,false,'external observer must finalize AI before another automatic write');
  assert.equal(session.paused,true);
  assert.equal(content,'AI draft');assert(checkpoints.includes('AI draft'));
  assert.equal(await session.save({manual:false}),false);assert.equal(writes,0);
  await session.poll();assert.equal(stops,1,'duplicate conflict cannot checkpoint or stop twice');
});
