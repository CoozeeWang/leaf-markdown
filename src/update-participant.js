// Renderer orchestration never supplies native identity or save authority.
// Native status is rechecked around every await; only native ledger validation
// can accept a Saved reply. Ordinary document-session saves retain their owner.
const identityKeys=['window_nonce','document_id','session_id','authorization_epoch','revision','content_digest'];
const sameIdentity=(a,b)=>a&&b&&identityKeys.every(key=>a[key]===b[key]);
const bindingKeys=identityKeys.slice(0,4);
const sameBinding=(a,b)=>a&&b&&bindingKeys.every(key=>a[key]===b[key]);
const isPending=value=>value===true||!!value?.pending;
export function requireNativeStatus(status){
  if(!status||!Number.isSafeInteger(status.window_nonce)||!('prepare_id' in status)
    ||status.prepare_id!==null&&typeof status.prepare_id!=='string'
    ||status.phase!==null&&![undefined,'frozen','saved','sealed'].includes(status.phase))throw Error('update_prepare_status_invalid');
  return status;
}


export function createUpdateParticipant(io) {
  let active=null,queue=Promise.resolve(),request=0,started=false,enabled=false,disposed=false,manualDriver=false;
  const jobs=new Map(),unlisten=[];
  let stopWatch=null;
  const read=async options=>{
    const status=await io.invoke('update_participant_status',options??{});
    requireNativeStatus(status);
    return status;
  };
  const release=(nextId=null)=>{
    const old=active;active=null;for(const key of jobs.keys())if(!nextId||!key.startsWith(nextId+':'))jobs.delete(key);stopWatch?.();stopWatch=null;
    if(old){if(old.frozen)io.editor?.release(old.id);io.resume?.(old.id);}
  };
  const adopt=status=>{
    if(!status.prepare_id){release();return;}
    if(active?.id===status.prepare_id&&active.nonce===status.window_nonce)return;
    release(status.prepare_id);
    active={id:status.prepare_id,nonce:status.window_nonce,frozen:false,saved:false};
    io.pause?.(active.id);
    stopWatch=io.watch?.(()=>{void api.reconcile().catch(io.error??(()=>{}));})??null;
  };
  const matches=(status,challenge)=>status.prepare_id===challenge.prepare_id
    &&status.window_nonce===challenge.identity?.window_nonce&&status.phase===challenge.phase;
  const check=async(owner,challenge,{snapshot=false}={})=>{
    if(disposed||active!==owner)throw Error('update_prepare_stale');
    const status=await read({snapshot});
    if(active!==owner||!matches(status,challenge))throw Error('update_prepare_stale');
    return status;
  };
  const fail=async(challenge,result)=>{
    // Negative replies use the original native challenge identity. A failed
    // Save As may already have changed epoch, but still must abort promptly.
    const status=await read();
    if(matches(status,challenge)){
      await io.invoke('update_participant_reply',{reply:{...challenge,result}}).catch(()=>{});
    }
    await api.reconcile({runPending:false});
  };
  const run=async challenge=>{
    const at=++request;
    const status=await read();
    if(disposed||at!==request)return false;
    if(status.manual_driver===true){manualDriver=true;return false;}
    if(!matches(status,challenge)||!sameIdentity(status.identity,challenge.identity))return false;
    adopt(status);const owner=active;
    try {
      if(challenge.phase==='frozen'){
        await io.drain?.();await check(owner,challenge);
        if(isPending(await io.editor.settle())){await fail(challenge,'busy');return;}
        await check(owner,challenge);
        io.editor.freeze(owner.id);owner.frozen=true;
      }else if(!owner.frozen||challenge.phase==='sealed'&&!owner.saved){
        await fail(challenge,'busy');return;
      }
      if(challenge.phase==='saved'){
        if(isPending(await io.editor.settle())){await fail(challenge,'busy');return;}
        const transaction={prepare_id:owner.id,assertCurrent:()=>check(owner,challenge)};
        await io.beforeSave?.();await check(owner,challenge);
        if(!await api.save(transaction)){await fail(challenge,'cancelled');return;}
        await io.drain?.();await check(owner,challenge);owner.saved=true;
      }
      if(challenge.phase==='sealed'){
        await io.drain?.();await check(owner,challenge);
        if(isPending(await io.editor.settle())){await fail(challenge,'busy');return;}
      }
      const current=await check(owner,challenge,{snapshot:true});
      if(!current.snapshot_identity||current.snapshot_identity.window_nonce!==owner.nonce)throw Error('update_prepare_identity');
      if(challenge.phase==='frozen'&&(!sameBinding(current.snapshot_identity,challenge.identity)||current.snapshot_identity.revision<challenge.identity.revision
        ||current.snapshot_identity.revision===challenge.identity.revision&&current.snapshot_identity.content_digest!==challenge.identity.content_digest))throw Error('update_prepare_identity');
      if(challenge.phase==='sealed'&&!sameIdentity(current.snapshot_identity,challenge.identity))throw Error('update_prepare_identity');
      // Native receives the native-derived current snapshot, including the
      // actual successful Save As rebind. It still independently verifies it.
      await io.invoke('update_participant_reply',{reply:{...challenge,identity:current.snapshot_identity,result:'ready'}});
    }catch(error){
      if(active===owner)await fail(challenge,error?.message==='composition_pending'?'busy':'failed').catch(()=>{});
      io.error?.(error);
    }
  };
  const api={
    get manualDriver(){return manualDriver;},
    get activeId(){return active?.id??null;},
    get preparing(){return active!==null;},
    async save(transaction){
      if(!io.session||!transaction?.prepare_id||typeof transaction.assertCurrent!=='function')return false;
      return io.session.save({manual:true,transaction});
    },
    challenge(challenge){
      if(!challenge?.prepare_id||!challenge.identity||!['frozen','saved','sealed'].includes(challenge.phase))return Promise.resolve();
      const key=challenge.prepare_id+':'+challenge.phase;
      if(jobs.has(key))return jobs.get(key);
      const operation=queue.then(async()=>{const ran=await run(challenge);if(ran===false&&jobs.get(key)===operation)jobs.delete(key);});
      queue=operation.catch(()=>{});jobs.set(key,operation);return operation;
    },
    async reconcile({protocolReady=false,runPending=true}={}){
      const at=++request;
      const status=await read(protocolReady?{protocolReady:true}:{});
      if(disposed||at!==request)return;
      manualDriver=status.manual_driver===true;
      if(manualDriver){release();return;}
      adopt(status);
      if(runPending&&status.prepare_id&&status.phase&&status.identity){
        await api.challenge({prepare_id:status.prepare_id,phase:status.phase,identity:status.identity});
      }
    },
    async start({protocolReady=true}={}){
      if(started){if(protocolReady)await api.ready();return;}
      started=true;
      for(const name of ['leaf-update-begin','leaf-update-prepare','leaf-update-release']){
        unlisten.push(await io.listen(name,()=>{if(enabled)void api.reconcile().catch(io.error??(()=>{}));}));
      }
      if(protocolReady)await api.ready();
      else try{await read({protocolReady:false});}catch(error){io.error?.(error);}
    },
    async ready(){enabled=true;try{await api.reconcile({protocolReady:true});}catch(error){io.error?.(error);}},
    dispose(){
      disposed=true;enabled=false;request++;
      for(const stop of unlisten.splice(0))stop();release();
    },
  };
  return api;
}
