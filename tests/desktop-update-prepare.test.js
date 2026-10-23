import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createDocumentSession} from '../src/document-session.js';
import {createUpdateParticipant} from '../src/update-participant.js';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function saveFixture({path=null,invalidateAt=null,selectTarget='selected.md',failAt=null,writeGate=null,resultContent=null,mappings=[],restoreDenied=false,observe=false,observeGate=null}={}) {
  const calls=[],savedResults=[],statuses=[],aiResults=[];let live=true;let content='# Latest synthetic buffer\n';
  const transaction={prepare_id:'prepare-synthetic-1',async assertCurrent(){if(!live)throw Error('update_prepare_stale');}};
  const step=name=>{calls.push(name);if(invalidateAt===name)live=false;if(failAt===name)throw Error('synthetic_'+name+'_failure');};
  const session=createDocumentSession({
    content:()=>content,status:(...args)=>statuses.push(args),load:()=>{},aiSaveResult:value=>aiResults.push(value),
    observe:observe?async()=>{step('observe');if(observeGate){observeGate.started.resolve();await observeGate.finish.promise;}return {path,content:'# Disk baseline\n'};}:undefined,saved:(value,target)=>{calls.push('saved');savedResults.push({content:value,path:target});},
    saveContext:()=>({document_id:'synthetic-doc',session_id:'synthetic-session',revision:3}),
    select:async()=>{step('select');return selectTarget;},
    readTarget:async()=>{step('readTarget');return null;},
    checkpoint:async(_content,_preserve,declared)=>{step('checkpoint');calls.push(['checkpoint-generation',declared?.prepare_id]);},
    write:async(_path,value,_expected,_context,declared)=>{step('write');calls.push(['write-generation',declared?.prepare_id]);if(writeGate){writeGate.started.resolve();await writeGate.finish.promise;}return {path:_path,content:resultContent??value,mappings};},
    restore:value=>{if(restoreDenied)throw Error('composition_pending');content=value;},
  });
  await session.initialize(path,'# Disk baseline\n');
  const participant=createUpdateParticipant({session});
  return {calls,savedResults,statuses,aiResults,session,transaction,participant,content:()=>content,edit:value=>{content=value;session.edited();},abort:()=>{live=false;}};
}

test('participant save rejects a selector result after abort before readTarget',async()=>{
  const f=await saveFixture({invalidateAt:'select'});
  assert.equal(await f.participant.save(f.transaction),false);
  assert.deepEqual(f.calls,['select']);
  assert.equal(f.content(),'# Latest synthetic buffer\n');
  assert.equal(f.session.path,null);
});
test('participant save rechecks generation after readTarget before checkpoint',async()=>{
  const f=await saveFixture({invalidateAt:'readTarget'});
  assert.equal(await f.participant.save(f.transaction),false);
  assert.deepEqual(f.calls,['select','readTarget']);
});
test('participant save abort after checkpoint prevents a new native write',async()=>{
  const f=await saveFixture({path:'named.md',invalidateAt:'checkpoint'});
  assert.equal(await f.participant.save(f.transaction),false);
  assert.equal(f.calls.includes('write'),false);
  assert.equal(f.content(),'# Latest synthetic buffer\n');
});
test('participant named save forwards declared generation to checkpoint and write',async()=>{
  const f=await saveFixture({path:'named.md'});
  assert.equal(await f.participant.save(f.transaction),true);
  assert.deepEqual(f.calls.filter(Array.isArray),[['checkpoint-generation','prepare-synthetic-1'],['write-generation','prepare-synthetic-1']]);
});

