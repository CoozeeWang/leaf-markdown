//! Short-lock native write admission. Leases follow actual I/O, even when an
//! async caller is cancelled. No registry lock crosses I/O, UI dispatch or await.
use std::{collections::{BTreeMap,VecDeque},path::PathBuf,sync::{Arc,Mutex,MutexGuard}};
pub(crate) const BUSY:&str="update_admission_closed";
const MAX_OPEN_REQUESTS:usize=32;
#[derive(Clone,Copy,Debug,Eq,PartialEq)]
pub(crate) struct AdmissionEpoch(u64);
#[derive(Clone,Copy,Debug,Eq,PartialEq)]
pub(crate) enum AdmissionState {Open,Draining,Closed,Sealed,Committed,AbortDraining}
#[derive(Clone,Copy,Debug,Eq,PartialEq)]
pub(crate) enum CloseDecision {Allowed,CancelledPrepare,CommittedBlocked}
#[derive(Clone,Debug,Eq,PartialEq)]
pub(crate) enum OpenRequest {Document(PathBuf),NewMarkdown(PathBuf)}
#[derive(Clone,Copy,Debug,Eq,PartialEq)]
pub(crate) enum SaveOperation {Write,Checkpoint,Resource}
#[derive(Clone,Debug)]
pub(crate) struct AdmissionSnapshot {
    pub epoch:AdmissionEpoch,pub state:AdmissionState,pub active:usize,
    /// false includes windows or renderers still initializing.
    pub participants:BTreeMap<String,bool>,pub queued_opens:usize,
    pub instances:BTreeMap<String,u64>,
}
#[derive(Clone,Debug)]
enum Scope {Ordinary,Save{transaction:u64,permit:u64},Settle,Renderer{instance:u64,session:String,call:String}}
#[derive(Clone,Debug)]
struct Activity {epoch:AdmissionEpoch,label:Option<String>,scope:Scope}
struct State {
    epoch:AdmissionEpoch,sequence:u64,transaction:Option<u64>,sealed:bool,committed:bool,abort_draining:bool,
    active:BTreeMap<u64,Activity>,participants:BTreeMap<String,bool>,instances:BTreeMap<String,u64>,
    permits:BTreeMap<String,(u64,u64)>,pending:VecDeque<OpenRequest>,
    reopen:Option<Arc<dyn Fn()+Send+Sync>>,
}
struct Inner {state:Mutex<State>,changed:tokio::sync::Notify}
#[derive(Clone)]
pub(crate) struct AdmissionRegistry(Arc<Inner>);
impl Default for AdmissionRegistry {
    fn default()->Self {Self(Arc::new(Inner {state:Mutex::new(State {
        epoch:AdmissionEpoch(1),sequence:0,transaction:None,sealed:false,committed:false,abort_draining:false,
        active:BTreeMap::new(),participants:BTreeMap::new(),instances:BTreeMap::new(),permits:BTreeMap::new(),
        pending:VecDeque::new(),reopen:None,
    }),changed:tokio::sync::Notify::new()}))}
}
fn lock(inner:&Inner)->MutexGuard<'_,State> {inner.state.lock().unwrap_or_else(|error|error.into_inner())}
fn next(state:&mut State)->Result<u64,String> {
    state.sequence=state.sequence.checked_add(1).ok_or("admission_sequence_exhausted")?;Ok(state.sequence)
}
fn mode(state:&State)->AdmissionState {
    if state.committed{return AdmissionState::Committed;}
    if state.sealed{return AdmissionState::Sealed;}
    if state.transaction.is_some(){if state.active.is_empty(){AdmissionState::Closed}else{AdmissionState::Draining}}
    else if state.abort_draining{AdmissionState::AbortDraining}else{AdmissionState::Open}
}
fn ordinary_allowed(state:&State,label:Option<&str>)->bool {
    if state.transaction.is_some(){return false;}
    if state.active.values().any(|activity|matches!(activity.scope,Scope::Renderer{..})&&(label.is_none()||activity.label.as_deref()==label)){return false;}
    if !state.abort_draining{return true;}
    // Global I/O conflicts with all survivors; independent documents may resume.
    label.is_some_and(|label|state.active.values().all(|activity|activity.label.as_deref().is_some_and(|old|old!=label)))
}
impl AdmissionRegistry {
    pub(crate) fn snapshot(&self)->AdmissionSnapshot {
        let state=lock(&self.0);AdmissionSnapshot {epoch:state.epoch,state:mode(&state),active:state.active.len(),participants:state.participants.clone(),queued_opens:state.pending.len(),instances:state.instances.clone()}
    }
    fn issue(&self,state:&mut State,label:Option<&str>,scope:Scope)->Result<OperationLease,String> {
        let id=next(state)?;state.active.insert(id,Activity{epoch:state.epoch,label:label.map(str::to_owned),scope});
        Ok(OperationLease(Arc::new(Ticket{registry:self.clone(),id})))
    }
    pub(crate) fn admit(&self)->Result<OperationLease,String>{self.admit_for(None)}
    pub(crate) fn document_mutation_allowed(&self,label:&str)->bool{ordinary_allowed(&lock(&self.0),Some(label))}
    pub(crate) async fn run_detached<T,F,Fut>(&self,lease:OperationLease,operation:F)->Result<T,String>
    where T:Send+'static,F:FnOnce(OperationLease)->Fut+Send+'static,Fut:std::future::Future<Output=Result<T,String>>+Send+'static {
        tauri::async_runtime::spawn(async move{lease.recheck()?;operation(lease.clone()).await}).await.map_err(|_|"native_operation_failed")?
    }
    pub(crate) fn admit_for(&self,label:Option<&str>)->Result<OperationLease,String> {
        let mut state=lock(&self.0);if !ordinary_allowed(&state,label){return Err(BUSY.into());}
        self.issue(&mut state,label,Scope::Ordinary)
    }
    /// A native SaveScope, never a renderer-supplied ID, authorizes these calls.
    pub(crate) fn admit_save(&self,label:&str,_operation:SaveOperation)->Result<OperationLease,String> {
        let mut state=lock(&self.0);
        if state.sealed{return Err(BUSY.into());}
        if ordinary_allowed(&state,Some(label)){return self.issue(&mut state,Some(label),Scope::Ordinary);}
        let (transaction,permit)=state.permits.get(label).copied().ok_or(BUSY)?;
        if state.transaction!=Some(transaction){return Err(BUSY.into());}
        self.issue(&mut state,Some(label),Scope::Save{transaction,permit})
    }
    /// Native callers validate an existing task; this never authorizes begin/apply.
    pub(crate) fn admit_settle(&self,label:&str)->Result<OperationLease,String> {
        let mut state=lock(&self.0);if state.sealed{return Err(BUSY.into());}
        if !state.participants.contains_key(label){return Err("admission_unknown_participant".into());}
        self.issue(&mut state,Some(label),Scope::Settle)
    }
    pub(crate) fn admit_renderer(&self,label:&str,session:&str,call:&str)->Result<OperationLease,String> {
        let mut state=lock(&self.0);
        if !ordinary_allowed(&state,Some(label)){return Err(BUSY.into());}
        let instance=*state.instances.get(label).ok_or("admission_unknown_participant")?;
        self.issue(&mut state,Some(label),Scope::Renderer{instance,session:session.into(),call:call.into()})
    }
    /// A Save As rebind is a necessary child of the currently native-issued
    /// save permission. This exception never applies to begin/apply dispatch.
    pub(crate) fn admit_binding(&self,label:&str,session:&str,call:&str)->Result<OperationLease,String>{
        {let mut state=lock(&self.0);
            if state.sealed{return Err(BUSY.into());}
            if let Some(transaction)=state.transaction{
                let (owner,permit)=state.permits.get(label).copied().ok_or(BUSY)?;
                if owner!=transaction||!state.instances.contains_key(label){return Err(BUSY.into());}
                return self.issue(&mut state,Some(label),Scope::Save{transaction,permit});
            }
        }
        self.admit_renderer(label,session,call)
    }
    pub(crate) fn has_renderer_fence(&self,label:&str)->bool {
        lock(&self.0).active.values().any(|activity|activity.label.as_deref()==Some(label)&&matches!(activity.scope,Scope::Renderer{..}))
    }
    /// Reservation and close share a lock: pending windows cannot miss the snapshot.
    pub(crate) fn reserve_document(&self,label:&str)->Result<DocumentReservation,String> {
        let mut state=lock(&self.0);if !ordinary_allowed(&state,None){return Err(BUSY.into());}
        if state.participants.contains_key(label){return Err("admission_duplicate_participant".into());}
        let lease=self.issue(&mut state,Some(label),Scope::Ordinary)?;
        state.participants.insert(label.into(),false);
        state.instances.insert(label.into(),lease.0.id);
        Ok(DocumentReservation{registry:self.clone(),label:label.into(),lease:Some(lease),committed:false})
    }
    pub(crate) fn document_ready(&self,label:&str) {
        if let Some(ready)=lock(&self.0).participants.get_mut(label){*ready=true;}
        self.0.changed.notify_waiters();
    }
    pub(crate) fn document_destroyed(&self,label:&str) {
        let mut state=lock(&self.0);state.participants.remove(label);state.instances.remove(label);state.permits.remove(label);
        drop(state);self.0.changed.notify_waiters();
    }
    pub(crate) fn close(&self)->Result<BarrierGuard,String> {
        let mut state=lock(&self.0);if state.transaction.is_some()||state.abort_draining{return Err(BUSY.into());}
        let transaction=next(&mut state)?;
        state.epoch=AdmissionEpoch(state.epoch.0.checked_add(1).ok_or("admission_epoch_exhausted")?);
        state.transaction=Some(transaction);state.sealed=false;
        Ok(BarrierGuard{registry:self.clone(),transaction,epoch:state.epoch,participants:state.participants.clone(),instances:state.instances.clone(),finished:false})
    }
    pub(crate) fn cancel_current(&self)->bool {
        self.close_decision()==CloseDecision::CancelledPrepare
    }
    /// Decide a native close and invalidate the transaction in one critical
    /// section. Callers never interpret a boolean false as permission to quit.
    pub(crate) fn close_decision(&self)->CloseDecision {
        let mut state=lock(&self.0);
        if state.committed{return CloseDecision::CommittedBlocked;}
        let Some(transaction)=state.transaction else{return CloseDecision::Allowed;};
        let Some(hook)=abort_state(&mut state,transaction) else{return CloseDecision::CommittedBlocked;};
        drop(state);self.0.changed.notify_waiters();if let Some(hook)=hook{hook();}
        CloseDecision::CancelledPrepare
    }
    pub(crate) fn queue_if_closed(&self,request:OpenRequest)->Result<bool,String> {
        let mut state=lock(&self.0);if ordinary_allowed(&state,None){return Ok(false);}
        if state.pending.len()>=MAX_OPEN_REQUESTS{return Err("update_open_queue_full".into());}
        state.pending.push_back(request);Ok(true)
    }
    pub(crate) fn take_pending(&self)->VecDeque<OpenRequest> {
        let mut state=lock(&self.0);if !ordinary_allowed(&state,None){return VecDeque::new();}
        std::mem::take(&mut state.pending)
    }
    pub(crate) fn set_reopen_hook(&self,hook:Arc<dyn Fn()+Send+Sync>){lock(&self.0).reopen=Some(hook);}
    pub(crate) async fn wait_idle(&self,budget:std::time::Duration)->Result<(),String> {
        tokio::time::timeout(budget,async {loop {
            let changed=self.0.changed.notified();tokio::pin!(changed);changed.as_mut().enable();
            if lock(&self.0).active.is_empty(){return;}changed.await;
        }}).await.map_err(|_|"admission_drain_timeout".into())
    }
    fn abort(&self,transaction:u64)->bool {
        let mut state=lock(&self.0);let Some(hook)=abort_state(&mut state,transaction)else{return false;};
        drop(state);self.0.changed.notify_waiters();if let Some(hook)=hook{hook();}true
    }
}
fn abort_state(state:&mut State,transaction:u64)->Option<Option<Arc<dyn Fn()+Send+Sync>>>{
    if state.committed||state.transaction!=Some(transaction){return None;}
    // Exhaustion fails closed rather than reusing a generation.
    let epoch=state.epoch.0.checked_add(1)?;
    state.transaction=None;state.sealed=false;state.permits.clear();state.epoch=AdmissionEpoch(epoch);
    state.abort_draining=!state.active.is_empty();
    Some(if !state.abort_draining{state.reopen.clone()}else{None})
}
struct Ticket {registry:AdmissionRegistry,id:u64}
impl Drop for Ticket {
    fn drop(&mut self) {
        let mut state=lock(&self.registry.0);let removed=state.active.remove(&self.id);
        let resumed=state.abort_draining&&state.active.is_empty();if resumed{state.abort_draining=false;}
        let fence_finished=removed.is_some_and(|activity|matches!(activity.scope,Scope::Renderer{..}))&&state.transaction.is_none()&&ordinary_allowed(&state,None);
        let hook=if resumed||fence_finished{state.reopen.clone()}else{None};
        drop(state);self.registry.0.changed.notify_waiters();if let Some(hook)=hook{hook();}
    }
}
/// Clones retain one activity ticket; only the final drop decrements the ledger.
#[derive(Clone)]
pub(crate) struct OperationLease(Arc<Ticket>);
/// Detach the complete serialized operation from the lifetime of its IPC caller.
/// Dropping a JoinHandle does not abort the owned task. The task retains both
/// broker serialization and a root ticket through post-I/O native bookkeeping.
pub(crate) async fn run_operation<T,F,Fut>(lease:OperationLease,queue:Arc<tokio::sync::Mutex<()>>,operation:F)->Result<T,String>
where T:Send+'static,F:FnOnce(OperationLease)->Fut+Send+'static,Fut:std::future::Future<Output=Result<T,String>>+Send+'static {
    tauri::async_runtime::spawn(async move {
        let _serial=queue.lock().await;
        lease.recheck()?;
        operation(lease.clone()).await
    }).await.map_err(|_|"native_operation_failed")?
}
impl OperationLease {
    pub(crate) fn epoch(&self)->AdmissionEpoch{lock(&self.0.registry.0).active[&self.0.id].epoch}
    /// Recheck after dialogs, queue waits and deferred callbacks before new I/O.
    /// Once synchronous I/O starts, retain the lease until it actually returns.
    pub(crate) fn recheck(&self)->Result<(),String> {
        let state=lock(&self.0.registry.0);let activity=state.active.get(&self.0.id).ok_or("admission_lease_stale")?;
        let valid=match &activity.scope {
            Scope::Ordinary=>activity.epoch==state.epoch&&ordinary_allowed(&state,activity.label.as_deref()),
            Scope::Save{transaction,permit}=>state.transaction==Some(*transaction)&&activity.label.as_ref().and_then(|label|state.permits.get(label))==Some(&(*transaction,*permit)),
            Scope::Settle=>!state.sealed,
            Scope::Renderer{instance,session,call}=>!session.is_empty()&&!call.is_empty()&&activity.epoch==state.epoch&&!state.sealed&&activity.label.as_ref().and_then(|label|state.instances.get(label))==Some(instance),
        };if valid{Ok(())}else{Err("admission_epoch_stale".into())}
    }
}
pub(crate) struct DocumentReservation {registry:AdmissionRegistry,label:String,lease:Option<OperationLease>,committed:bool}
impl DocumentReservation {
    pub(crate) fn recheck(&self)->Result<(),String>{self.lease.as_ref().ok_or("admission_reservation_stale")?.recheck()}
    pub(crate) fn commit(mut self){self.committed=true;self.lease.take();}
}
impl Drop for DocumentReservation {fn drop(&mut self){if !self.committed{self.registry.document_destroyed(&self.label);}}}
pub(crate) struct BarrierGuard {registry:AdmissionRegistry,transaction:u64,pub epoch:AdmissionEpoch,pub participants:BTreeMap<String,bool>,instances:BTreeMap<String,u64>,finished:bool}
impl BarrierGuard {
    pub(crate) fn save_scope(&self,label:&str)->Result<SaveScope,String> {
        let mut state=lock(&self.registry.0);
        if state.sealed{return Err(BUSY.into());}
        if state.transaction!=Some(self.transaction)||state.epoch!=self.epoch{return Err("admission_transaction_stale".into());}
        if !state.active.is_empty()||!state.permits.is_empty(){return Err("admission_not_drained".into());}
        if !self.participants.contains_key(label)||state.participants.get(label)!=Some(&true){return Err("admission_participant_not_ready".into());}
        let permit=next(&mut state)?;state.permits.insert(label.into(),(self.transaction,permit));
        Ok(SaveScope{registry:self.registry.clone(),label:label.into(),transaction:self.transaction,permit})
    }
    pub(crate) fn validate_idle(&self)->Result<(),String> {
        let state=lock(&self.registry.0);
        if state.transaction!=Some(self.transaction)||state.epoch!=self.epoch{return Err("admission_transaction_stale".into());}
        if !state.active.is_empty()||!state.permits.is_empty(){return Err("admission_not_drained".into());}
        if state.instances!=self.instances||state.participants.keys().ne(self.participants.keys())||state.participants.values().any(|ready|!*ready){return Err("admission_participants_changed".into());}Ok(())
    }
    pub(crate) fn abort(mut self){self.registry.abort(self.transaction);self.finished=true;}
    /// Admission becomes sealed in the same critical section as the final idle
    /// and participant check. No new settle reply can slip into a commit gap.
    pub(crate) fn seal(&self)->Result<SealToken,String> {
        let mut state=lock(&self.registry.0);
        if state.sealed||state.transaction!=Some(self.transaction)||state.epoch!=self.epoch{return Err("admission_transaction_stale".into());}
        if !state.active.is_empty()||!state.permits.is_empty(){return Err("admission_not_drained".into());}
        if state.instances!=self.instances||state.participants.keys().ne(self.participants.keys())||state.participants.values().any(|ready|!*ready){return Err("admission_participants_changed".into());}
        state.sealed=true;
        Ok(SealToken{registry:self.registry.clone(),transaction:self.transaction,epoch:self.epoch,instances:self.instances.clone()})
    }
    /// Future coordinator consumes this only after its package/save-ledger proof.
    /// Consuming does not reopen admission; installation owns the sealed process.
    pub(crate) fn commit(mut self,token:SealToken)->Result<(),String> {
        if !Arc::ptr_eq(&self.registry.0,&token.registry.0)||token.transaction!=self.transaction||token.epoch!=self.epoch||token.instances!=self.instances{return Err("admission_seal_stale".into());}
        {let mut state=lock(&self.registry.0);
        if state.committed||!state.sealed||state.transaction!=Some(self.transaction)||!state.active.is_empty()||!state.permits.is_empty()||state.instances!=self.instances||state.participants.keys().ne(self.participants.keys())||state.participants.values().any(|ready|!*ready){return Err("admission_seal_stale".into());}
        state.committed=true;}
        self.finished=true;Ok(())
    }
}
pub(crate) struct SealToken {registry:AdmissionRegistry,transaction:u64,epoch:AdmissionEpoch,instances:BTreeMap<String,u64>}
impl Drop for BarrierGuard {fn drop(&mut self){if !self.finished{self.registry.abort(self.transaction);}}}
pub(crate) struct SaveScope {registry:AdmissionRegistry,label:String,transaction:u64,permit:u64}
impl Drop for SaveScope {
    fn drop(&mut self){let mut state=lock(&self.registry.0);
        if state.permits.get(&self.label)==Some(&(self.transaction,self.permit)){state.permits.remove(&self.label);}
        drop(state);self.registry.0.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_mutators_and_deadlocks() {
        let registry=AdmissionRegistry::default();
        let callback=registry.admit_for(Some("document-resource")).unwrap();
        let root=tempfile::tempdir().unwrap();let document=root.path().join("sample.md");
        std::fs::write(&document,"synthetic resource document").unwrap();
        let barrier=registry.close().unwrap();
        let result=crate::resources::with_admission(&callback,||crate::resources::import_managed(&document,"late.png",b"synthetic image bytes",None));
        assert!(result.is_err(),"late resource callback must reject before creating attachment bytes");
        assert!(!root.path().join("sample.assets").exists(),"rejected callback must not create its asset directory");
        drop(callback);barrier.validate_idle().unwrap();
        barrier.abort();
        let checkpoint=registry.admit_for(Some("document-resource")).unwrap();
        let recovery=crate::recovery::Store::new(root.path().join("recovery"));
        let barrier=registry.close().unwrap();
        let result=crate::recovery::with_admission(&checkpoint,||recovery.checkpoint("synthetic-draft",None,"late checkpoint","synthetic-owner",false));
        assert!(result.is_err());assert!(!root.path().join("recovery").exists());drop(checkpoint);barrier.abort();
        registry.reserve_document("document-resource").unwrap().commit();registry.document_ready("document-resource");
        let barrier=registry.close().unwrap();let permission=barrier.save_scope("document-resource").unwrap();
        let save=registry.admit_save("document-resource",SaveOperation::Checkpoint).unwrap();
        crate::recovery::with_admission(&save,||recovery.checkpoint("synthetic-draft",None,"protected transaction draft","synthetic-owner",false)).unwrap();
        let resource=registry.admit_save("document-resource",SaveOperation::Resource).unwrap();
        let relative=crate::resources::with_admission(&resource,||crate::resources::import_managed(&document,"permitted.png",b"synthetic admitted bytes",None)).unwrap();
        assert_eq!(std::fs::read(root.path().join(relative)).unwrap(),b"synthetic admitted bytes");
        barrier.abort();assert!(save.recheck().is_err());
        assert_eq!(recovery.read("synthetic-draft").unwrap().draft.unwrap().content,"protected transaction draft");
        drop(permission);drop(save);drop(resource);assert_eq!(registry.snapshot().active,0);
    }

    #[test]
    fn closing_admission_rejects_new_writes() {
        let registry = AdmissionRegistry::default();
        let prior = registry.admit().expect("pre-barrier operation admitted");
        let barrier = registry.close().expect("barrier acquired");
        assert!(registry.admit().is_err(), "post-barrier ordinary write must be rejected");
        assert_eq!(registry.snapshot().active,1);
        assert_eq!(registry.snapshot().state,AdmissionState::Draining);
        drop(prior);
        assert_eq!(registry.snapshot().state,AdmissionState::Closed);
        barrier.validate_idle().unwrap();
        drop(barrier);
        assert!(registry.admit().is_ok());
    }

    #[test]
    fn leases_drop_once_on_error_panic_and_last_child() {
        let registry=AdmissionRegistry::default();let lease=registry.admit().unwrap();let child=lease.clone();
        drop(lease);assert_eq!(registry.snapshot().active,1);drop(child);assert_eq!(registry.snapshot().active,0);
        let _=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{let _lease=registry.admit().unwrap();panic!("injected I/O panic");}));
        assert_eq!(registry.snapshot().active,0);
        let failed=(||->Result<(),String>{let _lease=registry.admit()?;Err("injected I/O failure".into())})();
        assert!(failed.is_err());assert_eq!(registry.snapshot().active,0);
    }
    #[test]
    fn pending_documents_are_in_atomic_snapshot() {
        let registry=AdmissionRegistry::default();let pending=registry.reserve_document("document-pending").unwrap();
        let barrier=registry.close().unwrap();assert_eq!(barrier.participants.get("document-pending"),Some(&false));
        assert!(registry.reserve_document("document-late").is_err());pending.commit();
        assert!(barrier.validate_idle().is_err());registry.document_ready("document-pending");barrier.validate_idle().unwrap();
    }
    #[test]
    fn transaction_save_is_native_scoped_and_stale_after_abort() {
        let registry=AdmissionRegistry::default();registry.reserve_document("document-a").unwrap().commit();registry.document_ready("document-a");
        let barrier=registry.close().unwrap();assert!(registry.admit_save("document-a",SaveOperation::Write).is_err());
        let scope=barrier.save_scope("document-a").unwrap();let lease=registry.admit_save("document-a",SaveOperation::Write).unwrap();
        assert!(registry.admit_for(Some("document-a")).is_err());assert!(registry.admit_save("document-b",SaveOperation::Write).is_err());
        lease.recheck().unwrap();barrier.abort();assert!(lease.recheck().is_err());assert_eq!(registry.snapshot().state,AdmissionState::AbortDraining);
        assert!(registry.admit_for(Some("document-a")).is_err());assert!(registry.admit_for(Some("document-other")).is_ok());
        drop(scope);drop(lease);assert_eq!(registry.snapshot().state,AdmissionState::Open);
    }
    #[test]
    fn os_open_queue_is_bounded_ordered_and_restored_on_abort() {
        let registry=AdmissionRegistry::default();let barrier=registry.close().unwrap();
        for index in 0..32 {assert!(registry.queue_if_closed(OpenRequest::Document(PathBuf::from(format!("sample-{index}.md")))).unwrap());}
        assert!(registry.queue_if_closed(OpenRequest::Document("overflow.md".into())).is_err());assert!(registry.take_pending().is_empty());
        barrier.abort();let pending=registry.take_pending();assert_eq!(pending.len(),32);
        assert_eq!(pending.front(),Some(&OpenRequest::Document("sample-0.md".into())));assert_eq!(pending.back(),Some(&OpenRequest::Document("sample-31.md".into())));
    }
    #[tokio::test]
    async fn cancelled_future_keeps_real_blocking_io_leased() {
        let registry=AdmissionRegistry::default();let lease=registry.admit_for(Some("document-a")).unwrap();
        let root=tempfile::tempdir().unwrap();let path=root.path().join("completed.md");let output=path.clone();
        let (started_tx,started_rx)=tokio::sync::oneshot::channel();let (release_tx,release_rx)=std::sync::mpsc::channel();
        let task=tokio::spawn(async move {tokio::task::spawn_blocking(move||{
            let _lease=lease;let _=started_tx.send(());
            release_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
            std::fs::write(output,"completed admitted write").unwrap();
        }).await.unwrap();});
        started_rx.await.unwrap();let barrier=registry.close().unwrap();task.abort();let _=task.await;
        barrier.abort();assert_eq!(registry.snapshot().active,1);assert_eq!(registry.snapshot().state,AdmissionState::AbortDraining);
        release_tx.send(()).unwrap();registry.wait_idle(std::time::Duration::from_secs(5)).await.unwrap();assert_eq!(registry.snapshot().state,AdmissionState::Open);
        assert_eq!(std::fs::read_to_string(path).unwrap(),"completed admitted write");
    }
    #[test]
    fn late_callback_rechecks_epoch_even_after_abort_and_retry() {
        let registry=AdmissionRegistry::default();let lease=registry.admit().unwrap();let epoch=lease.epoch();
        let barrier=registry.close().unwrap();assert_ne!(epoch,barrier.epoch);assert!(lease.recheck().is_err());
        barrier.abort();assert!(lease.recheck().is_err());drop(lease);let next=registry.close().unwrap();assert_ne!(epoch,next.epoch);
    }
    #[test]
    fn late_selector_result_never_starts_disk_io() {
        let registry=AdmissionRegistry::default();let selector=registry.admit().unwrap();
        let root=tempfile::tempdir().unwrap();let path=root.path().join("late-selection.md");
        let barrier=registry.close().unwrap();
        let result=selector.recheck().and_then(|()|std::fs::write(&path,"forbidden late result").map_err(|error|error.to_string()));
        assert!(result.is_err());assert!(!path.exists());
        barrier.abort();assert!(selector.recheck().is_err());assert!(!path.exists());
    }
    #[test]
    fn atomic_seal_blocks_new_settle_and_invalidates_old_tokens() {
        let registry=AdmissionRegistry::default();registry.reserve_document("document-a").unwrap().commit();registry.document_ready("document-a");
        let barrier=registry.close().unwrap();let settling=registry.admit_settle("document-a").unwrap();
        assert!(barrier.seal().is_err());drop(settling);
        let token=barrier.seal().unwrap();assert_eq!(registry.snapshot().state,AdmissionState::Sealed);
        assert!(registry.admit_settle("document-a").is_err());assert!(registry.admit_save("document-a",SaveOperation::Write).is_err());assert!(barrier.seal().is_err());
        assert!(registry.cancel_current());let replacement=registry.close().unwrap();
        assert!(replacement.commit(token).is_err());assert_eq!(registry.snapshot().state,AdmissionState::Open);
        drop(barrier);
        let current=registry.close().unwrap();let fresh=current.seal().unwrap();current.commit(fresh).unwrap();
        assert_eq!(registry.snapshot().state,AdmissionState::Committed);assert!(registry.admit().is_err());
        assert!(!registry.cancel_current());assert_eq!(registry.snapshot().state,AdmissionState::Committed);
        assert!(registry.queue_if_closed(OpenRequest::Document("queued-after-commit.md".into())).unwrap());
        assert!(registry.take_pending().is_empty());
    }
    #[test]
    fn atomic_close_decision_cancels_before_reopen_can_start_new_transaction(){
        let registry=AdmissionRegistry::default();let replacement=Arc::new(Mutex::new(None));
        let weak=Arc::downgrade(&registry.0);let slot=replacement.clone();
        registry.set_reopen_hook(Arc::new(move||{if let Some(inner)=weak.upgrade(){
            let next=AdmissionRegistry(inner).close().unwrap();*slot.lock().unwrap()=Some(next);
        }}));
        let previous=registry.close().unwrap();
        assert_eq!(registry.close_decision(),CloseDecision::CancelledPrepare,"a replacement begun by the post-unlock reopen hook must never turn the original decision into Allowed");
        assert_eq!(registry.snapshot().state,AdmissionState::Closed);
        drop(previous);assert_eq!(registry.snapshot().state,AdmissionState::Closed,"dropping the cancelled guard must not abort the new transaction");
        lock(&registry.0).reopen=None;
        replacement.lock().unwrap().take().unwrap().abort();assert_eq!(registry.close_decision(),CloseDecision::Allowed);
    }
    #[test]
    fn atomic_close_decision_never_reopens_committed_process(){
        let registry=AdmissionRegistry::default();let guard=registry.close().unwrap();let token=guard.seal().unwrap();guard.commit(token).unwrap();
        registry.queue_if_closed(OpenRequest::Document("queued-after-commit.md".into())).unwrap();let before=registry.snapshot();
        for _ in 0..3{assert_eq!(registry.close_decision(),CloseDecision::CommittedBlocked);assert!(!registry.cancel_current());}
        let after=registry.snapshot();assert_eq!(after.state,AdmissionState::Committed);assert_eq!(after.epoch,before.epoch);assert_eq!(after.queued_opens,1);assert!(registry.take_pending().is_empty());
    }
    #[tokio::test]
    async fn owned_operation_keeps_queue_and_bookkeeping_after_caller_cancellation() {
        let registry=AdmissionRegistry::default();let queue=Arc::new(tokio::sync::Mutex::new(()));
        let count=Arc::new(std::sync::atomic::AtomicUsize::new(0));let recorded=count.clone();
        let root=tempfile::tempdir().unwrap();let path=root.path().join("serialized.md");let output=path.clone();
        let lease=registry.admit().unwrap();let serial=queue.clone();
        let (started_tx,started_rx)=tokio::sync::oneshot::channel();let (release_tx,release_rx)=std::sync::mpsc::channel();
        let (recorded_tx,recorded_rx)=tokio::sync::oneshot::channel();
        let caller=tokio::spawn(async move {run_operation(lease,serial,move|lease|async move {
            tauri::async_runtime::spawn_blocking(move||{
                let _lease=lease;let _=started_tx.send(());
                release_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
                std::fs::write(output,"durable serialized result").unwrap();
            }).await.map_err(|_|"fixture_io_failed")?;
            recorded.fetch_add(1,std::sync::atomic::Ordering::SeqCst);let _=recorded_tx.send(());Ok(())
        }).await});
        started_rx.await.unwrap();caller.abort();let _=caller.await;
        assert!(queue.try_lock().is_err(),"real operation must retain broker serialization");
        assert_eq!(registry.snapshot().active,1);assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst),0);
        release_tx.send(()).unwrap();tokio::time::timeout(std::time::Duration::from_secs(5),recorded_rx).await.unwrap().unwrap();
        registry.wait_idle(std::time::Duration::from_secs(5)).await.unwrap();
        assert!(queue.try_lock().is_ok());assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst),1);
        assert_eq!(std::fs::read_to_string(path).unwrap(),"durable serialized result");
    }
    #[test]
    fn renderer_fence_blocks_old_and_new_same_document_work_in_open_state() {
        let registry=AdmissionRegistry::default();registry.reserve_document("document-a").unwrap().commit();registry.document_ready("document-a");
        let prior=registry.admit_for(Some("document-a")).unwrap();
        let fence=registry.admit_renderer("document-a","native-session-a","native-call-a").unwrap();
        assert_eq!(registry.snapshot().state,AdmissionState::Open);
        assert!(prior.recheck().is_err());assert!(registry.admit_for(Some("document-a")).is_err());
        assert!(registry.admit_for(Some("document-other")).is_ok());
        let finish=registry.admit_settle("document-a").unwrap();finish.recheck().unwrap();drop(finish);
        drop(fence);prior.recheck().unwrap();assert!(registry.admit_for(Some("document-a")).is_ok());
    }
    #[test]
    fn native_save_scope_allows_only_current_binding_child() {
        let registry=AdmissionRegistry::default();registry.reserve_document("document-save").unwrap().commit();registry.document_ready("document-save");
        let barrier=registry.close().unwrap();
        assert!(registry.admit_binding("document-save","native-session","binding-before-scope").is_err());
        let scope=barrier.save_scope("document-save").unwrap();
        let child=registry.admit_binding("document-save","native-session","current-native-binding").unwrap();child.recheck().unwrap();
        assert!(registry.admit_binding("document-other","other-session","wrong-label").is_err());
        assert!(registry.admit_renderer("document-save","native-session","new-apply").is_err());
        barrier.abort();assert!(child.recheck().is_err());drop(scope);drop(child);
        assert_eq!(registry.snapshot().active,0);
    }
}
