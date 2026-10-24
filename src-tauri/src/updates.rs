//! Native-owned, user-invoked update checks. Production has no configurable endpoint.
use std::{sync::Mutex, time::Duration};
use serde::Serialize;
use tauri::{Emitter, Manager};
#[cfg(test)]
use semver::Version;

pub const LABEL: &str = "desktop-update";
pub const RELEASES_PAGE: &str = "https://github.com/CoozeeWang/leaf-markdown/releases";
const CATALOG:&str=crate::update_releases::CATALOG;
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all="snake_case")]
pub enum UpdateState { Idle, Checking, Current, Available, NoPackage, CheckFailed,
    Downloading, Verifying, DownloadFailed, Ready, Preparing, PrepareFailed,
    Committing, InstallFailed, RolledBack, RollbackFailed, Installed }
#[derive(Clone, Debug, Serialize)]
pub struct UpdateSnapshot {
    pub state: UpdateState,
    pub state_revision: u64,
    pub op_id: u64,
    pub installed_version: String,
    pub platform: String,
    pub target_version: Option<String>,
    pub notes: Option<String>,
    pub error_code: Option<String>,
    pub reason: Option<String>,
    pub candidate_id: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub prepared_documents: Option<u64>,
    pub total_documents: Option<u64>,
    pub recovery_location: Option<String>,
}
impl Default for UpdateSnapshot {
    fn default() -> Self { Self { state: UpdateState::Idle, state_revision: 0, op_id: 0,
        installed_version: env!("CARGO_PKG_VERSION").into(), platform:crate::update_releases::platform(), target_version: None,
        notes: None, error_code: None, reason: None, candidate_id:None,
        downloaded_bytes:0,total_bytes:None,prepared_documents:None,total_documents:None,recovery_location:None } }
}
/// Continuation authority, never serialized, persisted, or accepted from a renderer.
#[derive(Clone,Debug)]
struct UpdateIntent { app_instance:[u8;16], candidate:String, op_id:u64, authorized_revision:u64 }
struct UpdateSession { prepare_id:Option<crate::update_coordinator::PrepareId>,snapshot:UpdateSnapshot, intent:Option<UpdateIntent>, app_instance:[u8;16], candidate:Option<crate::update_releases::CandidateIdentity>, verified:Option<std::sync::Arc<crate::update_package::VerifiedPackage>>, cancel:Option<tokio::sync::watch::Sender<bool>> }
impl Default for UpdateSession {
    fn default()->Self {
        let mut app_instance=[0;16];getrandom::fill(&mut app_instance).expect("update instance entropy unavailable");
        Self{prepare_id:None,snapshot:UpdateSnapshot::default(),intent:None,app_instance,candidate:None,verified:None,cancel:None}
    }
}
#[derive(Default)]
pub struct Updates {
    session: std::sync::Arc<Mutex<UpdateSession>>,
    pub(crate) trust:Mutex<crate::update_package::Trust>,
    // Held only while scheduling construction; never across await/build (main-thread deadlock).
    opening: Mutex<bool>,
    #[cfg(feature="native-smoke")]
    test_source: Mutex<Option<String>>,
}
#[cfg(target_os="macos")]
fn installation_target(executable:&std::path::Path)->Result<std::path::PathBuf,String>{
    let target=executable.parent().and_then(|p|p.parent()).and_then(|p|p.parent())
        .filter(|p|p.extension().is_some_and(|value|value=="app")).ok_or("update_target_unavailable")?;
    if target.ancestors().any(|path|path.file_name().is_some_and(|name|name.to_string_lossy().starts_with(".leaf-update-"))){return Err("update_recovery_target".into());}
    Ok(target.to_path_buf())
}
impl Updates {
    pub fn with_trust_config(value:serde_json::Value)->Self {
        let updates=Self::default();
        *updates.trust.lock().unwrap()=crate::update_package::Trust::from_config(value).unwrap_or(crate::update_package::Trust::Rejected);
        updates
    }

    #[cfg(all(target_os="macos",feature="native-smoke"))]
    pub(crate) fn preservation_source(&self,source:String,trust:crate::update_package::Trust)->Result<(),String>{
        if !crate::update_preservation_test_driver::enabled()||!crate::update_releases::fixture_source(&source){return Err("test_disabled".into());}
        *self.test_source.lock().unwrap()=Some(source);*self.trust.lock().unwrap()=trust;Ok(())
    }
    #[cfg(all(target_os="macos",feature="native-smoke"))]
    pub(crate) fn preservation_consumed(&self)->bool{
        crate::update_preservation_test_driver::enabled()&&self.session.lock().unwrap().verified.as_ref().is_some_and(|package|package.consumed())
    }
    pub fn snapshot(&self) -> UpdateSnapshot { self.session.lock().unwrap().snapshot.clone() }
    /// Called only after native journal/current-bundle reconciliation on launch.
    #[cfg(any(target_os="macos",target_os="windows"))]
    pub(crate) fn reconcile_install_result(&self,state:UpdateState,installed_version:String,target_version:String,error:Option<String>,recovery_location:Option<String>)->Result<(),String>{
        if !matches!(state,UpdateState::Installed|UpdateState::InstallFailed|UpdateState::RolledBack|UpdateState::RollbackFailed){return Err("update_install_reconcile_invalid".into());}
        let mut session=self.session.lock().unwrap();
        if session.intent.is_some(){return Err("update_busy".into());}
        let revision=session.snapshot.state_revision.checked_add(1).ok_or("update_sequence_exhausted")?;
        session.snapshot.state=state;session.snapshot.state_revision=revision;session.snapshot.installed_version=installed_version;
        session.snapshot.target_version=Some(target_version);session.snapshot.error_code=error;session.snapshot.recovery_location=recovery_location;Ok(())
    }