test('participant untitled save cancel retains its latest buffer and path',async()=>{
  const f=await saveFixture({selectTarget:null});
  assert.equal(await f.participant.save(f.transaction),false);
  assert.deepEqual(f.calls,['select']);assert.equal(f.session.path,null);
  assert.equal(f.content(),'# Latest synthetic buffer\n');
});
for(const stage of ['checkpoint','write'])test('participant save '+stage+' failure preserves buffer and path',async()=>{
  const f=await saveFixture({failAt:stage});
  assert.equal(await f.participant.save(f.transaction),false);
  assert.equal(f.session.path,null);assert.equal(f.content(),'# Latest synthetic buffer\n');
});
for(const path of [null,'named.md'])test('participant abort retains admitted successful '+(path?'named':'untitled')+' write without ready',async()=>{
  const writeGate={started:deferred(),finish:deferred()};
  const f=await saveFixture({path,writeGate});const pending=f.participant.save(f.transaction);
  await writeGate.started.promise;f.abort();f.edit('# Newer edit after abort\n');writeGate.finish.resolve();
  assert.equal(await pending,false);assert.equal(f.session.path,path||'selected.md');
  assert.equal(f.content(),'# Newer edit after abort\n');
  assert.equal(f.calls.filter(call=>call==='saved').length,1);
});
test('participant late native save success never rebinds a replaced document',async()=>{
  const writeGate={started:deferred(),finish:deferred()};
  const f=await saveFixture({writeGate});const pending=f.participant.save(f.transaction);
  await writeGate.started.promise;await f.session.initialize('replacement.md','# Replacement baseline\n');
  f.edit('# Replacement latest\n');writeGate.finish.resolve();
  assert.equal(await pending,false);assert.equal(f.session.path,'replacement.md');
  assert.equal(f.content(),'# Replacement latest\n');assert.equal(f.calls.includes('saved'),false);
});

test('participant abort skips resource rewrite after admitted SaveAs and preserves native success and live draft',async()=>{
  const writeGate={started:deferred(),finish:deferred()};
  const saved='# Saved ![image](new.assets/image.png)\n';
  const f=await saveFixture({writeGate,resultContent:saved,mappings:[['old.png','new.assets/image.png']],restoreDenied:true});
  const pending=f.participant.save(f.transaction);await writeGate.started.promise;
  f.abort();f.edit('# Newer live IME ![image](old.png)\n');writeGate.finish.resolve();
  assert.equal(await pending,false);
  assert.equal(f.session.path,'selected.md');
  assert.deepEqual(f.savedResults,[{content:saved,path:'selected.md'}]);
  assert.equal(f.content(),'# Newer live IME ![image](old.png)\n');
});

test('participant abort after observe is cancellation without unavailable status or AI failure',async()=>{
  const f=await saveFixture({path:'named.md',observe:true,invalidateAt:'observe'});
  f.session.aiApplied({session_id:'synthetic-session',mutation_id:'synthetic-mutation',applied_revision:3,changed:true});
  assert.equal(await f.participant.save(f.transaction),false);
  assert.deepEqual(f.calls,['observe']);assert.deepEqual(f.statuses,[]);assert.deepEqual(f.aiResults,[]);
});
test('participant stale before I/O emits no old-session status or AI receipt mutation',async()=>{
  const f=await saveFixture({path:'named.md'});
  f.session.aiApplied({session_id:'synthetic-session',mutation_id:'synthetic-mutation',applied_revision:3,changed:true});f.abort();
  assert.equal(await f.participant.save(f.transaction),false);
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.statuses,[]);assert.deepEqual(f.aiResults,[]);
});
test('participant replacement during observe leaves replacement status and AI receipt untouched',async()=>{
  const observeGate={started:deferred(),finish:deferred()};
  const f=await saveFixture({path:'named.md',observe:true,observeGate});
  f.session.aiApplied({session_id:'old-session',mutation_id:'old-mutation',applied_revision:3,changed:true});
  const pending=f.participant.save(f.transaction);await observeGate.started.promise;
  await f.session.initialize('replacement.md','# Replacement baseline\n');
  f.edit('# Replacement latest\n');observeGate.finish.resolve();
  assert.equal(await pending,false);assert.equal(f.session.path,'replacement.md');
  assert.equal(f.content(),'# Replacement latest\n');assert.deepEqual(f.statuses,[]);assert.deepEqual(f.aiResults,[]);
});

