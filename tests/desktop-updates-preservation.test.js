import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac,randomBytes} from 'node:crypto';
import {captureProfile,compareProfiles,readProfileFile} from './desktop-updates-preservation.mjs';
const manifest=JSON.parse(await readFile(new URL('./fixtures/desktop-updates/profile-manifest.json',import.meta.url),'utf8'));
const secret='SYNTHETIC-CREDENTIAL-'+randomBytes(32).toString('hex');
const salt=randomBytes(32).toString('hex');
const mac=(value,key=secret)=>createHmac('sha256',key).update(value).digest('hex');
const seed=()=>structuredClone(manifest.profile);
const capture=(profile,options={})=>captureProfile({runId:'synthetic-run',snapshotId:options.id??'before',phase:options.phase??'before',profile,salt,credential:secret,probeCredential:async challenge=>({present:true,response:mac(challenge)}),...options});
const compare=(a,b,options={})=>compareProfiles(a,b,{runId:'synthetic-run',salt,fromVersion:'1.0.0',toVersion:'2.0.0',...options});
async function pair(){const a=await capture(seed());const p=seed();p.version='2.0.0';return [a,await capture(p,{id:'success',phase:'success'})];}

test('preservation permits declared history increments and exact success or rollback version',async()=>{
 const before=await capture(seed()),next=seed();next.version='2.0.0';next.history.push({id:'synthetic-history-2',kind:'save',content:'# New synthetic checkpoint'});
 const after=await capture(next,{id:'success',phase:'success'});
 assert.equal(compare(before,after).pass,true);
 const rollback=await capture(seed(),{id:'rollback',phase:'rollback'});assert.equal(compare(before,rollback).pass,true);
 assert.deepEqual(Object.keys(before.categories).sort(),[...manifest.required_categories].sort());
 const serialized=JSON.stringify({before,after,rollback});assert.ok(!serialized.includes(secret));assert.ok(!serialized.includes('/Synthetic/'));assert.ok(!serialized.includes('synthetic-client'));
});
test('preservation rejects every missing or changed locked category',async()=>{
 const [before,after]=await pair();assert.equal(compare(before,after).pass,true);
 for(const category of manifest.required_categories){
  const changed=seed();changed.version='2.0.0';changed[category]={unexpected:'migration'};
  if(category==='application')await assert.rejects(capture(changed,{id:'changed',phase:'success'}));
  else assert.equal(compare(before,await capture(changed,{id:'changed',phase:'success'})).pass,false,category);
  const missing=seed();delete missing[category];await assert.rejects(capture(missing,{id:'missing',phase:'success'}));
 }
});
test('preservation requires an actual synthetic credential challenge and hides probe errors',async()=>{
 const [before,after]=await pair();assert.equal(compare(before,after).pass,true);
 for(const probe of [async()=>({present:false,response:''}),async()=>({present:true,response:mac('wrong')}),async()=>{throw Error(secret);}]){
  await assert.rejects(capture(seed(),{probeCredential:probe}),error=>!String(error).includes(secret));
 }
});
test('preservation snapshots are immutable under repeated and concurrent capture',async()=>{
 const root=await mkdtemp(join(tmpdir(),'leaf-preservation-'));
 try{const options={evidenceRoot:root,id:'same-id'};const results=await Promise.allSettled([capture(seed(),options),capture(seed(),options)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 const path=join(root,'synthetic-run','same-id','snapshot.json'),first=await readFile(path,'utf8');assert.equal(JSON.parse(first).snapshot_id,'same-id');await assert.rejects(capture(seed(),options));assert.equal(await readFile(path,'utf8'),first);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('preservation rejects cross-run, tampered, reordered history and excessive history changes',async()=>{
 const [before,after]=await pair();assert.equal(compare(before,after).pass,true);
 assert.throws(()=>compare({...before,run_id:'another'},after));assert.throws(()=>compare(before,{...after,version:'3.0.0'}));
 for(const history of [[],[...seed().history,{id:'a'},{id:'b'},{id:'c'},{id:'d'},{id:'e'}]]){
  const p=seed();p.version='2.0.0';p.history=history;assert.equal(compare(before,await capture(p,{id:'history',phase:'success'})).pass,false);
 }
 const p=seed();p.version='2.0.0';p.history[0].content='changed previous history';assert.equal(compare(before,await capture(p,{id:'history',phase:'success'})).pass,false);
});
test('preservation filesystem adapter rejects traversal and symbolic links',async()=>{
 const root=await mkdtemp(join(tmpdir(),'leaf-profile-'));
 try{await writeFile(join(root,'profile.json'),JSON.stringify(seed()));assert.deepEqual(await readProfileFile(root,'profile.json'),seed());
 await assert.rejects(readProfileFile(root,'../profile.json'));await symlink(join(root,'profile.json'),join(root,'linked.json'));await assert.rejects(readProfileFile(root,'linked.json'));
 }finally{await rm(root,{recursive:true,force:true});}
});