    pub(crate) fn preparation_live(&self,op:u64,candidate:&str)->bool{
        let session=self.session.lock().unwrap();
        session.snapshot.state==UpdateState::Preparing&&Self::authorized(&session,op,candidate)
            &&session.verified.as_ref().is_some_and(|package|package.belongs_to(session.app_instance,candidate)&&!package.consumed())
    }
    pub(crate) fn preparation_authority(&self,app:&tauri::AppHandle,op:u64,candidate:&str)->Result<(std::sync::Arc<crate::update_package::VerifiedPackage>,crate::update_coordinator::PackageBinding),String>{
        let session=self.session.lock().unwrap();
        if session.snapshot.state!=UpdateState::Preparing||!Self::authorized(&session,op,candidate){return Err("update_intent_stale".into());}
        let package=session.verified.clone().filter(|package|package.belongs_to(session.app_instance,candidate)&&!package.consumed()).ok_or("update_stale_package")?;
        let executable=std::env::current_exe().and_then(std::fs::canonicalize).map_err(|_|"update_target_unavailable")?;
        #[cfg(target_os="macos")]
        let target={
            #[cfg(feature="native-smoke")]
            let direct_fixture=crate::update_test_driver::transaction_enabled();
            #[cfg(not(feature="native-smoke"))]
            let direct_fixture=false;
            if direct_fixture{executable.clone()}else{installation_target(&executable)?}
        };
        #[cfg(not(target_os="macos"))]
        let target=executable;
        let binding=crate::update_coordinator::PackageBinding{candidate:candidate.into(),digest:package.digest().into(),handle:package.handle_id(),
            app_instance:session.app_instance,op_id:op,target:target.to_string_lossy().into_owned(),bundle:app.config().identifier.clone()};
        Ok((package,binding))
    }
    pub(crate) fn begin_preparation(&self,app:&tauri::AppHandle,op:u64,candidate:&str,binding:&crate::update_coordinator::PackageBinding)->Result<crate::update_coordinator::PrepareId,String>{
        let mut session=self.session.lock().unwrap();
        if session.snapshot.state!=UpdateState::Preparing||!Self::authorized(&session,op,candidate)
            ||session.verified.as_ref().is_none_or(|package|package.handle_id()!=binding.handle||package.consumed()||package.digest()!=binding.digest)
            ||session.app_instance!=binding.app_instance||binding.op_id!=op||binding.candidate!=candidate {return Err("update_intent_stale".into());}
        let id=app.state::<crate::update_coordinator::UpdateCoordinator>().begin(&app.state::<crate::update_admission::AdmissionRegistry>(),binding.clone())?;
        session.prepare_id=Some(id.clone());Ok(id)
    }
    pub(crate) fn interrupt_preparation(&self,app:&tauri::AppHandle,id:&crate::update_coordinator::PrepareId,code:&str){
        let target={let session=self.session.lock().unwrap();
            if session.prepare_id.as_ref()!=Some(id)||session.snapshot.state!=UpdateState::Preparing{return;}
            (session.snapshot.op_id,session.snapshot.candidate_id.clone())};
        if let Some(candidate)=target.1{if let Some(snapshot)=operation_failed(&self.session,target.0,&candidate,code){publish(app,&snapshot);}}
    }
    #[cfg(feature="native-smoke")]
    pub(crate) fn test_ready_for_confirmation(&self,app:&tauri::AppHandle,package:std::sync::Arc<crate::update_package::VerifiedPackage>)->Result<(),String>{
        if !crate::update_test_driver::prepare_enabled(){return Err("test_disabled".into());}
        let (_,_,trust)=crate::update_package::fixture_input()?;
        *self.trust.lock().unwrap()=trust;
        let snapshot={let mut session=self.session.lock().unwrap();
            session.app_instance=[73;16];session.snapshot.state_revision+=1;session.snapshot.state=UpdateState::Ready;session.snapshot.error_code=None;session.snapshot.reason=None;
            let candidate=package.candidate().clone();session.snapshot.candidate_id=Some(candidate.opaque_id());
            session.snapshot.target_version=Some(candidate.version.clone());session.candidate=Some(candidate);session.verified=Some(package);session.intent=None;
            session.snapshot.clone()};
        publish(app,&snapshot);Ok(())
    }
    #[cfg(feature="native-smoke")]
    pub(crate) fn test_stage_download(&self,package:std::sync::Arc<crate::update_package::VerifiedPackage>)->Result<(),String>{
        if !crate::update_test_driver::prepare_enabled()||package.consumed(){return Err("test_disabled".into());}
        let mut session=self.session.lock().unwrap();
        session.app_instance=[73;16];session.snapshot.op_id+=1;session.snapshot.state_revision+=1;
        let op=session.snapshot.op_id;let revision=session.snapshot.state_revision;let candidate=package.candidate().opaque_id();
        session.snapshot.state=UpdateState::Downloading;session.snapshot.candidate_id=Some(candidate.clone());
        session.candidate=Some(package.candidate().clone());session.verified=Some(package);
        session.intent=Some(UpdateIntent{app_instance:session.app_instance,candidate,op_id:op,authorized_revision:revision});Ok(())
    }
    #[cfg(feature="native-smoke")]
    pub(crate) fn test_finish_staged_download(&self)->Result<(),String>{
        if !crate::update_test_driver::prepare_enabled(){return Err("test_disabled".into());}
        let mut session=self.session.lock().unwrap();
        let candidate=session.snapshot.candidate_id.clone().ok_or("fixture_candidate")?;
        if session.snapshot.state!=UpdateState::Downloading||!Self::authorized(&session,session.snapshot.op_id,&candidate){return Err("update_intent_stale".into());}
        session.snapshot.state=UpdateState::Preparing;session.snapshot.state_revision+=1;Ok(())
    }
    #[cfg(feature="native-smoke")]
    pub(crate) fn test_prepare(&self,app:&tauri::AppHandle,package:std::sync::Arc<crate::update_package::VerifiedPackage>)->Result<(crate::update_coordinator::PrepareId,crate::update_coordinator::PackageBinding),String>{
        if !crate::update_test_driver::coordinator_enabled(){return Err("test_disabled".into());}
        {let mut session=self.session.lock().unwrap();
            session.app_instance=[73;16];session.snapshot.op_id+=1;session.snapshot.state_revision+=1;
            let op=session.snapshot.op_id;let revision=session.snapshot.state_revision;let candidate=package.candidate().opaque_id();
            session.snapshot.state=UpdateState::Preparing;session.snapshot.candidate_id=Some(candidate.clone());
            session.candidate=Some(package.candidate().clone());session.verified=Some(package);
            session.intent=Some(UpdateIntent{app_instance:session.app_instance,candidate,op_id:op,authorized_revision:revision});
        }
        let snapshot=self.snapshot();let candidate=snapshot.candidate_id.ok_or("fixture_candidate")?;
        let (_,binding)=self.preparation_authority(app,snapshot.op_id,&candidate)?;
        let id=self.begin_preparation(app,snapshot.op_id,&candidate,&binding)?;
        if let Err(code)=crate::update_coordinator::announce_begin(app,&id){
            let labels=app.state::<crate::update_coordinator::UpdateCoordinator>().abort(&id);
            crate::update_coordinator::release(app,&id,labels,"fixture_begin_unavailable");return Err(code);
        }Ok((id,binding))
    }
    pub(crate) fn preparation_progress(&self,app:&tauri::AppHandle,op:u64,candidate:&str,total:u64)->Result<(),String>{
        let mut session=self.session.lock().unwrap();
        if session.snapshot.state!=UpdateState::Preparing||!Self::authorized(&session,op,candidate){return Err("update_intent_stale".into());}
        let saved=app.state::<crate::update_coordinator::UpdateCoordinator>().saved_count();
        let snapshot=&mut session.snapshot;snapshot.state_revision=snapshot.state_revision.checked_add(1).ok_or("update_sequence_exhausted")?;
        snapshot.prepared_documents=Some(saved);snapshot.total_documents=Some(total);publish(app,snapshot);Ok(())
    }
    /// Installer06 calls this only after its independent helper-ready proof.
    /// No renderer command can manufacture or consume a CommitPermit.
    pub(crate) fn commit_preparation(&self,app:&tauri::AppHandle,op:u64,candidate:&str,binding:&crate::update_coordinator::PackageBinding,permit:crate::update_coordinator::CommitPermit,helper_ready:bool)->Result<(),String>{
        let mut session=self.session.lock().unwrap();
        if session.snapshot.state!=UpdateState::Preparing||!Self::authorized(&session,op,candidate){return Err("update_intent_stale".into());}
        let package=session.verified.clone().filter(|package|package.belongs_to(session.app_instance,candidate)&&package.handle_id()==binding.handle&&!package.consumed()).ok_or("update_stale_package")?;
        let revision=session.snapshot.state_revision.checked_add(1).ok_or("update_sequence_exhausted")?;
        app.state::<crate::update_coordinator::UpdateCoordinator>().commit(permit,binding,helper_ready,||package.consume(binding.app_instance,candidate))?;
        session.intent=None;session.snapshot.state=UpdateState::Committing;session.snapshot.state_revision=revision;
        publish(app,&session.snapshot);Ok(())
    }