const nativeIdentity=(revision=3)=>({window_nonce:7,document_id:'synthetic-doc',session_id:'synthetic-session',authorization_epoch:2,revision,content_digest:'native-digest-'+revision});
const phaseChallenge=(phase='frozen',id='prepare-1')=>({prepare_id:id,phase,identity:nativeIdentity()});
function lifecycleFixture({phase='frozen',pending=false,drainGate=null,readStatus=null,saveOperation=null}={}) {
  const calls=[],replies=[],listeners=new Map();let status={prepare_id:'prepare-1',window_nonce:7,phase,identity:nativeIdentity(),snapshot_identity:nativeIdentity(4),frozen:true};
  const session={save:async()=>{calls.push('save');return saveOperation?await saveOperation():true;}};
  const editor={settle:async()=>{calls.push('settle');return {pending};},freeze:id=>calls.push('freeze:'+id),release:id=>calls.push('release:'+id)};
  const invoke=async(command,args={})=>{
    if(command==='update_participant_status'){calls.push(args.protocolReady?'protocol-ready':args.snapshot?'native-snapshot':'native-status');const value=structuredClone(status);return readStatus?await readStatus(args,value):value;}
    if(command==='update_participant_reply'){replies.push(args.reply);calls.push('reply:'+args.reply.result);return;}
    throw Error('unexpected synthetic command');
  };
  const participant=createUpdateParticipant({session,editor,invoke,listen:async(name,handler)=>{calls.push('listen:'+name);listeners.set(name,handler);return()=>listeners.delete(name);},
    pause:()=>calls.push('pause'),resume:()=>calls.push('resume'),drain:async()=>{calls.push('drain');if(drainGate){drainGate.started?.resolve('drain');await drainGate.promise;}}});
  return {participant,calls,replies,listeners,setStatus:value=>{status=value;},status:()=>status};
}
test('participant freeze waits for admitted callback settlement and native current snapshot',async()=>{
  const gate={...deferred(),started:deferred()},f=lifecycleFixture({drainGate:gate});
  const work=f.participant.challenge(phaseChallenge());
  const progress=await Promise.race([gate.started.promise,work.then(()=>'finished-without-drain')]);
  assert.equal(progress,'drain');
  assert.equal(f.calls.some(value=>value.startsWith('freeze:')),false);
  gate.resolve();await work;
  assert.equal(f.calls.indexOf('drain')<f.calls.indexOf('freeze:prepare-1'),true);
  assert.equal(f.replies.at(-1)?.identity.revision,4);
  assert.equal(f.replies.at(-1)?.result,'ready');
});
test('participant composition and live drafts abort safely without freeze or candidate replacement',async()=>{
  for(const source of ['main-editor','property-draft','comment-draft']){
    const f=lifecycleFixture({pending:{sources:[source]}});await f.participant.challenge(phaseChallenge());
    assert.equal(f.replies.at(-1)?.result,'busy');
    assert.equal(f.calls.some(value=>value.startsWith('freeze:')),false);
    assert.equal(f.calls.includes('save'),false);
  }
});
test('participant release recovers a missed release event from authoritative native status',async()=>{
  const f=lifecycleFixture();await f.participant.challenge(phaseChallenge());
  f.setStatus({window_nonce:7,prepare_id:null,phase:null,identity:null,frozen:false});
  await f.participant.reconcile();
  assert.equal(f.calls.includes('release:prepare-1'),true);assert.equal(f.calls.includes('resume'),true);
  assert.equal(f.participant.preparing,false);
});
test('participant old release notification cannot unlock a newer native generation',async()=>{
  const f=lifecycleFixture({phase:null});await f.participant.reconcile();
  f.setStatus({...f.status(),prepare_id:'prepare-2'});await f.participant.reconcile({prepare_id:'prepare-1'});
  assert.equal(f.participant.activeId,'prepare-2');
  assert.equal(f.participant.preparing,true);
});
test('participant reload installs listeners before protocol-ready status handshake',async()=>{
  const f=lifecycleFixture({phase:null});await f.participant.start();
  for(const name of ['leaf-update-begin','leaf-update-prepare','leaf-update-release']){
    assert.equal(f.calls.indexOf('listen:'+name)>=0,true);
    assert.equal(f.calls.indexOf('listen:'+name)<f.calls.indexOf('protocol-ready'),true);
  }
  f.participant.dispose();
});
test('participant reload during saved phase aborts rather than saving an unproven replacement buffer',async()=>{
  const f=lifecycleFixture({phase:'saved'});await f.participant.reconcile();
  assert.equal(f.calls.includes('save'),false);
  assert.equal(f.replies.at(-1)?.result,'busy');
});
test('participant ordinary composition behavior stays untouched without active native prepare',async()=>{
  const f=lifecycleFixture({phase:null});f.setStatus({window_nonce:7,prepare_id:null,phase:null,identity:null,frozen:false});
  await f.participant.reconcile();assert.equal(f.calls.includes('settle'),false);
  assert.equal(f.calls.some(value=>value.startsWith('freeze:')),false);
});

