import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
const saving=source.slice(source.indexOf('async function saveToHandle('),source.indexOf('\nasync function saveFile('));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture({fail=false}={}) {
 const started=deferred(),release=deferred(),writes=[],statuses=[];let queued=0;
 const state={content:'first',savedContent:'old',diskContent:'old',fileHandle:{
  createWritable:async()=>({write:async text=>{writes.push(text);started.resolve();await release.promise;if(fail)throw Error('synthetic failure');},close:async()=>{}}),
  getFile:async()=>({lastModified:2}),
 }};
 const context=vm.createContext({state,browserDocumentGeneration:1,hasExternalConflict:async()=>false,setStatus:(...args)=>statuses.push(args),translatedMessage:x=>x,saveSnapshot:()=>{},updateDocumentChrome:()=>{},scheduleSave:()=>queued++});
 vm.runInContext(saving,context);
 return {state,context,started,release,writes,statuses,queued:()=>queued,save:()=>vm.runInContext('saveToHandle(true)',context)};
}
test('slow browser save acknowledges its written snapshot and requeues newer input',async()=>{
 const f=fixture();const pending=f.save();await f.started.promise;f.state.content='second';
 assert.equal(await f.save(),false,'a timer firing during I/O cannot start another writer');
 f.release.resolve();assert.equal(await pending,true);
 assert.deepEqual(f.writes,['first']);assert.equal(f.state.savedContent,'first');assert.equal(f.state.diskContent,'first');
 assert.equal(f.state.content,'second');assert.equal(f.queued(),1);assert.equal(f.statuses.at(-1)[1],'pending');
 assert.equal(await f.save(),true);assert.equal(f.state.savedContent,'second');assert.deepEqual(f.writes,['first','second']);
});
test('a replaced browser document never receives the old save baseline or status',async()=>{
 const f=fixture();const pending=f.save();await f.started.promise;
 f.context.browserDocumentGeneration++;f.state.content='replacement';f.state.savedContent='replacement';f.state.diskContent='replacement';
 f.release.resolve();assert.equal(await pending,true);assert.equal(f.state.diskContent,'replacement');assert.equal(f.state.savedContent,'replacement');
 assert.equal(f.statuses.length,1,'only pre-replacement saving status');
});
test('failed browser write retains dirty content without an automatic retry loop',async()=>{
 const f=fixture({fail:true});const pending=f.save();await f.started.promise;f.state.content='second';f.release.resolve();
 assert.equal(await pending,false);assert.equal(f.state.savedContent,'old');assert.equal(f.state.content,'second');assert.equal(f.queued(),0);assert.equal(f.statuses.at(-1)[1],'error');
});

test('metadata failure after a write does not cause an endless autosave loop',async()=>{
 const f=fixture();f.state.fileHandle.getFile=async()=>{throw Error('synthetic metadata failure');};
 const pending=f.save();await f.started.promise;f.release.resolve();assert.equal(await pending,false);assert.equal(f.queued(),0);
});
test('late conflict observation cannot mark a replacement document conflicted',async()=>{
 const f=fixture(),late=deferred();f.state.lastModified=1;
 f.state.fileHandle.getFile=async()=>({lastModified:2,text:()=>late.promise});
 const fn=source.slice(source.indexOf('async function hasExternalConflict('),source.indexOf('async function saveToHandle('));
 vm.runInContext(fn,f.context);const pending=f.save();await Promise.resolve();await Promise.resolve();
 f.context.browserDocumentGeneration++;f.state.content='replacement';f.state.diskContent='replacement';f.state.savedContent='replacement';
 late.resolve('external old file');assert.equal(await pending,false);assert.notEqual(f.state.conflict,true);assert.deepEqual(f.writes,[]);
});