    fn begin(&self) -> Result<UpdateSnapshot,String> {
        let mut session=self.session.lock().unwrap();
        let recovered_failure=session.snapshot.state==UpdateState::InstallFailed&&session.intent.is_none()&&session.verified.is_none()&&session.prepare_id.is_none();
        if !recovered_failure&&!matches!(session.snapshot.state,UpdateState::Idle|UpdateState::Current|UpdateState::NoPackage|UpdateState::CheckFailed|UpdateState::Available|UpdateState::RolledBack|UpdateState::Installed) {return Err("update_busy".into());}
        session.intent=None;session.candidate=None;session.verified=None;revoke_worker(&mut session);
        let s=&mut session.snapshot;
        s.op_id=s.op_id.checked_add(1).ok_or("update_sequence_exhausted")?;
        s.state_revision=s.state_revision.checked_add(1).ok_or("update_sequence_exhausted")?;
        s.state=UpdateState::Checking;s.error_code=None;s.reason=None;s.target_version=None;s.notes=None;s.candidate_id=None;
        s.downloaded_bytes=0;s.total_bytes=None;s.prepared_documents=None;s.total_documents=None;s.recovery_location=None;
        Ok(s.clone())
    }
    fn finish(&self,op:u64,result:Result<CheckResult,String>)->Option<UpdateSnapshot> {
        let mut session=self.session.lock().unwrap();
        if session.snapshot.op_id!=op||session.snapshot.state!=UpdateState::Checking {return None;}
        let revision=session.snapshot.state_revision.checked_add(1)?;
        session.candidate=result.as_ref().ok().and_then(|result|result.candidate.clone());
        let readiness=if result.as_ref().is_ok_and(|result|result.state==UpdateState::Available&&result.candidate.as_ref().is_some_and(|c|!c.signature.is_empty())) {
            #[cfg(feature="native-smoke")]
            let simulated=crate::update_test_driver::ui_enabled();
            #[cfg(not(feature="native-smoke"))]
            let simulated=false;
            if simulated {None}else{self.trust.lock().unwrap().readiness_error().map(str::to_owned)}
        }else{None};
        let s=&mut session.snapshot;s.state_revision=revision;
        match result {
            Ok(result)=>{s.state=result.state;s.target_version=result.version;s.notes=result.notes;s.reason=result.reason;s.candidate_id=result.candidate_id;s.error_code=readiness;},
            Err(code)=>{s.state=UpdateState::CheckFailed;s.error_code=Some(code);}
        }
        Some(s.clone())
    }
    fn authorize(&self,candidate:&str,revision:u64,resume:bool)->Result<UpdateSnapshot,String> {
        let mut session=self.session.lock().unwrap();
        let s=&session.snapshot;
        if s.state_revision!=revision || s.candidate_id.as_deref()!=Some(candidate) {return Err("update_stale_confirmation".into());}
        let allowed=if resume {matches!(s.state,UpdateState::Ready|UpdateState::PrepareFailed|UpdateState::InstallFailed)}
            else {matches!(s.state,UpdateState::Available|UpdateState::DownloadFailed)};
        if !allowed || session.intent.is_some() {return Err("update_busy".into());}
        let op=s.op_id.checked_add(1).ok_or("update_sequence_exhausted")?;
        let next_revision=s.state_revision.checked_add(1).ok_or("update_sequence_exhausted")?;
        revoke_worker(&mut session);
        if !resume {session.verified=None;}
        session.intent=Some(UpdateIntent{app_instance:session.app_instance,candidate:candidate.into(),op_id:op,authorized_revision:next_revision});
        let s=&mut session.snapshot;s.op_id=op;s.state_revision=next_revision;s.error_code=None;
        s.downloaded_bytes=0;s.total_bytes=None;s.prepared_documents=None;s.total_documents=None;
        s.state=if resume {UpdateState::Preparing}else{UpdateState::Downloading};
        Ok(s.clone())
    }
    fn authorized(session:&UpdateSession,op:u64,candidate:&str)->bool {
        session.intent.as_ref().is_some_and(|intent|intent.app_instance==session.app_instance
            && intent.op_id==op && intent.candidate==candidate && intent.authorized_revision<=session.snapshot.state_revision)
            && session.snapshot.op_id==op && session.snapshot.candidate_id.as_deref()==Some(candidate)
    }
    fn fail_operation(&self,op:u64,candidate:&str,code:&str)->Option<UpdateSnapshot> {
        operation_failed(&self.session,op,candidate,code)
    }
    fn operation_job(&self,candidate:&str,revision:u64,resume:bool)->Result<(UpdateSnapshot,OperationJob),String> {
        let trust=self.trust.lock().unwrap().clone();
        if let Some(code)=trust.readiness_error() {return Err(code.into());}
        {
            let session=self.session.lock().unwrap();
            if session.candidate.as_ref().is_none_or(|native|native.opaque_id()!=candidate) {return Err("update_stale_candidate".into());}
            if resume && session.verified.as_ref().is_none_or(|package|!package.belongs_to(session.app_instance,candidate)||package.consumed()) {return Err("update_stale_package".into());}
        }
        let snapshot=self.authorize(candidate,revision,resume)?;
        let mut session=self.session.lock().unwrap();
        if session.snapshot.op_id!=snapshot.op_id||session.snapshot.candidate_id.as_deref()!=Some(candidate)
            ||!matches!(session.snapshot.state,UpdateState::Downloading|UpdateState::Preparing) {return Err("update_stale_operation".into());}
        let (sender,cancel)=tokio::sync::watch::channel(false);session.cancel=Some(sender);
        if resume {session.snapshot.state=UpdateState::Verifying;}
        let job=OperationJob{app:None,session:self.session.clone(),op:snapshot.op_id,candidate:session.candidate.clone().ok_or("update_stale_candidate")?,
            app_instance:session.app_instance,trust,cached:session.verified.clone(),cancel,resume};
        Ok((session.snapshot.clone(),job))
    }
    fn close(&self)->Result<UpdateSnapshot,String> {
        let mut session=self.session.lock().unwrap();
        if session.snapshot.state==UpdateState::Committing {return Err("update_committing".into());}
        // Atomic revocation and revision advance precede hide. A queued confirmation is now stale.
        session.intent=None;let s=&mut session.snapshot;
        s.state_revision=s.state_revision.checked_add(1).ok_or("update_sequence_exhausted")?;
        if s.state==UpdateState::Preparing {s.op_id=s.op_id.checked_add(1).ok_or("update_sequence_exhausted")?;s.state=UpdateState::PrepareFailed;s.error_code=Some("update_cancelled".into());revoke_worker(&mut session);}
        let s=&session.snapshot;
        Ok(s.clone())
    }
    fn cancel_download(&self)->Result<UpdateSnapshot,String> {
        let mut session=self.session.lock().unwrap();
        if !matches!(session.snapshot.state,UpdateState::Downloading|UpdateState::Verifying) {return Err("update_wrong_state".into());}
        session.intent=None;let s=&mut session.snapshot;
        s.op_id=s.op_id.checked_add(1).ok_or("update_sequence_exhausted")?;
        s.state_revision=s.state_revision.checked_add(1).ok_or("update_sequence_exhausted")?;
        s.state=UpdateState::Available;s.error_code=None;s.downloaded_bytes=0;s.total_bytes=None;
        let snapshot=s.clone();session.verified=None;revoke_worker(&mut session);Ok(snapshot)
    }
    #[cfg(feature="native-smoke")]
    pub fn test_complete_download(&self,op:u64,candidate:&str)->Option<UpdateSnapshot> {
        if !crate::update_test_driver::ui_enabled() {return None;}
        let mut session=self.session.lock().unwrap();
        if session.snapshot.op_id!=op || session.snapshot.candidate_id.as_deref()!=Some(candidate)
            || !matches!(session.snapshot.state,UpdateState::Downloading|UpdateState::Verifying) {return None;}
        let allowed=Self::authorized(&session,op,candidate);let s=&mut session.snapshot;
        s.state=if allowed {UpdateState::Preparing}else{UpdateState::Ready};s.state_revision=s.state_revision.checked_add(1)?;Some(s.clone())
    }
    #[cfg(feature="native-smoke")]
    pub fn set_test_source(&self, source: String) { *self.test_source.lock().unwrap()=Some(source); }
}