test('participant delayed old status read never releases a newer freeze owner',async()=>{
  const gate={started:deferred(),finish:deferred()};let delayed=true;
  const f=lifecycleFixture({readStatus:async(_args,value)=>{if(delayed){delayed=false;gate.started.resolve();await gate.finish.promise;}return value;}});
  const old=f.participant.challenge(phaseChallenge());await gate.started.promise;
  f.setStatus({...f.status(),prepare_id:'prepare-2',phase:null});
  await f.participant.reconcile();
  const releases=f.calls.filter(value=>value==='resume').length;
  gate.finish.resolve();await old;
  assert.equal(f.participant.activeId,'prepare-2');
  assert.equal(f.calls.filter(value=>value==='resume').length,releases);
});
test('participant freeze save failure aborts with original challenge identity after native epoch rebind',async()=>{
  let f;f=lifecycleFixture({saveOperation:async()=>{
    f.setStatus({...f.status(),snapshot_identity:{...nativeIdentity(4),authorization_epoch:3}});
    return false;
  }});
  await f.participant.challenge(phaseChallenge());
  const saved={prepare_id:'prepare-1',phase:'saved',identity:nativeIdentity(4)};
  f.setStatus({...f.status(),...saved});
  await f.participant.challenge(saved);
  assert.equal(f.calls.filter(value=>value==='save').length,1);
  assert.equal(f.replies.at(-1)?.result,'cancelled');
  assert.equal(f.replies.at(-1)?.identity.authorization_epoch,2);
  assert.equal(f.status().snapshot_identity.authorization_epoch,3);
});
test('participant duplicate freeze challenges share one pending drain and reply',async()=>{
  const gate={...deferred(),started:deferred()},f=lifecycleFixture({drainGate:gate});
  const first=f.participant.challenge(phaseChallenge()),second=f.participant.challenge(phaseChallenge());
  assert.equal(first,second);await gate.started.promise;gate.resolve();await Promise.all([first,second]);
  assert.equal(f.calls.filter(value=>value==='drain').length,1);
  assert.equal(f.replies.filter(value=>value.result==='ready').length,1);
});

test('participant freeze resource rewrite refusal retains successful native baseline without replacing a live draft',async()=>{
  const saved='# Saved ![image](new.assets/image.png)\n';
  const f=await saveFixture({resultContent:saved,mappings:[['old.png','new.assets/image.png']],restoreDenied:true});
  f.edit('# Current draft ![image](old.png)\n');
  assert.equal(await f.participant.save(f.transaction),false);
  assert.deepEqual(f.savedResults,[{content:saved,path:'selected.md'}]);assert.equal(f.session.path,'selected.md');
  assert.equal(f.content(),'# Current draft ![image](old.png)\n');
});

