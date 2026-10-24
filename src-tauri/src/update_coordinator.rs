//! Native-owned freeze/save/seal transactions. Registry and coordinator locks are
//! short; no lock or broker queue is held across a renderer challenge.
use std::{collections::BTreeMap,path::PathBuf,sync::Mutex,time::{Duration,Instant}};
use serde::{Deserialize,Serialize};
use tauri::{Emitter,Manager};
use crate::update_admission::{AdmissionRegistry,BarrierGuard,SaveScope,SealToken};
const DRAIN_BUDGET:Duration=Duration::from_secs(30);
const REPLY_BUDGET:Duration=Duration::from_secs(10);
const TRANSACTION_BUDGET:Duration=Duration::from_secs(300);
const PERMIT_BUDGET:Duration=Duration::from_secs(5);
#[derive(Clone,Debug,Eq,PartialEq,Serialize,Deserialize)]
pub(crate) struct PrepareId(pub String);
#[derive(Clone,Debug,Eq,PartialEq,Serialize,Deserialize)]
pub(crate) struct ParticipantIdentity {
    pub window_nonce:u64,pub document_id:String,pub session_id:String,
    pub authorization_epoch:u64,pub revision:u64,pub content_digest:String,
}
/// Constructed only by native verified-package/live-Intent code, never IPC.
#[derive(Clone,Debug,Eq,PartialEq)]
pub(crate) struct PackageBinding {
    pub candidate:String,pub digest:String,pub handle:[u8;16],
    pub app_instance:[u8;16],pub op_id:u64,pub target:String,pub bundle:String,
}
#[derive(Clone,Copy,Debug,Eq,PartialEq,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub(crate) enum ReplyPhase {Frozen,Saved,Sealed}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub(crate) enum ReplyResult {Ready,Cancelled,Failed,Busy}
#[derive(Clone,Debug,Serialize,Deserialize)]
pub(crate) struct PrepareReply {
    pub prepare_id:PrepareId,pub phase:ReplyPhase,pub identity:ParticipantIdentity,pub result:ReplyResult,
}
#[derive(Clone,Debug,Serialize)]
pub(crate) struct Challenge {pub prepare_id:PrepareId,pub phase:ReplyPhase,pub identity:ParticipantIdentity}
#[derive(Clone,Debug,Serialize)]
pub(crate) struct ParticipantStatus {
    pub window_nonce:u64,pub prepare_id:Option<PrepareId>,pub phase:Option<ReplyPhase>,
    pub identity:Option<ParticipantIdentity>,pub frozen:bool,pub manual_driver:bool,
    #[serde(skip_serializing_if="Option::is_none")] pub snapshot_identity:Option<ParticipantIdentity>,
}
#[derive(Clone,Copy,Debug,Eq,PartialEq)]
enum Phase {Draining,Freezing,Saving,Sealing,Handoff}
#[derive(Clone,Debug,Serialize)]
pub(crate) struct CloseAction {
    pub action_id:u64,pub window_nonce:u64,pub allowed:bool,
    #[serde(skip)] pub interruption:Option<(PrepareId,Vec<String>)>,
}
struct Participant {nonce:u64,identity:Option<ParticipantIdentity>,frozen:bool,saved:bool,sealed:bool}
/// Disk facts are written only by write_document's owned native completion path.
#[derive(Clone)]
struct NativeWrite {identity:ParticipantIdentity,path:PathBuf,digest:String,source_revision:u64,anchor:Option<(u64,u128)>,disk_verified:bool}
struct Transaction {
    id:PrepareId,package:PackageBinding,barrier:BarrierGuard,phase:Phase,
    participants:BTreeMap<String,Participant>,ledger:BTreeMap<String,NativeWrite>,
    pending:Option<(String,ReplyPhase,Instant)>,save_scope:Option<SaveScope>,
    started:Instant,permit:Option<String>,
}
/// Not serializable or cloneable; native installer must return ready before use.
pub(crate) struct CommitPermit {
    id:String,prepare_id:PrepareId,package:PackageBinding,expires:Instant,seal:SealToken,
}
#[derive(Default)]
struct State {
    sequence:u64,active:Option<Transaction>,committed:bool,committed_prepare:Option<PrepareId>,exit_armed:bool,exit_taken:bool,
    renderer_protocol:BTreeMap<String,u64>,close_sequence:u64,close_actions:BTreeMap<String,CloseAction>,legacy_close_fences:BTreeMap<String,u64>,ordinary_quit:bool,
}
#[derive(Default)]
pub(crate) struct UpdateCoordinator {state:Mutex<State>,changed:tokio::sync::Notify}
fn nonce()->Result<String,String>{
    let mut bytes=[0u8;16];getrandom::fill(&mut bytes).map_err(|_|"update_entropy_unavailable")?;
    Ok(bytes.iter().map(|byte|format!("{byte:02x}")).collect())
}
fn current<'a>(state:&'a mut State,id:&PrepareId)->Result<&'a mut Transaction,String>{
    state.active.as_mut().filter(|tx|&tx.id==id).ok_or("update_prepare_stale".into())
}
fn check_time(tx:&Transaction,now:Instant)->Result<(),String>{
    if now.saturating_duration_since(tx.started)>=TRANSACTION_BUDGET{return Err("update_prepare_timeout".into());}
    if tx.phase==Phase::Draining&&now.saturating_duration_since(tx.started)>=DRAIN_BUDGET{return Err("update_drain_timeout".into());}
    if let Some((_,phase,started))=&tx.pending{
        if *phase!=ReplyPhase::Saved&&now.saturating_duration_since(*started)>=REPLY_BUDGET{return Err("update_reply_timeout".into());}
    }Ok(())
}
fn declared_save(state:&State,label:&str,declared:Option<&PrepareId>)->Result<Option<PrepareId>,String>{
    let scoped=state.active.as_ref().filter(|tx|tx.phase==Phase::Saving&&tx.save_scope.is_some()
        &&tx.pending.as_ref().is_some_and(|(owner,phase,_)|owner==label&&*phase==ReplyPhase::Saved));
    match (declared,scoped){
        (Some(id),Some(tx)) if id==&tx.id=>{check_time(tx,Instant::now())?;Ok(Some(tx.id.clone()))},
        (None,None)=>Ok(None),
        _=>Err("update_prepare_stale".into()),
    }
}
fn captured_participants(barrier:&BarrierGuard,snapshot:&crate::update_admission::AdmissionSnapshot)->Result<BTreeMap<String,Participant>,String>{
    if snapshot.epoch!=barrier.epoch||snapshot.participants.keys().ne(barrier.participants.keys()){return Err("update_prepare_participants_changed".into());}
    barrier.participants.keys().map(|label|{
        let nonce=snapshot.instances.get(label).copied().ok_or("update_prepare_participants_changed")?;
        Ok((label.clone(),Participant{nonce,identity:None,frozen:false,saved:false,sealed:false}))
    }).collect()
}
impl UpdateCoordinator {
    pub(crate) fn begin_close(&self,registry:&AdmissionRegistry,label:&str,window_nonce:u64)->Result<CloseAction,String>{
        self.begin_close_action(registry,label,window_nonce,false)
    }
    pub(crate) fn begin_native_close(&self,registry:&AdmissionRegistry,label:&str,window_nonce:u64)->Result<CloseAction,String>{
        self.begin_close_action(registry,label,window_nonce,true)
    }
    fn begin_close_action(&self,registry:&AdmissionRegistry,label:&str,window_nonce:u64,native_gesture:bool)->Result<CloseAction,String>{
        let mut state=self.state.lock().unwrap();
        if registry.snapshot().instances.get(label)!=Some(&window_nonce){return Err("update_close_window_stale".into());}
        // Native prevention may suppress the renderer callback entirely. A new
        // OS gesture can replace its denied claim; active allowed closes and
        // the legacy-callback fence retain their existing authority.
        if native_gesture&&state.close_actions.get(label).is_some_and(|a|a.window_nonce==window_nonce&&!a.allowed){state.close_actions.remove(label);}
        if let Some(action)=state.close_actions.get(label){
            if action.window_nonce!=window_nonce{return Err("update_close_window_stale".into());}
            return Ok(action.clone());
        }
        state.close_sequence=state.close_sequence.checked_add(1).filter(|value|*value<=9_007_199_254_740_991).ok_or("update_close_sequence_exhausted")?;
        // begin, native close and ordinary Quit use this same lock, in the
        // coordinator -> admission order. No renderer await occurs here.
        let decision=registry.close_decision();
        let interrupted=if decision==crate::update_admission::CloseDecision::CancelledPrepare{
            state.active.take()
        }else{None};
        let interruption=interrupted.as_ref().map(|tx|(tx.id.clone(),tx.participants.keys().cloned().collect()));
        let action=CloseAction{action_id:state.close_sequence,window_nonce,
            allowed:decision==crate::update_admission::CloseDecision::Allowed&&!state.committed,interruption:None};
        if !action.allowed{state.legacy_close_fences.insert(label.into(),window_nonce);}
        state.close_actions.insert(label.into(),action.clone());
        drop(state);drop(interrupted);self.changed.notify_waiters();
        Ok(CloseAction{interruption,..action})
    }
    pub(crate) fn close_action(&self,label:&str,window_nonce:u64)->Option<CloseAction>{
        self.state.lock().unwrap().close_actions.get(label).filter(|action|action.window_nonce==window_nonce).cloned()
    }
    pub(crate) fn legacy_close_denied(&self,label:&str,window_nonce:u64)->bool{
        self.state.lock().unwrap().legacy_close_fences.get(label)==Some(&window_nonce)
    }
    pub(crate) fn complete_close(&self,label:&str,window_nonce:u64,action_id:u64)->Result<(),String>{
        let mut state=self.state.lock().unwrap();
        if state.close_actions.get(label).is_none_or(|action|action.window_nonce!=window_nonce||action.action_id!=action_id){return Err("update_close_action_stale".into());}
        state.close_actions.remove(label);Ok(())
    }
    pub(crate) fn begin_quit(&self,registry:&AdmissionRegistry)->Result<(crate::update_admission::CloseDecision,Option<(PrepareId,Vec<String>)>),String>{
        let mut state=self.state.lock().unwrap();
        if state.ordinary_quit||state.close_actions.values().any(|action|action.allowed){return Err("ordinary_close_busy".into());}
        let decision=registry.close_decision();
        let interrupted=if decision==crate::update_admission::CloseDecision::CancelledPrepare{state.active.take()}else{None};
        let notice=interrupted.as_ref().map(|tx|(tx.id.clone(),tx.participants.keys().cloned().collect()));
        if decision==crate::update_admission::CloseDecision::Allowed&&!state.committed{
            state.close_actions.retain(|_,action|action.allowed);state.ordinary_quit=true;
        }
        drop(state);drop(interrupted);self.changed.notify_waiters();Ok((decision,notice))
    }
    pub(crate) fn cancel_quit(&self,label:Option<&str>){
        let mut state=self.state.lock().unwrap();state.ordinary_quit=false;
        if let Some(label)=label{state.close_actions.remove(label);}
    }
    pub(crate) fn begin(&self,registry:&AdmissionRegistry,package:PackageBinding)->Result<PrepareId,String>{
        let mut state=self.state.lock().unwrap();
        if state.active.is_some()||state.committed||state.ordinary_quit||state.close_actions.values().any(|action|action.allowed){return Err("update_prepare_busy".into());}
        if package.candidate.is_empty()||package.digest.is_empty()||package.target.is_empty()||package.bundle.is_empty(){return Err("update_package_target_invalid".into());}
        state.sequence=state.sequence.checked_add(1).filter(|value|*value<=9_007_199_254_740_991).ok_or("update_prepare_sequence_exhausted")?;
        let id=PrepareId(format!("{}-{}",state.sequence,nonce()?));
        let barrier=registry.close()?;let snapshot=registry.snapshot();
        let participants=captured_participants(&barrier,&snapshot)?;
        state.active=Some(Transaction{id:id.clone(),package,barrier,participants,ledger:BTreeMap::new(),
            phase:Phase::Draining,pending:None,save_scope:None,started:Instant::now(),permit:None});
        Ok(id)
    }
    pub(crate) fn labels(&self,id:&PrepareId)->Result<Vec<String>,String>{
        let mut state=self.state.lock().unwrap();Ok(current(&mut state,id)?.participants.keys().cloned().collect())
    }
    pub(crate) fn finish_drain(&self,id:&PrepareId)->Result<(),String>{
        let mut state=self.state.lock().unwrap();let tx=current(&mut state,id)?;check_time(tx,Instant::now())?;
        if tx.phase!=Phase::Draining{return Err("update_prepare_wrong_phase".into());}
        tx.barrier.validate_idle()?;tx.phase=Phase::Freezing;Ok(())
    }
    pub(crate) fn settle_identity(&self,label:&str,id:&PrepareId,identity:ParticipantIdentity)->Result<(),String>{
        let mut state=self.state.lock().unwrap();let tx=current(&mut state,id)?;check_time(tx,Instant::now())?;
        if tx.phase!=Phase::Freezing||tx.pending.is_some(){return Err("update_prepare_wrong_phase".into());}
        let participant=tx.participants.get_mut(label).ok_or("update_prepare_wrong_window")?;
        if participant.nonce!=identity.window_nonce||participant.frozen||identity.document_id.is_empty()||identity.session_id.is_empty()||identity.content_digest.is_empty(){return Err("update_prepare_identity".into());}
        participant.identity=Some(identity);Ok(())
    }
    pub(crate) fn expect(&self,label:&str,id:&PrepareId,phase:ReplyPhase)->Result<Challenge,String>{
        let mut state=self.state.lock().unwrap();let tx=current(&mut state,id)?;check_time(tx,Instant::now())?;
        if tx.pending.is_some()||tx.permit.is_some(){return Err("update_prepare_reply_pending".into());}
        let participant=tx.participants.get(label).ok_or("update_prepare_wrong_window")?;
        let valid=match phase{
            ReplyPhase::Frozen=>tx.phase==Phase::Freezing&&!participant.frozen,
            ReplyPhase::Saved=>matches!(tx.phase,Phase::Freezing|Phase::Saving)&&tx.participants.values().all(|p|p.frozen)
                &&!participant.saved&&tx.participants.iter().take_while(|(key,_)|key.as_str()!=label).all(|(_,p)|p.saved),
            ReplyPhase::Sealed=>matches!(tx.phase,Phase::Saving|Phase::Sealing|Phase::Freezing)&&tx.participants.values().all(|p|p.saved)&&!participant.sealed,
        };
        if !valid{return Err("update_prepare_wrong_phase".into());}
        let identity=participant.identity.clone().ok_or("update_prepare_not_settled")?;
        if phase==ReplyPhase::Saved {tx.save_scope=Some(tx.barrier.save_scope(label)?);tx.phase=Phase::Saving;}
        if phase==ReplyPhase::Sealed{tx.phase=Phase::Sealing;}
        tx.pending=Some((label.into(),phase,Instant::now()));
        Ok(Challenge{prepare_id:id.clone(),phase,identity})
    }
    pub(crate) fn adopt_frozen_snapshot(&self,label:&str,id:&PrepareId,native:&ParticipantIdentity)->Result<(),String>{
        let mut state=self.state.lock().unwrap();let tx=current(&mut state,id)?;check_time(tx,Instant::now())?;
        if tx.pending.as_ref().is_none_or(|(owner,phase,_)|owner!=label||*phase!=ReplyPhase::Frozen){return Err("update_prepare_unexpected_reply".into());}
        let participant=tx.participants.get_mut(label).ok_or("update_prepare_wrong_window")?;
        let previous=participant.identity.as_ref().ok_or("update_prepare_not_settled")?;
        if participant.frozen||previous.window_nonce!=native.window_nonce||previous.document_id!=native.document_id
            ||previous.session_id!=native.session_id||previous.authorization_epoch!=native.authorization_epoch
            ||native.revision<previous.revision||native.content_digest.is_empty()
            ||native.revision==previous.revision&&native.content_digest!=previous.content_digest{return Err("update_prepare_identity".into());}
        // Only update_participant_reply calls this with the actual current
        // broker snapshot, after comparing the renderer payload to that snapshot.
        participant.identity=Some(native.clone());Ok(())
    }
    pub(crate) fn accept(&self,label:&str,id:&PrepareId,phase:ReplyPhase,identity:&ParticipantIdentity)->Result<(),String>{
        let mut state=self.state.lock().unwrap();let tx=current(&mut state,id)?;check_time(tx,Instant::now())?;
        if tx.pending.as_ref().is_none_or(|(owner,expected,_)|owner!=label||*expected!=phase){return Err("update_prepare_unexpected_reply".into());}
        let participant=tx.participants.get_mut(label).ok_or("update_prepare_wrong_window")?;
        if participant.identity.as_ref()!=Some(identity){return Err("update_prepare_identity".into());}
        if phase==ReplyPhase::Saved{
            let record=tx.ledger.get(label).ok_or("update_native_save_missing")?;
            if record.identity!=*identity||record.digest!=identity.content_digest{return Err("update_native_save_mismatch".into());}
            participant.saved=true;tx.save_scope.take();
        }else if phase==ReplyPhase::Frozen {participant.frozen=true;}else{participant.sealed=true;}
        tx.pending=None;drop(state);self.changed.notify_waiters();Ok(())
    }
    pub(crate) fn ready_to_seal(&self,id:&PrepareId)->bool{
        let mut state=self.state.lock().unwrap();
        current(&mut state,id).is_ok_and(|tx|check_time(tx,Instant::now()).is_ok()&&tx.pending.is_none()
            &&tx.participants.iter().all(|(label,p)|p.frozen&&p.saved&&p.sealed
                &&tx.ledger.get(label).is_some_and(|record|record.disk_verified&&p.identity.as_ref()==Some(&record.identity)))
            &&tx.ledger.len()==tx.participants.len())
    }
    /// Called after actual native I/O and saved-anchor bookkeeping, while the
    /// real OperationLease and broker serialization are still owned.
    #[cfg(test)]
    fn record_native_write(&self,label:&str,identity:ParticipantIdentity,path:PathBuf,digest:String,source_revision:u64){
        let mut state=self.state.lock().unwrap();let Some(tx)=state.active.as_mut()else{return;};
        if tx.phase!=Phase::Saving||tx.pending.as_ref().is_none_or(|(owner,phase,_)|owner!=label||*phase!=ReplyPhase::Saved){return;}
        let Some(participant)=tx.participants.get_mut(label)else{return;};
        if participant.nonce!=identity.window_nonce||tx.save_scope.is_none()||check_time(tx,Instant::now()).is_err(){return;}
        // A native successful Save As is the sole authority for a new binding.
        tx.ledger.insert(label.into(),NativeWrite{identity,path,digest,source_revision,anchor:None,disk_verified:true});
    }
    pub(crate) fn saved_count(&self)->u64{
        self.state.lock().unwrap().active.as_ref().map(|tx|tx.participants.values().filter(|p|p.saved).count() as u64).unwrap_or(0)
    }
    pub(crate) fn write_transaction(&self,label:&str)->Option<PrepareId>{
        self.state.lock().unwrap().active.as_ref().filter(|tx|tx.pending.as_ref().is_some_and(|(owner,phase,_)|owner==label&&*phase==ReplyPhase::Saved)).map(|tx|tx.id.clone())
    }
    pub(crate) fn validate_declared_save(&self,label:&str,declared:Option<&PrepareId>)->Result<Option<PrepareId>,String>{
        declared_save(&self.state.lock().unwrap(),label,declared)
    }
    pub(crate) fn admit_declared_save(&self,registry:&AdmissionRegistry,label:&str,operation:crate::update_admission::SaveOperation,declared:Option<&PrepareId>)->Result<(crate::update_admission::OperationLease,Option<PrepareId>),String>{
        // Generation validation and SaveScope borrowing share the same lock as
        // begin/abort/close. A no-ID callback cannot cross into a newer scope.
        let state=self.state.lock().unwrap();
        let id=declared_save(&state,label,declared)?;
        let lease=registry.admit_save(label,operation)?;
        Ok((lease,id))
    }
    pub(crate) fn record_native_write_for(&self,id:&PrepareId,label:&str,identity:ParticipantIdentity,path:PathBuf,digest:String,source_revision:u64,anchor:(u64,u128)){
        // Match the generation captured before actual I/O. A late prior save
        // cannot add a ledger row to a newer transaction for the same window.
        let mut state=self.state.lock().unwrap();let Ok(tx)=current(&mut state,id)else{return;};
        if tx.phase!=Phase::Saving||tx.pending.as_ref().is_none_or(|(owner,phase,_)|owner!=label||*phase!=ReplyPhase::Saved)
            ||tx.participants.get(label).is_none_or(|p|p.nonce!=identity.window_nonce)||tx.save_scope.is_none()||check_time(tx,Instant::now()).is_err(){return;}
        tx.ledger.insert(label.into(),NativeWrite{identity,path,digest,source_revision,anchor:Some(anchor),disk_verified:false});
    }
    /// A final native snapshot can bind a resource-rewritten revision only when
    /// its digest equals bytes actually written by the authorized native save.
    pub(crate) fn reconcile_saved(&self,label:&str,id:&PrepareId,identity:&ParticipantIdentity,path:&std::path::Path)->Result<(),String>{
        let mut state=self.state.lock().unwrap();let tx=current(&mut state,id)?;check_time(tx,Instant::now())?;
        if tx.pending.as_ref().is_none_or(|(owner,phase,_)|owner!=label||*phase!=ReplyPhase::Saved){return Err("update_prepare_unexpected_reply".into());}
        let record=tx.ledger.get_mut(label).ok_or("update_native_save_missing")?;
        if record.identity.window_nonce!=identity.window_nonce||record.identity.document_id!=identity.document_id
            ||record.identity.session_id!=identity.session_id||record.identity.authorization_epoch!=identity.authorization_epoch
            ||record.digest!=identity.content_digest||record.path!=path||identity.revision<record.source_revision{return Err("update_native_save_mismatch".into());}
        record.identity=identity.clone();
        tx.participants.get_mut(label).ok_or("update_prepare_wrong_window")?.identity=Some(identity.clone());Ok(())
    }
    /// Filesystem work runs outside the state mutex. Compare the saved native
    /// anchor, exact path and actual bytes, then recheck the same transaction and
    /// ledger before certifying the proof. Never rebind a replaced/moved file.
    pub(crate) fn verify_saved_disk(&self,id:&PrepareId,label:&str)->Result<(),String>{
        let record={let mut state=self.state.lock().unwrap();let tx=current(&mut state,id)?;check_time(tx,Instant::now())?;
            let record=tx.ledger.get_mut(label).ok_or("update_native_save_missing")?;
            record.disk_verified=false;record.clone()};
        let token=record.anchor.ok_or("update_native_anchor_missing")?;
        let anchor=crate::document_location::Anchor::open(&record.path).map_err(|_|"update_saved_file_changed")?;
        if anchor.token()!=token{return Err("update_saved_file_changed".into());}
        let located=anchor.locate().map_err(|_|"update_saved_file_changed")?;
        if located.path!=record.path||crate::mcp::source_digest(&located.content.replace("\r\n","\n"))!=record.digest||!anchor.matches_path(&record.path){return Err("update_saved_file_changed".into());}
        let mut state=self.state.lock().unwrap();let tx=current(&mut state,id)?;check_time(tx,Instant::now())?;
        let current=tx.ledger.get_mut(label).ok_or("update_native_save_missing")?;
        if current.identity!=record.identity||current.path!=record.path||current.anchor!=record.anchor||current.digest!=record.digest{return Err("update_native_save_mismatch".into());}
        current.disk_verified=true;Ok(())
    }
    pub(crate) fn seal(&self,id:&PrepareId,package:&PackageBinding,live:bool)->Result<CommitPermit,String>{
        let mut state=self.state.lock().unwrap();let tx=current(&mut state,id)?;check_time(tx,Instant::now())?;
        if !live||&tx.package!=package||tx.permit.is_some()||tx.pending.is_some()
            ||!tx.participants.values().all(|p|p.frozen&&p.saved&&p.sealed)||tx.ledger.len()!=tx.participants.len(){return Err("update_prepare_not_ready".into());}
        for (label,p) in &tx.participants{
            if tx.ledger.get(label).is_none_or(|record|!record.disk_verified||p.identity.as_ref()!=Some(&record.identity)){return Err("update_native_save_mismatch".into());}
        }
        let seal=tx.barrier.seal()?;let permit=nonce()?;tx.permit=Some(permit.clone());tx.phase=Phase::Handoff;
        Ok(CommitPermit{id:permit,prepare_id:id.clone(),package:package.clone(),expires:Instant::now()+PERMIT_BUDGET,seal})
    }
    /// The caller holds the Updates session lock: Intent/candidate revocation
    /// cannot race this native critical section. No renderer command exposes it.
    pub(crate) fn commit(&self,permit:CommitPermit,package:&PackageBinding,helper_ready:bool,consume_package:impl FnOnce()->Result<(),String>)->Result<(),String>{
        let mut state=self.state.lock().unwrap();let tx=current(&mut state,&permit.prepare_id)?;check_time(tx,Instant::now())?;
        if !helper_ready||Instant::now()>=permit.expires||&permit.package!=package||&tx.package!=package
            ||tx.phase!=Phase::Handoff||tx.permit.as_deref()!=Some(&permit.id){return Err("update_commit_permit_stale".into());}
        tx.barrier.validate_idle()?;consume_package()?;
        let tx=state.active.take().ok_or("update_prepare_stale")?;let committed_prepare=permit.prepare_id.clone();
        tx.barrier.commit(permit.seal)?;
        state.committed=true;state.committed_prepare=Some(committed_prepare);state.exit_armed=true;drop(state);self.changed.notify_waiters();Ok(())
    }
    pub(crate) fn take_update_exit(&self)->bool{
        let mut state=self.state.lock().unwrap();
        if !state.committed||!state.exit_armed||state.exit_taken{return false;}
        state.exit_armed=false;state.exit_taken=true;true
    }
    pub(crate) fn committed(&self)->bool{self.state.lock().unwrap().committed}
    #[cfg(any(target_os="macos",target_os="windows"))]
    pub(crate) fn update_exit_for(&self,id:&PrepareId)->bool{
        let state=self.state.lock().unwrap();state.committed&&state.exit_taken&&state.committed_prepare.as_ref()==Some(id)
    }
    fn abort_owned(&self,id:&PrepareId)->Option<Vec<String>>{
        let mut state=self.state.lock().unwrap();
        if state.active.as_ref().is_none_or(|tx|&tx.id!=id){return None;}
        // Remove all authority before abort can invoke the registry reopen hook.
        let tx=state.active.take().unwrap();let labels=tx.participants.keys().cloned().collect();
        drop(state);tx.barrier.abort();drop(tx.save_scope);self.changed.notify_waiters();Some(labels)
    }
    pub(crate) fn abort(&self,id:&PrepareId)->Vec<String>{self.abort_owned(id).unwrap_or_default()}
    pub(crate) fn abort_current(&self)->Option<(PrepareId,Vec<String>)>{
        let id=self.state.lock().unwrap().active.as_ref().map(|tx|tx.id.clone())?;
        let labels=self.abort(&id);Some((id,labels))
    }
    pub(crate) fn status(&self,label:&str,nonce:u64)->ParticipantStatus{
        let state=self.state.lock().unwrap();
        let tx=state.active.as_ref().filter(|tx|tx.participants.get(label).is_some_and(|p|p.nonce==nonce));
        ParticipantStatus{window_nonce:nonce,prepare_id:tx.map(|tx|tx.id.clone()),
            phase:tx.and_then(|tx|tx.pending.as_ref().filter(|(owner,_,_)|owner==label).map(|(_,phase,_)|*phase)),
            identity:tx.and_then(|tx|tx.participants.get(label).and_then(|p|p.identity.clone())),
            frozen:tx.is_some(),snapshot_identity:None,manual_driver:{
                #[cfg(feature="native-smoke")] {crate::update_test_driver::coordinator_enabled()}
                #[cfg(not(feature="native-smoke"))] {false}
            }}
    }
    pub(crate) fn renderer_reset(&self,label:&str,nonce:u64)->Option<(PrepareId,Vec<String>)>{
        let id={let mut state=self.state.lock().unwrap();
            if state.renderer_protocol.get(label)!=Some(&nonce){return None;}
            state.renderer_protocol.remove(label);
            state.active.as_ref().filter(|tx|tx.participants.get(label).is_some_and(|p|p.nonce==nonce)).map(|tx|tx.id.clone())};
        id.map(|id|{let labels=self.abort(&id);(id,labels)})
    }
    pub(crate) fn renderer_ready(&self,label:&str,nonce:u64){self.state.lock().unwrap().renderer_protocol.insert(label.into(),nonce);}
    pub(crate) fn renderer_supported(&self,registry:&AdmissionRegistry)->bool{
        let state=self.state.lock().unwrap();registry.snapshot().instances.iter().all(|(label,nonce)|state.renderer_protocol.get(label)==Some(nonce))
    }
    pub(crate) fn participant_lost(&self,label:&str)->Option<(PrepareId,Vec<String>)>{
        let id={let mut state=self.state.lock().unwrap();state.renderer_protocol.remove(label);state.close_actions.remove(label);state.legacy_close_fences.remove(label);
            state.active.as_ref().filter(|tx|tx.participants.contains_key(label)).map(|tx|tx.id.clone())};
        id.map(|id|{let labels=self.abort(&id);(id,labels)})
    }
    pub(crate) fn deadline_check(&self,id:&PrepareId,now:Instant)->Result<(),String>{
        let mut state=self.state.lock().unwrap();check_time(current(&mut state,id)?,now)
    }
    async fn await_reply(&self,id:&PrepareId)->Result<(),String>{
        loop {
            let changed=self.changed.notified();tokio::pin!(changed);changed.as_mut().enable();
            let budget={let mut state=self.state.lock().unwrap();let tx=current(&mut state,id)?;check_time(tx,Instant::now())?;
                let Some((_,phase,started))=&tx.pending else{return Ok(());};
                let absolute=tx.started+TRANSACTION_BUDGET;
                let deadline=if *phase==ReplyPhase::Saved{absolute}else{absolute.min(*started+REPLY_BUDGET)};
                deadline.saturating_duration_since(Instant::now())};
            tokio::time::timeout(budget,changed).await.map_err(|_|"update_reply_timeout")?;
        }
    }
}
pub(crate) fn caller_nonce(app:&tauri::AppHandle,window:&tauri::WebviewWindow)->Result<u64,String>{
    if crate::verified_window_role(app,window.label())!=crate::WindowRole::Document||app.get_webview_window(window.label()).is_none(){return Err("window_role_denied".into());}
    app.state::<AdmissionRegistry>().snapshot().instances.get(window.label()).copied().ok_or("update_prepare_wrong_window".into())
}
pub(crate) async fn native_identity(app:&tauri::AppHandle,label:&str)->Result<ParticipantIdentity,String>{
    let registry=app.state::<AdmissionRegistry>();let before=registry.snapshot();
    let nonce=*before.instances.get(label).ok_or("update_prepare_wrong_window")?;
    let broker=app.state::<crate::mcp::LeafMcpBroker>();let binding=broker.window_binding(label).ok_or("update_prepare_not_settled")?;
    if broker.window_locked(label){return Err("update_mcp_busy".into());}
    let snapshot=broker.bridge(app,label,"snapshot",serde_json::json!({})).await?;
    let after=broker.window_binding(label).ok_or("update_prepare_disconnected")?;
    if after.session_id!=binding.session_id||after.document_id!=binding.document_id||after.authorization_epoch!=binding.authorization_epoch
        ||registry.snapshot().instances.get(label)!=Some(&nonce)||broker.window_locked(label)||app.get_webview_window(label).is_none(){return Err("update_prepare_identity".into());}
    Ok(ParticipantIdentity{window_nonce:nonce,document_id:binding.document_id,session_id:binding.session_id,authorization_epoch:binding.authorization_epoch,
        revision:snapshot["revision"].as_u64().ok_or("update_prepare_revision")?,
        content_digest:crate::mcp::source_digest(snapshot["content"].as_str().ok_or("update_prepare_digest")?)})
}
#[tauri::command]
pub(crate) fn update_close_disposition(app:tauri::AppHandle,window:tauri::WebviewWindow)->Result<CloseAction,String>{
    let nonce=caller_nonce(&app,&window)?;
    let action=app.state::<UpdateCoordinator>().begin_close(&app.state::<AdmissionRegistry>(),window.label(),nonce)?;
    publish_close_action(&app,&action);Ok(action)
}
#[tauri::command]
pub(crate) fn update_close_complete(app:tauri::AppHandle,window:tauri::WebviewWindow,action_id:u64,window_nonce:u64)->Result<(),String>{
    if caller_nonce(&app,&window)?!=window_nonce{return Err("update_close_window_stale".into());}
    let result=app.state::<UpdateCoordinator>().complete_close(window.label(),window_nonce,action_id);
    #[cfg(feature="native-smoke")] crate::update_test_driver::notify_change(&app);
    result
}
pub(crate) fn publish_close_action(app:&tauri::AppHandle,action:&CloseAction){
    if let Some((id,labels))=&action.interruption{release(app,id,labels.clone(),"update_prepare_cancelled");}
    #[cfg(feature="native-smoke")] crate::update_test_driver::notify_change(app);
}
pub(crate) fn drain_once(app:&tauri::AppHandle,id:&PrepareId)->Result<(),String>{
    let coordinator=app.state::<UpdateCoordinator>();let broker=app.state::<crate::mcp::LeafMcpBroker>();
    if coordinator.labels(id)?.iter().any(|label|broker.window_locked(label)){return Err("update_mcp_busy".into());}
    coordinator.finish_drain(id)
}
#[tauri::command]
pub(crate) async fn update_participant_status(app:tauri::AppHandle,window:tauri::WebviewWindow,protocol_ready:Option<bool>,snapshot:Option<bool>)->Result<ParticipantStatus,String>{
    let nonce=caller_nonce(&app,&window)?;let coordinator=app.state::<UpdateCoordinator>();
    if protocol_ready==Some(false){
        if let Some((id,labels))=coordinator.renderer_reset(window.label(),nonce){
            release(&app,&id,labels,"update_renderer_reloaded");
            // Cancellation never releases a real write lease early.
            app.state::<AdmissionRegistry>().wait_idle(DRAIN_BUDGET).await?;
        }
    }
    if protocol_ready==Some(true){
        coordinator.renderer_ready(window.label(),nonce);
        #[cfg(feature="native-smoke")] crate::update_test_driver::prepare_renderer_ready(&app,window.label());
    }
    let mut status=coordinator.status(window.label(),nonce);
    #[cfg(feature="native-smoke")]
    {
        crate::update_test_driver::prepare_status_gate(window.label(),status.phase).await?;
        // A held test status read must still return current authority on resume.
        status=coordinator.status(window.label(),caller_nonce(&app,&window)?);
    }
    if snapshot==Some(true){
        // No coordinator lock spans a renderer/broker snapshot await. An
        // interrupted or replaced challenge cannot return fresh reply authority.
        let identity=native_identity(&app,window.label()).await?;
        let after=coordinator.status(window.label(),caller_nonce(&app,&window)?);
        if after.window_nonce!=nonce||after.prepare_id!=status.prepare_id||after.phase!=status.phase{
            return Err("update_prepare_stale".into());
        }
        status.snapshot_identity=Some(identity);
    }
    Ok(status)
}
#[tauri::command]
pub(crate) async fn update_participant_reply(app:tauri::AppHandle,window:tauri::WebviewWindow,reply:PrepareReply)->Result<(),String>{
    let nonce=caller_nonce(&app,&window)?;let coordinator=app.state::<UpdateCoordinator>();
    if nonce!=reply.identity.window_nonce{return Err("update_prepare_identity".into());}
    // Do not let malformed/wrong-window failures cancel another participant's tx.
    {let mut state=coordinator.state.lock().unwrap();let tx=current(&mut state,&reply.prepare_id)?;
        if tx.pending.as_ref().is_none_or(|(owner,phase,_)|owner!=window.label()||*phase!=reply.phase)
            ||tx.participants.get(window.label()).is_none_or(|p|p.nonce!=nonce){return Err("update_prepare_unexpected_reply".into());}}
    if !matches!(reply.result,ReplyResult::Ready){
        {let mut state=coordinator.state.lock().unwrap();let tx=current(&mut state,&reply.prepare_id)?;
            if tx.participants.get(window.label()).and_then(|p|p.identity.as_ref())!=Some(&reply.identity){return Err("update_prepare_identity".into());}}
        let labels=coordinator.abort(&reply.prepare_id);release(&app,&reply.prepare_id,labels,"update_participant_cancelled");
        return Err("update_participant_cancelled".into());
    }
    let native=native_identity(&app,window.label()).await?;
    if native!=reply.identity{return Err("update_prepare_identity".into());}
    if reply.phase==ReplyPhase::Frozen{coordinator.adopt_frozen_snapshot(window.label(),&reply.prepare_id,&native)?;}
    if reply.phase==ReplyPhase::Saved{
        let path=app.state::<crate::Documents>().0.lock().unwrap().get(window.label()).cloned().flatten().ok_or("update_native_save_missing")?;
        coordinator.reconcile_saved(window.label(),&reply.prepare_id,&native,&path)?;
    }
    coordinator.accept(window.label(),&reply.prepare_id,reply.phase,&native)
}
pub(crate) fn announce_begin(app:&tauri::AppHandle,id:&PrepareId)->Result<(),String>{
    crate::refresh_document_menu_on_main(app);
    let coordinator=app.state::<UpdateCoordinator>();let registry=app.state::<AdmissionRegistry>();
    for label in coordinator.labels(id)?{
        let snapshot=registry.snapshot();
        let nonce=snapshot.instances.get(&label).copied().ok_or("update_prepare_disconnected")?;
        let status=coordinator.status(&label,nonce);
        if status.prepare_id.as_ref()!=Some(id){return Err("update_prepare_disconnected".into());}
        let pending=snapshot.participants.get(&label)==Some(&false);
        if app.get_webview_window(&label).is_none(){
            if pending{continue;}return Err("update_prepare_disconnected".into());
        }
        // A captured startup may not have a listener yet. Its initial status
        // reconciliation carries this same id/nonce; a ready window must exist.
        let emitted=app.emit_to(&label,"leaf-update-begin",serde_json::json!({"prepare_id":id,"window_nonce":nonce}));
        if emitted.is_err()&&!pending{return Err("update_prepare_disconnected".into());}
    }Ok(())
}
pub(crate) fn release(app:&tauri::AppHandle,id:&PrepareId,labels:Vec<String>,code:&str){
    app.state::<crate::updates::Updates>().interrupt_preparation(app,id,code);
    crate::refresh_document_menu_on_main(app);
    #[cfg(feature="native-smoke")] crate::update_test_driver::notify_change(app);
    for label in labels{
        #[cfg(feature="native-smoke")] if crate::update_test_driver::prepare_skip_release(&label){continue;}
        let _=app.emit_to(&label,"leaf-update-release",serde_json::json!({"prepare_id":id,"error_code":code}));
    }
}
pub(crate) fn abort_and_release(app:&tauri::AppHandle,code:&str){
    if let Some((id,labels))=app.state::<UpdateCoordinator>().abort_current(){release(app,&id,labels,code);}
}
struct PrepareGuard<F:FnMut(&str)> {release:F,armed:bool}
impl<F:FnMut(&str)> PrepareGuard<F> {
    fn complete(mut self,result:Result<(),String>)->Result<(),String>{
        // A returned failure owns its precise reason. Only a dropped/cancelled
        // future uses Drop's interrupted fallback; success must retain commit.
        self.armed=false;
        if let Err(code)=&result{(self.release)(code);}
        result
    }
}
impl<F:FnMut(&str)> Drop for PrepareGuard<F> {fn drop(&mut self){
    if self.armed{(self.release)("update_prepare_interrupted");}
}}
/// Download completion invokes this native-only method. Plan11's handshake is
/// required before production can freeze, and Plan06 must supply a ready helper.
#[cfg(any(test,feature="legacy-updater-tests"))]
pub(crate) async fn prepare_install(app:&tauri::AppHandle,op:u64,candidate:&str)->Result<(),String>{
    let coordinator=app.state::<UpdateCoordinator>();let registry=app.state::<AdmissionRegistry>();
    if !coordinator.renderer_supported(&registry){return Err("update_renderer_prepare_unavailable".into());}
    let (package,binding)=app.state::<crate::updates::Updates>().preparation_authority(app,op,candidate)?;
    let check_app=app.clone();let check_candidate=candidate.to_owned();
    let check=move||check_app.state::<crate::updates::Updates>().preparation_live(op,&check_candidate);
    let cached=package.clone();tauri::async_runtime::spawn_blocking(move||cached.revalidate(&check)).await.map_err(|_|"update_package_invalid")??;
    // Session lock and coordinator lock enforce live Intent at atomic begin.
    let id=app.state::<crate::updates::Updates>().begin_preparation(app,op,candidate,&binding)?;
    let guard=PrepareGuard{release:|code:&str|{
        // An earlier close/cancel/loss already owns its published failure. A
        // stale guard cannot release or overwrite that or a newer transaction.
        if let Some(labels)=coordinator.abort_owned(&id){release(app,&id,labels,code);}
    },armed:true};
    let result=async{
        announce_begin(app,&id)?;
        #[cfg(feature="native-smoke")]
        if crate::update_test_driver::prepare_enabled(){
            let permit=run_preparation(app,&id,&binding,package,op,candidate).await?;
            return crate::update_test_driver::prepare_handoff(app,op,candidate,&binding,permit).await;
        }
        #[cfg(any(target_os="macos",target_os="windows"))]
        {crate::update_install_gui::handoff(app,&id,op,candidate,&binding,package).await}
        #[cfg(not(any(target_os="macos",target_os="windows")))]
        {let permit=run_preparation(app,&id,&binding,package,op,candidate).await?;drop(permit);Err("update_installer_unavailable".into())}
    }.await;
    guard.complete(result)
}
pub(crate) async fn run_preparation(app:&tauri::AppHandle,id:&PrepareId,binding:&PackageBinding,package:std::sync::Arc<crate::update_package::VerifiedPackage>,op:u64,candidate:&str)->Result<CommitPermit,String>{
    run_preparation_with_ready(app,id,binding,package,op,candidate,||async{Ok(())}).await.map(|(permit,())|permit)
}
async fn ready_before_permit<T,R,Ready,F,Final>(ready:R,finalize:F)->Result<(CommitPermit,T),String>
where R:FnOnce()->Ready,Ready:std::future::Future<Output=Result<T,String>>,
    F:FnOnce()->Final,Final:std::future::Future<Output=Result<CommitPermit,String>>{
    let helper=ready().await?;
    let permit=finalize().await?;
    Ok((permit,helper))
}
/// Helper preparation runs only after renderer saves/Sealed replies and before
/// the final native/disk/package proofs issue the short-lived one-use permit.
pub(crate) async fn run_preparation_with_ready<T,F,Fut>(app:&tauri::AppHandle,id:&PrepareId,binding:&PackageBinding,package:std::sync::Arc<crate::update_package::VerifiedPackage>,op:u64,candidate:&str,ready:F)->Result<(CommitPermit,T),String>
where F:FnOnce()->Fut,Fut:std::future::Future<Output=Result<T,String>>{
    let coordinator=app.state::<UpdateCoordinator>();let registry=app.state::<AdmissionRegistry>();
    let labels=coordinator.labels(id)?;
    let work=async {
        let deadline=tokio::time::Instant::now()+DRAIN_BUDGET;
        loop {
            coordinator.deadline_check(&id,Instant::now())?;
            let broker=app.state::<crate::mcp::LeafMcpBroker>();
            if registry.snapshot().active==0&&labels.iter().all(|label|!broker.window_locked(label)){break;}
            if tokio::time::Instant::now()>=deadline{return Err("update_drain_timeout".into());}
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        drain_once(app,&id)?;
        for label in &labels{
            let identity=native_identity(app,label).await?;coordinator.settle_identity(label,&id,identity)?;
            let challenge=coordinator.expect(label,&id,ReplyPhase::Frozen)?;
            #[cfg(feature="native-smoke")] crate::update_test_driver::prepare_phase(app,label,&challenge).await?;
            app.emit_to(label,"leaf-update-prepare",&challenge).map_err(|_|"update_prepare_disconnected")?;
            coordinator.await_reply(&id).await?;
        }
        for label in &labels{
            let challenge=coordinator.expect(label,&id,ReplyPhase::Saved)?;
            #[cfg(feature="native-smoke")] crate::update_test_driver::prepare_phase(app,label,&challenge).await?;
            app.emit_to(label,"leaf-update-prepare",&challenge).map_err(|_|"update_prepare_disconnected")?;
            coordinator.await_reply(&id).await?;
            app.state::<crate::updates::Updates>().preparation_progress(app,op,candidate,labels.len() as u64)?;
        }
        for label in &labels{
            let challenge=coordinator.expect(label,&id,ReplyPhase::Sealed)?;
            #[cfg(feature="native-smoke")] crate::update_test_driver::prepare_phase(app,label,&challenge).await?;
            app.emit_to(label,"leaf-update-prepare",&challenge).map_err(|_|"update_prepare_disconnected")?;
            coordinator.await_reply(&id).await?;
        }
        ready_before_permit(ready,||async{
        coordinator.deadline_check(id,Instant::now())?;
        // Re-read actual native/broker snapshots after all replies. Never hold
        // broker.queue while asking a renderer to save or report its snapshot.
        for label in &labels{
            let identity=native_identity(app,label).await?;
            let status=coordinator.status(label,identity.window_nonce);
            if status.identity.as_ref()!=Some(&identity){return Err("update_prepare_identity".into());}
            {let anchors=app.state::<crate::DocumentAnchors>();let anchors=anchors.0.lock().unwrap();
                let docs=app.state::<crate::Documents>();let docs=docs.0.lock().unwrap();
                let path=docs.get(label).and_then(|path|path.as_ref()).ok_or("update_saved_file_changed")?;
                if !anchors.get(label).is_some_and(|anchor|anchor.matches_path(path)){return Err("update_saved_file_changed".into());}}
            let handle=app.clone();let transaction=id.clone();let owner=label.clone();
            tauri::async_runtime::spawn_blocking(move||handle.state::<UpdateCoordinator>().verify_saved_disk(&transaction,&owner))
                .await.map_err(|_|"update_saved_file_changed")??;
        }
        let cached=package.clone();let check_app=app.clone();let check_candidate=candidate.to_owned();
        tauri::async_runtime::spawn_blocking(move||cached.revalidate(&||check_app.state::<crate::updates::Updates>().preparation_live(op,&check_candidate)))
            .await.map_err(|_|"update_package_invalid")??;
        let permit=coordinator.seal(&id,&binding,app.state::<crate::updates::Updates>().preparation_live(op,candidate))?;
        Ok::<CommitPermit,String>(permit)
        }).await
    };
    tokio::time::timeout(TRANSACTION_BUDGET,work).await.map_err(|_|"update_prepare_timeout".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prepare_guard_preserves_actual_error_and_only_drop_uses_interrupted(){
        let codes=std::cell::RefCell::new(Vec::<String>::new());
        let guard=PrepareGuard{release:|code:&str|codes.borrow_mut().push(code.into()),armed:true};
        assert_eq!(guard.complete(Err("update_helper_ready_timeout".into())),Err("update_helper_ready_timeout".into()));
        assert_eq!(*codes.borrow(),vec!["update_helper_ready_timeout"]);
        let guard=PrepareGuard{release:|code:&str|codes.borrow_mut().push(code.into()),armed:true};
        assert!(guard.complete(Ok(())).is_ok());
        assert_eq!(codes.borrow().len(),1,"successful handoff must not release its transaction");
        drop(PrepareGuard{release:|code:&str|codes.borrow_mut().push(code.into()),armed:true});
        assert_eq!(*codes.borrow(),vec!["update_helper_ready_timeout","update_prepare_interrupted"]);
    }
    #[test]
    fn helper_readiness_finishes_before_fresh_five_second_permit(){
        let(coordinator,_registry,id)=fixture(0);
        {let mut state=coordinator.state.lock().unwrap();state.active.as_mut().unwrap().started=Instant::now()-Duration::from_secs(60);}
        let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let issuance=std::cell::Cell::new(None);
        let(permit,helper)=runtime.block_on(ready_before_permit(||async{
            let mut yielded=false;
            std::future::poll_fn(|context|{
                let state=coordinator.state.lock().unwrap();assert!(state.active.as_ref().unwrap().permit.is_none(),"readiness must not own an expiring permit");
                if yielded{std::task::Poll::Ready(Ok("armed"))}else{yielded=true;context.waker().wake_by_ref();std::task::Poll::Pending}
            }).await
        },||async{
            let issued=Instant::now();issuance.set(Some(issued));coordinator.seal(&id,&package(),true)
        })).unwrap();
        assert_eq!(helper,"armed");
        assert!(permit.expires>=issuance.get().unwrap()+PERMIT_BUDGET);
        assert!(permit.expires<=Instant::now()+PERMIT_BUDGET);
        assert!(coordinator.commit(permit,&package(),true,||Ok(())).is_ok());
    }
    fn package()->PackageBinding{PackageBinding{candidate:"synthetic-release".into(),digest:"signed-package-digest".into(),handle:[7;16],app_instance:[9;16],op_id:1,target:"synthetic-leaf-target".into(),bundle:"studio.leaf.synthetic".into()}}
    fn identity()->ParticipantIdentity{ParticipantIdentity{window_nonce:1,document_id:"doc-a".into(),session_id:"session-a".into(),authorization_epoch:1,revision:3,content_digest:"native-content-digest".into()}}
    #[test]
    fn renderer_reset_aborts_only_a_previously_ready_matching_native_instance(){
        let(coordinator,registry,id)=fixture(1);
        let nonce=registry.snapshot().instances["document-0"];
        assert!(coordinator.renderer_reset("document-0",nonce).is_none());
        assert!(coordinator.labels(&id).is_ok());
        coordinator.renderer_ready("document-0",nonce);
        assert!(coordinator.renderer_reset("document-0",nonce+1).is_none());
        assert!(coordinator.renderer_supported(&registry));
        assert!(coordinator.renderer_reset("document-0",nonce).is_some());
        assert!(coordinator.labels(&id).is_err());assert!(registry.admit().is_ok());
        assert!(!coordinator.renderer_supported(&registry));assert!(!coordinator.take_update_exit());
    }
    #[test]
    fn renderer_reset_retains_real_admitted_io_until_completion(){
        let(coordinator,registry,id)=fixture(1);
        let nonce=registry.snapshot().instances["document-0"];
        coordinator.renderer_ready("document-0",nonce);
        coordinator.expect("document-0",&id,ReplyPhase::Frozen).unwrap();
        coordinator.accept("document-0",&id,ReplyPhase::Frozen,&identity()).unwrap();
        coordinator.expect("document-0",&id,ReplyPhase::Saved).unwrap();
        let(lease,_)=coordinator.admit_declared_save(&registry,"document-0",crate::update_admission::SaveOperation::Write,Some(&id)).unwrap();
        assert!(coordinator.renderer_reset("document-0",nonce).is_some());
        assert_eq!(registry.snapshot().state,crate::update_admission::AdmissionState::AbortDraining);
        assert!(coordinator.labels(&id).is_err());assert!(!coordinator.take_update_exit());
        drop(lease);assert!(registry.admit().is_ok());
    }
    #[test]
    fn begin_closes_admission_and_captures_pending_documents(){
        let registry=AdmissionRegistry::default();let reservation=registry.reserve_document("document-pending").unwrap();
        let coordinator=UpdateCoordinator::default();let id=coordinator.begin(&registry,package()).unwrap();
        assert!(registry.admit().is_err(),"begin must close native admission before capturing pending participants");
        assert!(registry.snapshot().participants.contains_key("document-pending"));
        assert_eq!(coordinator.labels(&id).unwrap(),vec!["document-pending"]);drop(reservation);
    }
    #[test]
    fn wrong_window_and_unexpected_phase_do_not_advance(){
        let coordinator=UpdateCoordinator::default();let registry=AdmissionRegistry::default();let id=coordinator.begin(&registry,package()).unwrap();
        assert!(coordinator.accept("desktop-update",&id,ReplyPhase::Frozen,&identity()).is_err(),"an updater reply must never stand in for a native Document participant");
    }
    #[test]
    fn saved_claim_cannot_substitute_for_native_write_ledger(){
        let coordinator=UpdateCoordinator::default();let registry=AdmissionRegistry::default();registry.reserve_document("document-a").unwrap().commit();registry.document_ready("document-a");
        let id=coordinator.begin(&registry,package()).unwrap();
        assert!(!coordinator.ready_to_seal(&id),"an unsaved participant must not obtain commit authority without an exact native successful-write ledger");
    }
    #[test]
    fn abort_invalidates_transaction_before_late_reply(){
        let coordinator=UpdateCoordinator::default();let registry=AdmissionRegistry::default();let id=coordinator.begin(&registry,package()).unwrap();
        assert_eq!(coordinator.abort_owned(&id),Some(Vec::new()),"even an empty participant set has exactly one failure publisher");
        assert!(coordinator.accept("document-a",&id,ReplyPhase::Frozen,&identity()).is_err(),"aborted preparation must reject late replies");
        let next=coordinator.begin(&registry,package()).unwrap();
        assert_eq!(coordinator.abort_owned(&id),None,"a stale guard must not publish over cancellation or a new preparation");
        assert!(coordinator.labels(&next).is_ok());coordinator.abort(&next);
    }
    fn fixture(count:usize)->(UpdateCoordinator,AdmissionRegistry,PrepareId){
        let registry=AdmissionRegistry::default();for index in 0..count{let label=format!("document-{index}");registry.reserve_document(&label).unwrap().commit();registry.document_ready(&label);}
        let coordinator=UpdateCoordinator::default();let id=coordinator.begin(&registry,package()).unwrap();coordinator.finish_drain(&id).unwrap();
        for label in coordinator.labels(&id).unwrap(){let mut value=identity();value.window_nonce=registry.snapshot().instances[&label];coordinator.settle_identity(&label,&id,value).unwrap();}
        (coordinator,registry,id)
    }
    fn frozen(coordinator:&UpdateCoordinator,id:&PrepareId){
        for label in coordinator.labels(id).unwrap(){let challenge=coordinator.expect(&label,id,ReplyPhase::Frozen).unwrap();coordinator.accept(&label,id,ReplyPhase::Frozen,&challenge.identity).unwrap();}
    }
    fn saved(coordinator:&UpdateCoordinator,id:&PrepareId){
        for label in coordinator.labels(id).unwrap(){let challenge=coordinator.expect(&label,id,ReplyPhase::Saved).unwrap();let i=challenge.identity;
            coordinator.record_native_write(&label,i.clone(),"synthetic.md".into(),i.content_digest.clone(),i.revision);
            coordinator.reconcile_saved(&label,id,&i,std::path::Path::new("synthetic.md")).unwrap();coordinator.accept(&label,id,ReplyPhase::Saved,&i).unwrap();}
    }
    fn sealed(coordinator:&UpdateCoordinator,id:&PrepareId){
        for label in coordinator.labels(id).unwrap(){let challenge=coordinator.expect(&label,id,ReplyPhase::Sealed).unwrap();coordinator.accept(&label,id,ReplyPhase::Sealed,&challenge.identity).unwrap();}
    }
    #[test]
    fn identity_mismatches_and_duplicate_never_consume_pending(){
        let (coordinator,_registry,id)=fixture(2);let challenge=coordinator.expect("document-0",&id,ReplyPhase::Frozen).unwrap();
        let original=challenge.identity;
        let mut variants=Vec::new();let mut v=original.clone();v.window_nonce+=1;variants.push(v);
        let mut v=original.clone();v.document_id.push('x');variants.push(v);let mut v=original.clone();v.session_id.push('x');variants.push(v);
        let mut v=original.clone();v.authorization_epoch+=1;variants.push(v);let mut v=original.clone();v.revision+=1;variants.push(v);let mut v=original.clone();v.content_digest.push('x');variants.push(v);
        for wrong in variants{assert!(coordinator.accept("document-0",&id,ReplyPhase::Frozen,&wrong).is_err());}
        assert!(coordinator.accept("document-1",&id,ReplyPhase::Frozen,&original).is_err());
        assert!(coordinator.accept("document-0",&PrepareId("old".into()),ReplyPhase::Frozen,&original).is_err());
        assert!(coordinator.accept("document-0",&id,ReplyPhase::Saved,&original).is_err());
        coordinator.accept("document-0",&id,ReplyPhase::Frozen,&original).unwrap();
        assert!(coordinator.accept("document-0",&id,ReplyPhase::Frozen,&original).is_err());
        let next=coordinator.expect("document-1",&id,ReplyPhase::Frozen).unwrap();coordinator.accept("document-1",&id,ReplyPhase::Frozen,&next.identity).unwrap();
    }
    #[test]
    fn deterministic_save_order_and_real_lease_block_seal(){
        let (coordinator,registry,id)=fixture(2);frozen(&coordinator,&id);
        assert!(coordinator.expect("document-1",&id,ReplyPhase::Saved).is_err());
        saved(&coordinator,&id);sealed(&coordinator,&id);
        let settling=registry.admit_settle("document-0").unwrap();
        assert!(coordinator.seal(&id,&package(),true).is_err());drop(settling);
        let permit=coordinator.seal(&id,&package(),true).unwrap();coordinator.commit(permit,&package(),true,||Ok(())).unwrap();
        assert!(coordinator.take_update_exit());assert!(!coordinator.take_update_exit());assert!(registry.admit().is_err());
    }
    #[test]
    fn empty_one_many_require_current_package_target_and_one_permit(){
        for count in [0,1,3]{let (coordinator,_registry,id)=fixture(count);frozen(&coordinator,&id);saved(&coordinator,&id);sealed(&coordinator,&id);
            let mut wrong=package();wrong.target.push('x');assert!(coordinator.seal(&id,&wrong,true).is_err());assert!(coordinator.seal(&id,&package(),false).is_err());
            let permit=coordinator.seal(&id,&package(),true).unwrap();assert!(coordinator.seal(&id,&package(),true).is_err());
            coordinator.commit(permit,&package(),true,||Ok(())).unwrap();assert!(coordinator.take_update_exit());assert!(!coordinator.take_update_exit());}
    }
    #[test]
    fn abort_during_real_io_retains_lease_and_saved_bytes(){
        let (coordinator,registry,id)=fixture(1);frozen(&coordinator,&id);coordinator.expect("document-0",&id,ReplyPhase::Saved).unwrap();
        let lease=registry.admit_save("document-0",crate::update_admission::SaveOperation::Write).unwrap();
        let root=tempfile::tempdir().unwrap();let path=root.path().join("saved.md");std::fs::write(&path,"native durable save").unwrap();
        assert_eq!(coordinator.abort(&id),vec!["document-0"]);assert!(lease.recheck().is_err());
        assert_eq!(registry.snapshot().state,crate::update_admission::AdmissionState::AbortDraining);
        assert_eq!(std::fs::read_to_string(path).unwrap(),"native durable save");drop(lease);assert_eq!(registry.snapshot().active,0);
    }
    #[test]
    fn native_save_as_rebind_rejects_old_identity(){
        let (coordinator,_registry,id)=fixture(1);frozen(&coordinator,&id);
        let challenge=coordinator.expect("document-0",&id,ReplyPhase::Saved).unwrap();let old=challenge.identity;
        let mut rebound=old.clone();rebound.session_id="native-new-session".into();rebound.authorization_epoch+=1;
        assert!(coordinator.reconcile_saved("document-0",&id,&rebound,std::path::Path::new("new.md")).is_err());
        coordinator.record_native_write("document-0",rebound.clone(),"new.md".into(),rebound.content_digest.clone(),rebound.revision);
        coordinator.reconcile_saved("document-0",&id,&rebound,std::path::Path::new("new.md")).unwrap();
        assert!(coordinator.accept("document-0",&id,ReplyPhase::Saved,&old).is_err());coordinator.accept("document-0",&id,ReplyPhase::Saved,&rebound).unwrap();
    }
    #[test]
    fn pending_initialization_and_lost_window_refuse_readiness(){
        let registry=AdmissionRegistry::default();let pending=registry.reserve_document("document-pending").unwrap();
        let coordinator=UpdateCoordinator::default();let id=coordinator.begin(&registry,package()).unwrap();
        assert!(coordinator.finish_drain(&id).is_err());pending.commit();assert!(coordinator.finish_drain(&id).is_err());
        registry.document_ready("document-pending");coordinator.finish_drain(&id).unwrap();
        registry.document_destroyed("document-pending");assert!(coordinator.seal(&id,&package(),true).is_err());
        coordinator.participant_lost("document-pending").unwrap();assert!(registry.admit().is_ok());
    }
    #[test]
    fn budgets_are_monotonic_bounded_and_do_not_extend_on_reply(){
        let (coordinator,_registry,id)=fixture(1);let start=Instant::now();
        coordinator.expect("document-0",&id,ReplyPhase::Frozen).unwrap();
        assert!(coordinator.deadline_check(&id,start+REPLY_BUDGET+Duration::from_secs(1)).is_err());
        assert!(coordinator.deadline_check(&id,start+TRANSACTION_BUDGET+Duration::from_secs(1)).is_err());
        coordinator.abort(&id);assert!(coordinator.deadline_check(&id,start).is_err());
    }
    #[test]
    fn external_change_after_native_save_refuses_seal_and_exit(){
        let (coordinator,_registry,id)=fixture(1);frozen(&coordinator,&id);
        let challenge=coordinator.expect("document-0",&id,ReplyPhase::Saved).unwrap();let mut i=challenge.identity;
        let root=tempfile::tempdir().unwrap();let path=root.path().join("synthetic.md");std::fs::write(&path,"native saved content").unwrap();
        let path=std::fs::canonicalize(path).unwrap();
        let anchor=crate::document_location::Anchor::open(&path).unwrap();i.content_digest=crate::mcp::source_digest("native saved content");
        coordinator.record_native_write_for(&id,"document-0",i.clone(),path.clone(),i.content_digest.clone(),i.revision,anchor.token());
        coordinator.reconcile_saved("document-0",&id,&i,&path).unwrap();coordinator.accept("document-0",&id,ReplyPhase::Saved,&i).unwrap();sealed(&coordinator,&id);
        assert!(coordinator.seal(&id,&package(),true).is_err(),"native disk proof is mandatory");
        std::fs::write(&path,"externally changed content").unwrap();
        assert!(coordinator.verify_saved_disk(&id,"document-0").is_err());assert!(coordinator.seal(&id,&package(),true).is_err());assert!(!coordinator.take_update_exit());
        std::fs::write(&path,"native saved content").unwrap();coordinator.verify_saved_disk(&id,"document-0").unwrap();
        // Replacing the path with the same bytes must not reuse the old anchor.
        let replacement=root.path().join("replacement.md");std::fs::write(&replacement,"native saved content").unwrap();std::fs::rename(&replacement,&path).unwrap();
        assert!(coordinator.verify_saved_disk(&id,"document-0").is_err());assert!(coordinator.seal(&id,&package(),true).is_err());coordinator.abort(&id);assert!(!coordinator.take_update_exit());
    }

    #[test]
    fn lost_or_recreated_participant_at_begin_is_an_error_not_a_panic(){
        let registry=AdmissionRegistry::default();registry.reserve_document("document-a").unwrap().commit();registry.document_ready("document-a");
        let barrier=registry.close().unwrap();registry.document_destroyed("document-a");
        assert!(captured_participants(&barrier,&registry.snapshot()).is_err());
        assert!(registry.reserve_document("document-a").is_err());
        registry.cancel_current();registry.reserve_document("document-a").unwrap().commit();registry.document_ready("document-a");
        assert!(captured_participants(&barrier,&registry.snapshot()).is_err(),"a recreated same-label instance cannot be included in the old epoch");
        drop(barrier);assert!(registry.admit().is_ok());
    }

    #[test]
    fn cancelled_native_gesture_cannot_deadlock_later_quit_or_another_document() {
        let registry=AdmissionRegistry::default();
        for label in ["document-a","document-b"]{registry.reserve_document(label).unwrap().commit();registry.document_ready(label);}
        let coordinator=UpdateCoordinator::default();let nonce=registry.snapshot().instances["document-a"];
        coordinator.begin(&registry,package()).unwrap();
        let denied=coordinator.begin_native_close(&registry,"document-a",nonce).unwrap();assert!(!denied.allowed);
        assert_eq!(coordinator.begin_quit(&registry).unwrap().0,crate::update_admission::CloseDecision::Allowed);
        let close=coordinator.begin_close(&registry,"document-a",nonce).unwrap();assert!(close.allowed);
        assert!(coordinator.begin(&registry,package()).is_err());
        coordinator.complete_close("document-a",nonce,close.action_id).unwrap();coordinator.cancel_quit(Some("document-a"));
        assert_eq!(registry.snapshot().participants.len(),2,"cancelled unsaved close keeps both documents registered");
        assert!(coordinator.begin(&registry,package()).is_ok());
    }

    #[test]
    fn new_native_gesture_replaces_only_denied_claim_and_keeps_stale_callbacks_fenced() {
        let registry=AdmissionRegistry::default();registry.reserve_document("document-a").unwrap().commit();registry.document_ready("document-a");
        let coordinator=UpdateCoordinator::default();let nonce=registry.snapshot().instances["document-a"];
        coordinator.begin(&registry,package()).unwrap();
        let denied=coordinator.begin_native_close(&registry,"document-a",nonce).unwrap();assert!(!denied.allowed);
        let next=coordinator.begin_native_close(&registry,"document-a",nonce).unwrap();assert!(next.allowed);assert_ne!(next.action_id,denied.action_id);
        assert!(coordinator.legacy_close_denied("document-a",nonce));
        assert!(coordinator.complete_close("document-a",nonce,denied.action_id).is_err());
        assert_eq!(coordinator.begin_native_close(&registry,"document-a",nonce).unwrap().action_id,next.action_id);
        assert!(coordinator.begin(&registry,package()).is_err(),"a real unsaved-document close still blocks preparation");
        coordinator.complete_close("document-a",nonce,next.action_id).unwrap();
        assert!(coordinator.begin(&registry,package()).is_ok());
    }

    #[test]
    fn denied_native_close_without_renderer_ack_does_not_block_retry() {
        let registry=AdmissionRegistry::default();registry.reserve_document("document-a").unwrap().commit();registry.document_ready("document-a");
        let coordinator=UpdateCoordinator::default();let nonce=registry.snapshot().instances["document-a"];
        coordinator.begin(&registry,package()).unwrap();
        let denied=coordinator.begin_close(&registry,"document-a",nonce).unwrap();assert!(!denied.allowed);
        assert!(coordinator.begin(&registry,package()).is_ok(),"a cancelled native gesture has no active document write to wait for, even if its renderer never acknowledges");
    }

    #[test]
    fn ordinary_close_claim_blocks_new_prepare_and_same_action_stays_cancelled(){
        let registry=AdmissionRegistry::default();registry.reserve_document("document-a").unwrap().commit();registry.document_ready("document-a");
        let coordinator=UpdateCoordinator::default();let nonce=registry.snapshot().instances["document-a"];
        let action=coordinator.begin_close(&registry,"document-a",nonce).unwrap();assert!(action.allowed);
        assert!(coordinator.begin(&registry,package()).is_err(),"an ordinary close already starting must exclude a new prepare until destroy or exact cancelled completion");
        assert!(coordinator.complete_close("document-a",nonce,action.action_id+1).is_err());
        coordinator.complete_close("document-a",nonce,action.action_id).unwrap();
        let id=coordinator.begin(&registry,package()).unwrap();
        let cancelled=coordinator.begin_close(&registry,"document-a",nonce).unwrap();assert!(!cancelled.allowed);
        let repeated=coordinator.begin_close(&registry,"document-a",nonce).unwrap();assert_eq!(cancelled.action_id,repeated.action_id);assert!(!repeated.allowed);
        assert!(coordinator.accept("document-a",&id,ReplyPhase::Frozen,&identity()).is_err());
        coordinator.complete_close("document-a",nonce,cancelled.action_id).unwrap();
        assert!(coordinator.legacy_close_denied("document-a",nonce),"late unidentified callbacks remain fenced after exact cancelled completion");
        assert!(!coordinator.legacy_close_denied("document-a",nonce+1));
        assert!(coordinator.complete_close("document-a",nonce,cancelled.action_id).is_err());
        let newer=coordinator.begin_close(&registry,"document-a",nonce).unwrap();assert!(newer.allowed);assert!(newer.action_id>cancelled.action_id);
        assert!(coordinator.complete_close("document-a",nonce,cancelled.action_id).is_err());
        assert!(coordinator.close_action("document-a",nonce).is_some());
        coordinator.complete_close("document-a",nonce,newer.action_id).unwrap();
        assert!(coordinator.legacy_close_denied("document-a",nonce));
        coordinator.participant_lost("document-a");assert!(!coordinator.legacy_close_denied("document-a",nonce));
    }

    #[test]
    fn ordinary_quit_claim_and_prepare_are_mutually_exclusive(){
        let registry=AdmissionRegistry::default();let coordinator=UpdateCoordinator::default();
        assert_eq!(coordinator.begin_quit(&registry).unwrap().0,crate::update_admission::CloseDecision::Allowed);
        assert!(coordinator.begin(&registry,package()).is_err());coordinator.cancel_quit(None);
        let id=coordinator.begin(&registry,package()).unwrap();
        let (decision,notice)=coordinator.begin_quit(&registry).unwrap();
        assert_eq!(decision,crate::update_admission::CloseDecision::CancelledPrepare);assert_eq!(notice.unwrap().0,id);
        assert!(!coordinator.take_update_exit());assert!(registry.admit().is_ok());
    }
    #[test]
    fn helper_failure_expiry_and_stale_native_write_never_commit(){
        let (coordinator,registry,id)=fixture(0);let permit=coordinator.seal(&id,&package(),true).unwrap();
        assert!(coordinator.commit(permit,&package(),false,||Ok(())).is_err());coordinator.abort(&id);
        let next=coordinator.begin(&registry,package()).unwrap();coordinator.finish_drain(&next).unwrap();
        let mut permit=coordinator.seal(&next,&package(),true).unwrap();permit.expires=Instant::now();
        assert!(coordinator.commit(permit,&package(),true,||Ok(())).is_err());coordinator.abort(&next);
        assert!(!coordinator.take_update_exit());assert!(registry.admit().is_ok());
    }

    #[test]
    fn frozen_snapshot_adopts_only_native_settled_revision_with_same_binding(){
        let (coordinator,_registry,id)=fixture(1);
        let challenge=coordinator.expect("document-0",&id,ReplyPhase::Frozen).unwrap();
        let original=challenge.identity;let mut settled=original.clone();settled.revision+=1;settled.content_digest="native-settled-ime-and-draft-digest".into();
        let mut wrong=settled.clone();wrong.window_nonce+=1;assert!(coordinator.adopt_frozen_snapshot("document-0",&id,&wrong).is_err());
        let mut wrong=settled.clone();wrong.session_id.push('x');assert!(coordinator.adopt_frozen_snapshot("document-0",&id,&wrong).is_err());
        let mut wrong=settled.clone();wrong.document_id.push('x');assert!(coordinator.adopt_frozen_snapshot("document-0",&id,&wrong).is_err());
        let mut wrong=settled.clone();wrong.authorization_epoch+=1;assert!(coordinator.adopt_frozen_snapshot("document-0",&id,&wrong).is_err());
        assert!(coordinator.adopt_frozen_snapshot("document-0",&id,&settled).is_ok(),"a current native snapshot after natural input settlement must replace only the pre-settle revision/digest");
        assert!(coordinator.accept("document-0",&id,ReplyPhase::Frozen,&original).is_err());
        coordinator.accept("document-0",&id,ReplyPhase::Frozen,&settled).unwrap();
    }

    #[test]
    fn abort_revokes_sealed_permit_and_retry_has_new_id(){
        let (coordinator,registry,id)=fixture(0);let permit=coordinator.seal(&id,&package(),true).unwrap();coordinator.abort(&id);
        let next=coordinator.begin(&registry,package()).unwrap();assert_ne!(id,next);
        assert!(coordinator.commit(permit,&package(),true,||Ok(())).is_err());assert!(!coordinator.take_update_exit());
        assert!(coordinator.labels(&next).is_ok());coordinator.abort(&next);
    }
    #[test]
    fn participant_saved_scope_requires_declared_current_generation(){
        let (coordinator,registry,id)=fixture(1);frozen(&coordinator,&id);coordinator.expect("document-0",&id,ReplyPhase::Saved).unwrap();
        assert!(coordinator.admit_declared_save(&registry,"document-0",crate::update_admission::SaveOperation::Write,None).is_err(),"an old no-ID callback must not borrow a new participant Saved scope");
        let (lease,binding)=coordinator.admit_declared_save(&registry,"document-0",crate::update_admission::SaveOperation::Write,Some(&id)).unwrap();
        assert_eq!(binding,Some(id));drop(lease);
    }
    #[test]
    fn participant_stale_generation_refused_after_abort_reopens_admission(){
        let (coordinator,registry,id)=fixture(1);coordinator.abort(&id);
        assert!(coordinator.admit_declared_save(&registry,"document-0",crate::update_admission::SaveOperation::Checkpoint,Some(&id)).is_err(),"a declared stale selector must fail even when ordinary admission has reopened");
        let (lease,binding)=coordinator.admit_declared_save(&registry,"document-0",crate::update_admission::SaveOperation::Checkpoint,None).unwrap();
        assert_eq!(binding,None);drop(lease);
    }
    #[test]
    fn participant_old_generation_cannot_borrow_retried_saved_scope(){
        let (coordinator,registry,old)=fixture(1);coordinator.abort(&old);
        let id=coordinator.begin(&registry,package()).unwrap();coordinator.finish_drain(&id).unwrap();
        let mut value=identity();value.window_nonce=registry.snapshot().instances["document-0"];coordinator.settle_identity("document-0",&id,value).unwrap();frozen(&coordinator,&id);
        coordinator.expect("document-0",&id,ReplyPhase::Saved).unwrap();
        assert!(coordinator.admit_declared_save(&registry,"document-0",crate::update_admission::SaveOperation::Resource,Some(&old)).is_err(),"old declared resource callback must not borrow retry authority");
        assert!(coordinator.admit_declared_save(&registry,"document-0",crate::update_admission::SaveOperation::Resource,Some(&id)).is_ok());
    }

}