// A job owns only native candidate/cache authority. Its callbacks share the same
// session guards used by IPC, so an old worker cannot promote a newer operation.
struct OperationJob {
    app:Option<tauri::AppHandle>,
    session:std::sync::Arc<Mutex<UpdateSession>>, op:u64, candidate:crate::update_releases::CandidateIdentity,
    app_instance:[u8;16], trust:crate::update_package::Trust,
    cached:Option<std::sync::Arc<crate::update_package::VerifiedPackage>>,
    cancel:tokio::sync::watch::Receiver<bool>, resume:bool,
}
type StatePublisher=std::sync::Arc<dyn Fn(UpdateSnapshot)+Send+Sync>;
fn operation_current(session:&UpdateSession,op:u64,candidate:&str,instance:[u8;16])->bool {
    session.app_instance==instance && session.snapshot.op_id==op
        && session.snapshot.candidate_id.as_deref()==Some(candidate)
        && matches!(session.snapshot.state,UpdateState::Downloading|UpdateState::Verifying)
}
fn revoke_worker(session:&mut UpdateSession) {
    if let Some(cancel)=session.cancel.take() {let _=cancel.send(true);}
}
async fn worker_cancelled(cancel:&mut tokio::sync::watch::Receiver<bool>) {
    loop {if *cancel.borrow() {return;}if cancel.changed().await.is_err() {return;}}
}
fn operation_failed(session:&Mutex<UpdateSession>,op:u64,candidate:&str,code:&str)->Option<UpdateSnapshot> {
    let mut session=session.lock().unwrap();
    let s=&session.snapshot;
    if s.op_id!=op || s.candidate_id.as_deref()!=Some(candidate)
        || !matches!(s.state,UpdateState::Downloading|UpdateState::Verifying|UpdateState::Preparing|UpdateState::Committing) {return None;}
    let revision=s.state_revision.checked_add(1)?;
    session.intent=None;revoke_worker(&mut session);let s=&mut session.snapshot;
    s.state=if s.state==UpdateState::Preparing {UpdateState::PrepareFailed}else if s.state==UpdateState::Committing {UpdateState::InstallFailed}else{UpdateState::DownloadFailed};
    s.error_code=Some(code.into());s.state_revision=revision;Some(s.clone())
}
fn record_progress(session:&Mutex<UpdateSession>,op:u64,candidate:&str,instance:[u8;16],received:u64,total:Option<u64>)->Option<UpdateSnapshot> {
    let mut session=session.lock().unwrap();
    if !operation_current(&session,op,candidate,instance)||session.snapshot.state!=UpdateState::Downloading
        ||received<session.snapshot.downloaded_bytes||received>crate::update_package::MAX_DOWNLOAD
        ||total.is_some_and(|total|total<received||total>crate::update_package::MAX_DOWNLOAD) {return None;}
    let s=&mut session.snapshot;
    if s.downloaded_bytes==received&&s.total_bytes==total {return None;}
    s.state_revision=s.state_revision.checked_add(1)?;s.downloaded_bytes=received;s.total_bytes=total;Some(s.clone())
}
fn mark_verifying(session:&Mutex<UpdateSession>,op:u64,candidate:&str,instance:[u8;16])->Option<UpdateSnapshot> {
    let mut session=session.lock().unwrap();
    if !operation_current(&session,op,candidate,instance)||session.snapshot.state!=UpdateState::Downloading {return None;}
    let s=&mut session.snapshot;s.state_revision=s.state_revision.checked_add(1)?;s.state=UpdateState::Verifying;Some(s.clone())
}
fn promote_verified(session:&Mutex<UpdateSession>,op:u64,candidate:&str,instance:[u8;16],package:std::sync::Arc<crate::update_package::VerifiedPackage>)->Option<UpdateSnapshot> {
    let mut session=session.lock().unwrap();
    if !operation_current(&session,op,candidate,instance)||session.snapshot.state!=UpdateState::Verifying
        ||!package.belongs_to(instance,candidate)||package.consumed()
        ||session.candidate.as_ref()!=Some(package.candidate()) {return None;}
    let revision=session.snapshot.state_revision.checked_add(1)?;
    let authorized=Updates::authorized(&session,op,candidate);
    session.verified=Some(package);session.cancel=None;
    let s=&mut session.snapshot;s.state_revision=revision;s.state=if authorized {UpdateState::Preparing}else{UpdateState::Ready};
    Some(s.clone())
}
#[cfg(any(test,feature="legacy-updater-tests"))]
impl OperationJob {
    async fn run(self,cache:std::path::PathBuf,source:Option<String>,publish:StatePublisher) {
        let Self{app,session,op,candidate,app_instance,trust,cached,mut cancel,resume}=self;
        let candidate_id=candidate.opaque_id();
        let callback_session=session.clone();let callback_candidate=candidate_id.clone();
        let current:std::sync::Arc<dyn Fn()->bool+Send+Sync>=std::sync::Arc::new(move||operation_current(&callback_session.lock().unwrap(),op,&callback_candidate,app_instance));
        let outcome=if resume {
            if let Some(package)=cached {
                let callback=current.clone();
                let task=tokio::task::spawn_blocking(move||{package.revalidate(callback.as_ref())?;Ok::<_,String>(package)});
                tokio::select! {
                    _=worker_cancelled(&mut cancel)=>Err("update_cancelled".into()),
                    result=task=>result.unwrap_or_else(|_|Err("update_package_invalid".into())),
                }
            }else {Err("update_stale_package".into())}
        }else {
            let progress_session=session.clone();let progress_candidate=candidate_id.clone();let progress_publish=publish.clone();
            let progress=std::sync::Arc::new(move|received,total| {
                if let Some(snapshot)=record_progress(&progress_session,op,&progress_candidate,app_instance,received,total) {progress_publish(snapshot);}
            });
            let verify_session=session.clone();let verify_candidate=candidate_id.clone();let verify_publish=publish.clone();
            let verifying=std::sync::Arc::new(move|| {
                if let Some(snapshot)=mark_verifying(&verify_session,op,&verify_candidate,app_instance) {verify_publish(snapshot);}
            });
            tokio::select! {
                _=worker_cancelled(&mut cancel)=>Err("update_cancelled".into()),
                result=tokio::time::timeout(Duration::from_secs(15*60),crate::update_package::download(candidate,trust,&cache,app_instance,source.as_deref(),current,progress,verifying))
                    =>result.unwrap_or_else(|_|Err("update_timeout".into())),
            }
        };
        match outcome {
            Ok(package)=>{
                if let Some(snapshot)=promote_verified(&session,op,&candidate_id,app_instance,package) {
                    let preparing=snapshot.state==UpdateState::Preparing;publish(snapshot);
                    if preparing {
                        let result=if let Some(app)=app {
                            crate::update_coordinator::prepare_install(&app,op,&candidate_id).await
                        }else{Err("update_prepare_unavailable".into())};
                        if let Err(code)=result {
                            if let Some(failed)=operation_failed(&session,op,&candidate_id,&code) {publish(failed);}
                        }
                    }
                }
            },
            Err(code)=>if let Some(snapshot)=operation_failed(&session,op,&candidate_id,&code) {publish(snapshot);},
        }
    }
}