test('participant matrix frozen rejects a changed native document binding before Ready',async()=>{
  for(const [key,value] of [['document_id','replacement-doc'],['session_id','replacement-session'],['authorization_epoch',3]]){
    const f=lifecycleFixture();
    f.setStatus({...f.status(),snapshot_identity:{...nativeIdentity(4),[key]:value}});
    await f.participant.challenge(phaseChallenge());
    assert.equal(f.replies.some(reply=>reply.result==='ready'),false,key+' must not acknowledge the replaced binding');
    assert.equal(f.replies.at(-1)?.result,'failed');
  }
  const f=lifecycleFixture();f.setStatus({...f.status(),snapshot_identity:{...nativeIdentity(),content_digest:'changed-without-revision'}});
  await f.participant.challenge(phaseChallenge());
  assert.equal(f.replies.some(reply=>reply.result==='ready'),false,'unchanged revision cannot carry a different digest');
});
test('participant matrix sealed rejects a changed final native revision before Ready',async()=>{
  const f=lifecycleFixture();
  await f.participant.challenge(phaseChallenge());
  const saved={prepare_id:'prepare-1',phase:'saved',identity:nativeIdentity(4)};
  f.setStatus({...f.status(),...saved});await f.participant.challenge(saved);
  assert.equal(f.replies.at(-1)?.result,'ready');
  const sealed={...saved,phase:'sealed'};
  f.setStatus({...f.status(),...sealed,snapshot_identity:nativeIdentity(5)});
  const before=f.replies.length;await f.participant.challenge(sealed);
  assert.equal(f.replies.slice(before).some(reply=>reply.result==='ready'),false,'sealed readiness requires the exact final saved snapshot');
  assert.equal(f.replies.at(-1)?.result,'failed');
});

test('participant invalid native status never releases an active generation',async()=>{
  let invalid=false;
  const f=lifecycleFixture({readStatus:async(_args,value)=>invalid?null:value});
  await f.participant.challenge(phaseChallenge());invalid=true;
  await assert.rejects(f.participant.reconcile(),/update_prepare_status_invalid/);
  assert.equal(f.participant.activeId,'prepare-1');
  assert.equal(f.calls.includes('release:prepare-1'),false);
});
test('participant invalid startup status is handled without fabricated ordinary authority',async()=>{
  const f=lifecycleFixture({readStatus:async()=>null});
  await f.participant.start();
  assert.equal(f.calls.includes('resume'),false);assert.equal(f.calls.includes('save'),false);
  assert.equal(f.replies.length,0);f.participant.dispose();
});

test('participant startup reset precedes native bridge ready acknowledgement',async()=>{
  const seen=[];const f=lifecycleFixture({phase:null,readStatus:async(args,value)=>{seen.push(args);return value;}});
  await f.participant.start({protocolReady:false});
  assert.deepEqual(seen,[{protocolReady:false}]);assert.equal(f.calls.includes('protocol-ready'),false);
  await f.participant.ready();assert.equal(seen[1].protocolReady,true);f.participant.dispose();
});
test('participant failed startup reset retains the frozen owner without unhandled rejection',async()=>{
  let invalid=false;
  const f=lifecycleFixture({readStatus:async(_args,value)=>invalid?null:value});
  await f.participant.challenge(phaseChallenge());invalid=true;
  await f.participant.start({protocolReady:false});
  assert.equal(f.participant.activeId,'prepare-1');assert.equal(f.calls.includes('release:prepare-1'),false);
  f.participant.dispose();
});

test('participant settle-released waits for actual frontend save bookkeeping',async()=>{
  const source=readFileSync(new URL('../src/desktop.js',import.meta.url),'utf8');
  const begin=source.indexOf('export async function desktopTestPrepare(');
  const end=source.indexOf('export function desktopPreparing',begin);
  const pending=deferred(),started=deferred();let completed=false,path=null;
  const context={prepareTest:true,prepareTrace:[],participant:{preparing:false,activeId:null,manualDriver:false,reconcile:async()=>{}},
    session:{idle:()=>{started.resolve('session-idle');return pending.promise;},get path(){return path;}},
    restoreQueue:Promise.resolve()};
  runInNewContext(source.slice(begin,end).replace(/^export /,''),context);
  const work=context.desktopTestPrepare('settle-released').then(value=>{completed=true;return value;});
  assert.equal(await Promise.race([started.promise,work.then(()=>'finished-before-js-idle')]),'session-idle');
  assert.equal(completed,false);
  path='synthetic-actually-saved.md';pending.resolve();
  assert.equal((await work).path,'synthetic-actually-saved.md');
});