fn publish(app:&tauri::AppHandle,snapshot:&UpdateSnapshot) {
    let _=app.emit_to(LABEL,"leaf-update-state",snapshot);
}
fn require_updater(window:&tauri::WebviewWindow)->Result<(),String> {
    if window.label()==LABEL {Ok(())}else{Err("update_wrong_role".into())}
}
#[tauri::command]
pub fn update_status(window:tauri::WebviewWindow, state:tauri::State<Updates>)->Result<UpdateSnapshot,String> {
    require_updater(&window)?; Ok(state.snapshot())
}
#[tauri::command]
pub fn update_check(app:tauri::AppHandle,window:tauri::WebviewWindow)->Result<UpdateSnapshot,String> {
    require_updater(&window)?; check_for_updates(&app)
}
#[tauri::command]
pub fn update_close(app:tauri::AppHandle,window:tauri::WebviewWindow)->Result<(),String> {
    require_updater(&window)?;hide_update_window(&app)
}
pub fn hide_update_window(app:&tauri::AppHandle)->Result<(),String> {
    let snapshot=app.state::<Updates>().close()?;
    #[cfg(feature="legacy-updater-tests")]
    crate::update_coordinator::abort_and_release(app,"update_cancelled");
    publish(app,&snapshot);
    if let Some(window)=app.get_webview_window(LABEL) {window.hide().map_err(|_|"update_window_failed")?;}
    if app.state::<crate::Documents>().0.lock().unwrap().is_empty() {
        if let Some(launcher)=app.get_webview_window(crate::LAUNCHER) {let _=launcher.show();let _=launcher.set_focus();}
    }
    Ok(())
}
#[cfg(any(test,feature="legacy-updater-tests"))]
#[tauri::command]
pub fn update_start(app:tauri::AppHandle,window:tauri::WebviewWindow,candidate_id:String,state_revision:u64)->Result<UpdateSnapshot,String> {
    require_updater(&window)?;start_operation(&app,&candidate_id,state_revision,false)
}
#[cfg(any(test,feature="legacy-updater-tests"))]
#[tauri::command]
pub fn update_resume(app:tauri::AppHandle,window:tauri::WebviewWindow,candidate_id:String,state_revision:u64)->Result<UpdateSnapshot,String> {
    require_updater(&window)?;start_operation(&app,&candidate_id,state_revision,true)
}
#[cfg(any(test,feature="legacy-updater-tests"))]
fn start_operation(app:&tauri::AppHandle,candidate:&str,revision:u64,resume:bool)->Result<UpdateSnapshot,String> {
    let updates=app.state::<Updates>();
    #[cfg(feature="native-smoke")]
    if crate::update_test_driver::ui_enabled() {
        let snapshot=updates.authorize(candidate,revision,resume)?;publish(app,&snapshot);return Ok(snapshot);
    }
    let cache=app.path().app_cache_dir().map_err(|_|"update_cache_unavailable")?.join("desktop-updates");
    #[cfg(all(target_os="macos",feature="native-smoke"))]
    let cache=if crate::update_preservation_test_driver::enabled(){crate::update_preservation_test_driver::profile()?.join("desktop-updates-cache")}else{cache};
    let (snapshot,mut job)=updates.operation_job(candidate,revision,resume)?;job.app=Some(app.clone());
    #[cfg(not(feature="native-smoke"))]
    let source=None;
    #[cfg(feature="native-smoke")]
    let source=updates.test_source.lock().unwrap().clone();
    publish(app,&snapshot);
    let handle=app.clone();
    tauri::async_runtime::spawn(job.run(cache,source,std::sync::Arc::new(move|snapshot|publish(&handle,&snapshot))));
    Ok(snapshot)
}
#[cfg(any(test,feature="legacy-updater-tests"))]
#[tauri::command]
pub fn update_cancel_download(app:tauri::AppHandle,window:tauri::WebviewWindow)->Result<UpdateSnapshot,String> {
    require_updater(&window)?;let snapshot=app.state::<Updates>().cancel_download()?;publish(&app,&snapshot);Ok(snapshot)
}
#[tauri::command]
pub fn update_open_releases(app:tauri::AppHandle,window:tauri::WebviewWindow)->Result<(),String>{
    require_updater(&window)?;
    let state=app.state::<Updates>();let session=state.session.lock().unwrap();
    let page=session.candidate.as_ref().map(|c|format!("{RELEASES_PAGE}/tag/{}",c.tag)).unwrap_or_else(||RELEASES_PAGE.into());
    open_external(&page)
}
#[tauri::command]
pub fn update_open_download(app:tauri::AppHandle,window:tauri::WebviewWindow,candidate_id:String,state_revision:u64)->Result<(),String>{
    require_updater(&window)?;
    let state=app.state::<Updates>();let session=state.session.lock().unwrap();
    if session.snapshot.state!=UpdateState::Available||session.snapshot.state_revision!=state_revision||session.snapshot.candidate_id.as_deref()!=Some(&candidate_id){return Err("update_stale_confirmation".into());}
    let candidate=session.candidate.as_ref().ok_or("update_stale_candidate")?;
    if !crate::update_releases::official_asset(&candidate.url,&candidate.tag){return Err("update_asset_rejected".into());}
    open_external(&candidate.url)
}
fn open_external(url:&str)->Result<(),String>{
    #[cfg(target_os="macos")]
    let result=std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os="windows")]
    let result={use std::os::windows::process::CommandExt;std::process::Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler",url]).creation_flags(0x08000000).spawn()};
    #[cfg(not(any(target_os="macos",target_os="windows")))]
    let result=std::process::Command::new("xdg-open").arg(url).spawn();
    result.map(|_|()).map_err(|_|"update_releases_unavailable".into())
}
pub fn check_for_updates(app:&tauri::AppHandle)->Result<UpdateSnapshot,String> {
    let state=app.state::<Updates>();
    let snapshot=state.begin()?;publish(app,&snapshot);
    let source=CATALOG.to_owned();
    #[cfg(feature="native-smoke")]
    let source=state.test_source.lock().unwrap().clone().unwrap_or(source);
    let handle=app.clone();let op=snapshot.op_id;
    tauri::async_runtime::spawn(async move {
        let result=tokio::time::timeout(Duration::from_secs(90),read_catalog(&source)).await
            .unwrap_or_else(|_|Err("update_timeout".into()));
        if let Some(snapshot)=handle.state::<Updates>().finish(op,result) {publish(&handle,&snapshot);}
    });
    Ok(snapshot)
}
pub fn open_update_window(app:&tauri::AppHandle)->Result<(),String> {
    if let Some(window)=app.get_webview_window(LABEL) {
        window.show().and_then(|_|window.unminimize()).and_then(|_|window.set_focus()).map_err(|_|"update_window_failed")?;
        if app.state::<Updates>().snapshot().state!=UpdateState::Checking{check_for_updates(app)?;}
        Ok(())
    } else {
        let state=app.state::<Updates>();
        let mut opening=state.opening.lock().unwrap();
        if *opening {return Ok(());}
        *opening=true;
        drop(opening);
        let handle=app.clone();
        if app.run_on_main_thread(move|| {
            let result=(||->Result<(),String>{
                if let Some(window)=handle.get_webview_window(LABEL) {
                    return window.show().and_then(|_|window.unminimize()).and_then(|_|window.set_focus()).map_err(|_|"update_window_failed".into());
                }
                let url="index.html?updateWindow=1".to_owned();
                #[cfg(feature="native-smoke")]
                let url=if crate::update_test_driver::enabled() {format!("{url}&updateTracer=1")}else{url};
                let builder=tauri::WebviewWindowBuilder::new(&handle,LABEL,tauri::WebviewUrl::App(url.into()))
                    .title(crate::i18n::app_text(&handle,"updates.title"))
                    .inner_size(600.,480.).min_inner_size(480.,360.).visible(false);
                let builder=crate::development_window(&handle,builder);
                #[cfg(all(target_os="windows",feature="native-smoke"))]
                let builder=builder.additional_browser_args(&crate::native_smoke_browser_args());
                let window=builder.build().map_err(|_|"update_window_failed")?;
                window.show().and_then(|_|window.unminimize()).and_then(|_|window.set_focus()).map_err(|_|"update_window_failed")?;
                if handle.state::<Updates>().snapshot().state==UpdateState::Idle {check_for_updates(&handle)?;}
                Ok(())
            })();
            *handle.state::<Updates>().opening.lock().unwrap()=false;
            if result.is_err() {
                let state=handle.state::<Updates>();let mut session=state.session.lock().unwrap();session.intent=None;let snapshot=&mut session.snapshot;
                snapshot.state=UpdateState::CheckFailed;snapshot.error_code=Some("update_window_failed".into());snapshot.state_revision+=1;
                publish(&handle,&snapshot);
            }
        }).is_err() {*app.state::<Updates>().opening.lock().unwrap()=false;return Err("update_window_failed".into());}
        Ok(())
    }
}

pub struct CheckResult {pub state:UpdateState,version:Option<String>,notes:Option<String>,reason:Option<String>,candidate_id:Option<String>,candidate:Option<crate::update_releases::CandidateIdentity>}
#[cfg(test)]
fn product_version(tag:&str)->Option<Version> {
    let mut version=crate::update_releases::product_version(tag)?;version.build=semver::BuildMetadata::EMPTY;Some(version)
}
#[cfg(test)]
fn official_asset(url:&str,tag:&str)->bool {crate::update_releases::official_asset(url,tag)}
pub async fn read_catalog(source:&str)->Result<CheckResult,String> {catalog(source,None).await}
#[cfg(feature="native-smoke")]
pub async fn read_official_catalog_probe()->Result<CheckResult,String> {
    let token=std::env::var("LEAF_UPDATE_OFFICIAL_PROBE_TOKEN").ok().filter(|token|!token.is_empty());
    catalog(CATALOG,token.as_deref()).await
}
async fn catalog(source:&str,token:Option<&str>)->Result<CheckResult,String> {
    use crate::update_releases::CatalogOutcome;
    let _=token;
    let result=crate::update_releases::read_manual_catalog(source,env!("CARGO_PKG_VERSION"),&crate::update_releases::platform()).await?;
    let state=match result.outcome {CatalogOutcome::Current=>UpdateState::Current,CatalogOutcome::NoCatalog|CatalogOutcome::NoPackage=>UpdateState::NoPackage,CatalogOutcome::Available=>UpdateState::Available};
    let reason=match result.outcome {CatalogOutcome::NoCatalog=>Some("no_catalog".into()),CatalogOutcome::NoPackage=>Some("no_package".into()),_=>None};
    Ok(CheckResult{state,version:result.candidate.as_ref().map(|candidate|candidate.version.clone()),notes:result.notes,reason,
        candidate_id:result.candidate.as_ref().map(|candidate|candidate.opaque_id()),candidate:result.candidate})
}
#[cfg(test)]
mod tests {
    #[cfg(target_os="macos")]
    #[test]
    fn recovery_bundle_never_becomes_installation_target(){
        assert!(super::installation_target(std::path::Path::new("/Synthetic/Leaf.app/Contents/MacOS/leaf")).is_ok());
        assert!(super::installation_target(std::path::Path::new("/Synthetic/.leaf-update-owned/Prepared.app/Contents/MacOS/leaf")).is_err());
    }
    #[cfg(target_os="macos")]
    #[test]
    fn reconciled_install_failure_can_check_again_without_reusing_authority(){
        let updates=super::Updates::default();
        updates.reconcile_install_result(super::UpdateState::InstallFailed,"1.0.0".into(),"2.0.0".into(),Some("synthetic_failure".into()),Some("/Synthetic/Recovery.app".into())).unwrap();
        let snapshot=updates.begin().unwrap();assert_eq!(snapshot.state,super::UpdateState::Checking);
        assert!(snapshot.recovery_location.is_none());assert!(snapshot.candidate_id.is_none());
        assert!(updates.session.lock().unwrap().intent.is_none());
        let blocked=super::Updates::default();blocked.session.lock().unwrap().snapshot.state=super::UpdateState::RollbackFailed;
        assert!(blocked.begin().is_err());
        let stale=super::Updates::default();{let mut session=stale.session.lock().unwrap();session.snapshot.state=super::UpdateState::InstallFailed;session.prepare_id=Some(crate::update_coordinator::PrepareId("stale".into()));}
        assert!(stale.begin().is_err(),"an active transaction cannot borrow recovered-failure retry");
    }
    use super::*;
    fn available()->Updates {
        let updates=Updates::default();
        {let mut session=updates.session.lock().unwrap();session.snapshot.state=UpdateState::Available;
            session.snapshot.candidate_id=Some("release:version:platform:asset".into());session.snapshot.target_version=Some("9.0.0".into());}
        updates
    }
    #[test] fn download_operation_races() {
        let updates=available();
        {
            let mut session=updates.session.lock().unwrap();
            session.snapshot.downloaded_bytes=17;
            session.snapshot.total_bytes=Some(99);
            session.snapshot.prepared_documents=Some(2);
            session.snapshot.total_documents=Some(3);
        }
        let before=updates.snapshot();
        let started=updates.authorize(before.candidate_id.as_deref().unwrap(),before.state_revision,false).unwrap();
        assert_eq!(started.downloaded_bytes,0,"a new download operation must clear prior byte progress");
        assert_eq!(started.total_bytes,None,"a new download operation must not inherit an old response length");
        assert_eq!(started.prepared_documents,None);
        assert_eq!(started.total_documents,None);
        assert!(started.op_id>before.op_id);
    }
    #[test] fn pending_identity_never_allocates_an_operation_or_intent() {
        let updates=available();let before=updates.snapshot();let candidate=before.candidate_id.as_deref().unwrap();
        for _ in 0..2 {
            assert_eq!(updates.operation_job(candidate,before.state_revision,false).err().as_deref(),Some("update_signing_identity_pending"));
            assert_eq!(updates.snapshot().op_id,before.op_id);
            assert_eq!(updates.snapshot().state_revision,before.state_revision);
            assert!(updates.session.lock().unwrap().intent.is_none());
        }
        assert!(updates.close().is_ok());
        assert_eq!(RELEASES_PAGE,"https://github.com/CoozeeWang/leaf-markdown/releases");
    }
    #[test] fn progress_and_verification_ignore_cancelled_or_wrong_operations() {
        let updates=available();let candidate=updates.snapshot().candidate_id.unwrap();
        let started=updates.authorize(&candidate,0,false).unwrap();
        let instance=updates.session.lock().unwrap().app_instance;
        assert!(record_progress(&updates.session,started.op_id,&candidate,[0;16],1,None).is_none());
        assert!(record_progress(&updates.session,started.op_id,"another",instance,1,None).is_none());
        let progressed=record_progress(&updates.session,started.op_id,&candidate,instance,12,Some(20)).unwrap();
        assert_eq!(progressed.downloaded_bytes,12);
        assert!(record_progress(&updates.session,started.op_id,&candidate,instance,11,Some(20)).is_none());
        updates.cancel_download().unwrap();
        let after=updates.snapshot();
        assert!(record_progress(&updates.session,started.op_id,&candidate,instance,20,Some(20)).is_none());
        assert!(mark_verifying(&updates.session,started.op_id,&candidate,instance).is_none());
        assert_eq!(updates.snapshot().state_revision,after.state_revision);
        let retry=updates.authorize(&candidate,after.state_revision,false).unwrap();
        assert_eq!(retry.downloaded_bytes,0);assert_eq!(retry.total_bytes,None);
        assert!(mark_verifying(&updates.session,retry.op_id,&candidate,instance).is_some());
        let closed=updates.close().unwrap();
        assert_eq!(closed.state,UpdateState::Verifying);
        assert!(operation_current(&updates.session.lock().unwrap(),retry.op_id,&candidate,instance));
        assert!(!Updates::authorized(&updates.session.lock().unwrap(),retry.op_id,&candidate));
    }
    #[test] fn confirmation_is_bound_to_candidate_revision_instance_and_operation() {
        let updates=available();let before=updates.snapshot();let candidate=before.candidate_id.as_deref().unwrap();
        assert!(updates.authorize("another-candidate",before.state_revision,false).is_err());
        let started=updates.authorize(candidate,before.state_revision,false).unwrap();
        assert!(Updates::authorized(&updates.session.lock().unwrap(),started.op_id,candidate));
        assert!(updates.authorize(candidate,started.state_revision,false).is_err(),"duplicate start cannot allocate an operation");
        let mut session=updates.session.lock().unwrap();session.app_instance[0]^=1;
        assert!(!Updates::authorized(&session,started.op_id,candidate),"another application instance cannot inherit intent");
    }
    #[test] fn close_revokes_before_queued_start_and_keeps_existing_download() {
        let updates=available();let original=updates.snapshot();let candidate=original.candidate_id.as_deref().unwrap();
        updates.close().unwrap();assert!(updates.authorize(candidate,original.state_revision,false).is_err());
        let started=updates.authorize(candidate,updates.snapshot().state_revision,false).unwrap();
        let closed=updates.close().unwrap();assert_eq!(closed.state,UpdateState::Downloading);assert_eq!(closed.op_id,started.op_id);
        assert!(!Updates::authorized(&updates.session.lock().unwrap(),started.op_id,candidate));
        assert!(updates.session.lock().unwrap().intent.is_none());
    }
    #[test] fn cancel_and_failure_revoke_before_late_completion() {
        let updates=available();let candidate=updates.snapshot().candidate_id.unwrap();
        let first=updates.authorize(&candidate,0,false).unwrap();let cancelled=updates.cancel_download().unwrap();
        assert!(cancelled.op_id>first.op_id);assert_eq!(cancelled.state,UpdateState::Available);
        assert!(updates.fail_operation(first.op_id,&candidate,"late").is_none());
        let second=updates.authorize(&candidate,cancelled.state_revision,false).unwrap();
        assert!(updates.fail_operation(second.op_id,"another","wrong").is_none());
        let failed=updates.fail_operation(second.op_id,&candidate,"update_download_unavailable").unwrap();
        assert_eq!(failed.state,UpdateState::DownloadFailed);assert!(updates.session.lock().unwrap().intent.is_none());
        assert!(updates.fail_operation(second.op_id,&candidate,"late").is_none());
    }
    #[test] fn preparation_close_cancels_but_commit_rejects_close() {
        let updates=available();let candidate=updates.snapshot().candidate_id.unwrap();
        {updates.session.lock().unwrap().snapshot.state=UpdateState::Ready;}
        let prepare=updates.authorize(&candidate,0,true).unwrap();let closed=updates.close().unwrap();
        assert_eq!(closed.state,UpdateState::PrepareFailed);assert!(closed.op_id>prepare.op_id);
        assert!(updates.session.lock().unwrap().intent.is_none());
        updates.authorize(&candidate,closed.state_revision,true).unwrap();
        {updates.session.lock().unwrap().snapshot.state=UpdateState::Committing;}
        let before=updates.snapshot();assert!(updates.close().is_err());assert_eq!(updates.snapshot().state_revision,before.state_revision);
        assert!(updates.session.lock().unwrap().intent.is_some());
        assert!(Updates::default().session.lock().unwrap().intent.is_none(),"restart has no persisted authority");
    }
    #[test] fn strict_semver_boundaries_and_metadata() {
        let installed=product_version("0.4.0-beta.4").unwrap();
        assert!(product_version("v0.4.0-beta.3").unwrap()<installed);
        assert_eq!(product_version("0.4.0-beta.4+build.999").unwrap(),installed);
        assert!(product_version("0.4.0-beta.5").unwrap()>installed);
        assert!(product_version("0.4.0-beta.10").unwrap()>product_version("0.4.0-beta.2").unwrap());
        assert!(product_version("v1.2.3-beta.0").is_some());
        for bad in ["vv1.0.0","ｖ1.0.0","1.0.０","1.0.0-rc.1","1.0.0-beta.01"," 1.0.0"] {assert!(product_version(bad).is_none(),"{bad}");}
    }
    #[test] fn operation_and_revision_guard_stale_work() {
        let state=Updates::default();let first=state.begin().unwrap();
        assert!(state.begin().is_err());assert!(state.finish(first.op_id+1,Err("wrong".into())).is_none());
        let done=state.finish(first.op_id,Err("network".into())).unwrap();
        assert!(done.state_revision>first.state_revision);
        let second=state.begin().unwrap();assert!(second.op_id>first.op_id);
        assert!(state.finish(first.op_id,Err("late".into())).is_none());
    }
    #[test] fn catalog_asset_identity_rejects_nested_and_encoded_names() {
        for name in ["folder/Leaf.zip","%2e%2e/Leaf.zip","Leaf.zip/extra","Leaf%2fother.zip","Leaf%5cother.zip"] {
            let url=format!("https://github.com/CoozeeWang/leaf-markdown/releases/download/v1.0.0/{name}");
            assert!(!official_asset(&url,"v1.0.0"),"an asset must be one exact release filename: {name}");
        }
    }
    #[test] fn fixed_asset_origin_is_exact() {
        assert!(official_asset("https://github.com/CoozeeWang/leaf-markdown/releases/download/v1.0.0/Leaf.zip","v1.0.0"));
        for url in ["http://github.com/CoozeeWang/leaf-markdown/releases/download/v1.0.0/Leaf.zip","https://github.com.evil.invalid/CoozeeWang/leaf-markdown/releases/download/v1.0.0/Leaf.zip","https://github.com/other/leaf/releases/download/v1.0.0/Leaf.zip"] {assert!(!official_asset(url,"v1.0.0"));}
    }
}