// Execute the actual production MCP registration/handler in two independent
// renderer contexts. Tauri's installed Any target is a catch-all even when the
// native emitter addresses another window.
async function twoWindowMcpTransport() {
  const source=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
  const from=source.indexOf("    await listenNative('leaf-mcp-editor'");
  const until=source.indexOf("\n    if(welcomeScreen.hidden)",from);
  assert.ok(from>=0&&until>from,'actual production MCP listener registration');
  const listeners=[],windows=[];
  for(const label of ['synthetic-a','synthetic-b']) {
    const state={content:label,finishes:0,replies:[]};
    const context={
      testMode:'passive',nativeTestRetirement:null,hiddenTestMutations:new Set(),mcpAuthorizationActive:false,mutationGeneration:0,
      mcpBinding:{document_id:label,session_id:label,authorization_epoch:1},
      getCurrentWindow:()=>({label}),
      editor:{
        restoreValue:content=>{state.content=content;},
        mcpSnapshot:()=>({content:state.content,revision:1}),
        historyDepth:()=>({undo:0,redo:0}),
        finishAiTask:()=>{state.finishes++;return {finished:true};},
      },
      invoke:async(_name,args)=>{state.replies.push(args);},
      listenNative:async(_event,handler,options)=>{listeners.push({label,handler,target:options?.target??{kind:'Any'}});return ()=>{};},
    };
    await runInNewContext('(async()=>{'+source.slice(from,until)+'})()',context);
    windows.push({label,state,context});
  }
  return {windows,async emit(label,operation,args,recipient=label){
    const payload={window_label:recipient,call_id:'synthetic-call',operation,args};
    await Promise.all(listeners.filter(listener=>listener.target.kind==='Any'||listener.target===label||listener.target.label===label).map(listener=>listener.handler({payload})));
  }};
}
test('participant MCP targeted human edit cannot mutate another live window',async()=>{
  const transport=await twoWindowMcpTransport();
  await transport.emit('synthetic-a','test',{action:'human',content:'# Only synthetic A\n'});
  assert.equal(transport.windows[0].state.content,'# Only synthetic A\n');
  assert.equal(transport.windows[1].state.content,'synthetic-b');
});
test('participant MCP targeted native binding cannot rebind another live window',async()=>{
  const transport=await twoWindowMcpTransport();
  await transport.emit('synthetic-a','binding',{document_id:'native-a',session_id:'native-session-a',authorization_epoch:2});
  assert.equal(transport.windows[0].context.mcpBinding.session_id,'native-session-a');
  assert.equal(transport.windows[1].context.mcpBinding.session_id,'synthetic-b');
});
test('participant MCP targeted finish cannot settle another live window',async()=>{
  const transport=await twoWindowMcpTransport();
  await transport.emit('synthetic-a','finish',{session_id:'synthetic-a',authorization_epoch:1,mutation_generation:2});
  assert.equal(transport.windows[0].state.finishes,1);
  assert.equal(transport.windows[1].state.finishes,0);
});

for(const operation of ['test','binding','finish'])test('participant MCP wrong native recipient is ignored before '+operation+' side effects',async()=>{
  const transport=await twoWindowMcpTransport();
  await transport.emit('synthetic-a',operation,{action:'human',content:'forbidden',session_id:'forbidden',authorization_epoch:2},'synthetic-b');
  assert.equal(transport.windows[0].state.content,'synthetic-a');
  assert.equal(transport.windows[0].context.mcpBinding.session_id,'synthetic-a');
  assert.equal(transport.windows[0].state.finishes,0);
  assert.equal(transport.windows[0].state.replies.length,0);
  assert.equal(transport.windows[1].state.replies.length,0);
});