#[cfg(feature="native-smoke")]
pub async fn package_races()->Result<(),String> {
    use std::sync::{Arc,atomic::{AtomicUsize,Ordering}};
    use tokio::io::{AsyncReadExt,AsyncWriteExt};
    // The actual official verifier crosschecks this fresh run before any network
    // download consumes it. No test-only completion transition is used here.
    let updates=Arc::new(Updates::default());
    let instance=updates.session.lock().unwrap().app_instance;
    let crosschecked=crate::update_package::fixture_verify(instance)?;
    let (payload,candidate,trust)=crate::update_package::fixture_input()?;
    if crosschecked.candidate()!=&candidate {return Err("fixture_candidate_changed".into());}
    drop(crosschecked);
    let body=Arc::new(std::fs::read(&payload).map_err(|_|"fixture_payload")?);
    *updates.trust.lock().unwrap()=trust;
    {
        let mut session=updates.session.lock().unwrap();
        session.candidate=Some(candidate.clone());session.snapshot.state=UpdateState::Available;
        session.snapshot.candidate_id=Some(candidate.opaque_id());session.snapshot.target_version=Some(candidate.version.clone());
    }
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|_|"fixture_server")?;
    let source=format!("http://127.0.0.1:{}/releases",listener.local_addr().map_err(|_|"fixture_address")?.port());
    let release_first=Arc::new(tokio::sync::Notify::new());
    let requests=Arc::new(AtomicUsize::new(0));
    let server_body=body.clone();let server_release=release_first.clone();let server_requests=requests.clone();
    let server=tokio::spawn(async move {
        loop {
            let Ok((mut stream,_))=listener.accept().await else {return;};
            let body=server_body.clone();let release=server_release.clone();let requests=server_requests.clone();
            tokio::spawn(async move {
                let mut request=Vec::new();let mut buffer=[0u8;1024];
                while !request.windows(4).any(|bytes|bytes==b"\r\n\r\n") {
                    let Ok(count)=stream.read(&mut buffer).await else{return;};if count==0||request.len()+count>8192 {return;}
                    request.extend_from_slice(&buffer[..count]);
                }
                if String::from_utf8_lossy(&request).split_whitespace().nth(1)!=Some("/releases/package/12") {return;}
                let index=requests.fetch_add(1,Ordering::SeqCst);
                let length=match index {1=>String::new(),2=>format!("Content-Length: {}\r\n",body.len()+7),4=>format!("Content-Length: {}\r\n",crate::update_package::MAX_DOWNLOAD+1),_=>format!("Content-Length: {}\r\n",body.len())};
                if stream.write_all(format!("HTTP/1.1 200 OK\r\n{length}Connection: close\r\n\r\n").as_bytes()).await.is_err() {return;}
                if index==4 {return;}
                if index==0 {
                    if stream.write_all(&body[..1]).await.is_err() {return;}
                    release.notified().await;
                    let _=stream.write_all(&body[1..]).await;
                }else {let _=stream.write_all(&body).await;}
            });
        }
    });
    let cache=payload.parent().ok_or("fixture_root")?.join("race-cache");
    let changed=Arc::new(tokio::sync::Notify::new());let notices=changed.clone();
    let publish:StatePublisher=Arc::new(move|_|notices.notify_one());
    let candidate_id=candidate.opaque_id();
    let before=updates.snapshot();
    let (first,job)=updates.operation_job(&candidate_id,before.state_revision,false)?;
    let first_worker=tokio::spawn(job.run(cache.clone(),Some(source.clone()),publish.clone()));
    tokio::time::timeout(Duration::from_secs(10),async {
        loop {let next=changed.notified();if updates.snapshot().downloaded_bytes>0 {break;}next.await;}
    }).await.map_err(|_|"race_first_progress")?;
    let cancelled=updates.cancel_download()?;
    if cancelled.op_id<=first.op_id||cancelled.state!=UpdateState::Available
        ||updates.authorize(&candidate_id,before.state_revision,false).is_ok() {return Err("race_cancel_revision".into());}
    // Cancellation completes even while the server withholds the remaining body.
    tokio::time::timeout(Duration::from_secs(5),first_worker).await.map_err(|_|"race_cancel_stalled_network")?.map_err(|_|"race_worker")?;
    release_first.notify_one();
    if record_progress(&updates.session,first.op_id,&candidate_id,instance,99,None).is_some()
        ||mark_verifying(&updates.session,first.op_id,&candidate_id,instance).is_some() {return Err("race_late_callback".into());}
    let (retry,job)=updates.operation_job(&candidate_id,cancelled.state_revision,false)?;
    if retry.op_id<=cancelled.op_id||retry.downloaded_bytes!=0||retry.total_bytes.is_some()
        ||updates.operation_job(&candidate_id,retry.state_revision,false).is_ok() {return Err("race_retry_or_duplicate".into());}
    // Close revokes continuation while the real unknown-length download continues.
    updates.close()?;
    job.run(cache.clone(),Some(source.clone()),publish.clone()).await;
    let ready=updates.snapshot();
    if ready.state!=UpdateState::Ready||ready.total_bytes.is_some()||ready.downloaded_bytes!=body.len() as u64 {return Err("race_hidden_ready".into());}
    let handle=updates.session.lock().unwrap().verified.clone().ok_or("race_handle_absent")?;
    if handle.belongs_to([0;16],&candidate_id)||handle.belongs_to(instance,"another-candidate")
        ||promote_verified(&updates.session,first.op_id,&candidate_id,instance,handle.clone()).is_some() {return Err("race_handle_binding".into());}
    let (resumed,job)=updates.operation_job(&candidate_id,ready.state_revision,true)?;
    if resumed.op_id<=retry.op_id||resumed.state!=UpdateState::Verifying {return Err("race_resume_revalidation".into());}
    updates.close()?;job.run(cache.clone(),None,publish.clone()).await;
    if updates.snapshot().state!=UpdateState::Ready {return Err("race_closed_resume_continued".into());}
    let (_,job)=updates.operation_job(&candidate_id,updates.snapshot().state_revision,true)?;
    job.run(cache.clone(),None,publish.clone()).await;
    if updates.snapshot().state!=UpdateState::PrepareFailed||updates.snapshot().error_code.as_deref()!=Some("update_prepare_unavailable")
        ||updates.session.lock().unwrap().intent.is_some()||handle.consumed() {return Err("race_future_prepare_not_failclosed".into());}
    // A cached tree changed after verification must fail a fresh confirmed resume.
    let resource=if cfg!(target_os="macos") {handle.staged_root().join("Contents/Resources/data.txt")}else{handle.staged_root().join("leaf.exe")};
    std::fs::write(resource,b"Synthetic changed cached bytes").map_err(|_|"race_cache_mutation")?;
    let (_,job)=updates.operation_job(&candidate_id,updates.snapshot().state_revision,true)?;
    job.run(cache.clone(),None,publish.clone()).await;
    if updates.snapshot().state!=UpdateState::DownloadFailed {return Err("race_changed_cache_ready".into());}
    drop(handle);
    // A dishonest response length must fail; it cannot become an authenticated handle.
    let (_,job)=updates.operation_job(&candidate_id,updates.snapshot().state_revision,false)?;
    job.run(cache.clone(),Some(source.clone()),publish.clone()).await;
    if updates.snapshot().state!=UpdateState::DownloadFailed||updates.session.lock().unwrap().verified.is_some() {return Err("race_dishonest_length_ready".into());}
    // Cancel synchronously at the real verifying boundary before the worker reads.
    let cancel_updates=updates.clone();
    let cancel_publish:StatePublisher=Arc::new(move|snapshot| {
        if snapshot.state==UpdateState::Verifying {let _=cancel_updates.cancel_download();}
    });
    let (verify_cancel,job)=updates.operation_job(&candidate_id,updates.snapshot().state_revision,false)?;
    job.run(cache.clone(),Some(source.clone()),cancel_publish).await;
    if updates.snapshot().state!=UpdateState::Available||updates.snapshot().op_id<=verify_cancel.op_id
        ||updates.session.lock().unwrap().verified.is_some() {return Err("race_late_verification_ready".into());}
    let (_,job)=updates.operation_job(&candidate_id,updates.snapshot().state_revision,false)?;
    job.run(cache.clone(),Some(source),publish).await;
    if updates.snapshot().state!=UpdateState::DownloadFailed||updates.snapshot().error_code.as_deref()!=Some("update_response_too_large") {return Err("race_oversized_header_ready".into());}
    // A fresh process has neither continuation authority nor trusted cached handles.
    let fresh=Updates::default();
    {let session=fresh.session.lock().unwrap();
        if session.intent.is_some()||session.verified.is_some() {return Err("race_restart_authority".into());}}
    server.abort();
    println!("native_update_package_races=passed cases=cancel-stalled-network,late-chunk,retry-reset,duplicate-start,close-ready,fresh-resume,cached-mutation,dishonest-length,cancel-verifying,oversized-header,instance-candidate-restart-binding");
    Ok(())
}
