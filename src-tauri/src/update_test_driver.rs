//! Actual Tauri tracer. Compiled only by native-smoke; never accepts renderer endpoints.
use std::sync::{Arc, Mutex};
use tauri::Manager;
use serde_json::{json,Value};
pub fn admission_enabled()->bool{std::env::args().any(|arg|arg=="--update-admission-smoke")}
pub fn trace(phase:&str,key:&str){
    if !admission_enabled(){return;}
    static START:std::sync::OnceLock<std::time::Instant>=std::sync::OnceLock::new();
    let elapsed=START.get_or_init(std::time::Instant::now).elapsed().as_millis();let thread=std::thread::current();
    eprintln!("admission_trace={}",json!({"ms":elapsed,"phase":phase,"key":key,"thread":thread.name().unwrap_or("unnamed")}));
}
struct IoGate {kind:&'static str,state:Mutex<(bool,bool)>,release:std::sync::Condvar,arrived:tokio::sync::Notify}
fn io_gate()->&'static Mutex<Option<Arc<IoGate>>>{static GATE:std::sync::OnceLock<Mutex<Option<Arc<IoGate>>>>=std::sync::OnceLock::new();GATE.get_or_init(||Mutex::new(None))}
fn pause_kind(kind:&str)->Result<(),String>{
    if !admission_enabled()&&!transaction_enabled(){return Ok(());}
    let gate=io_gate().lock().unwrap().clone().filter(|gate|gate.kind==kind);
    if let Some(gate)=gate{
        trace("gate_worker_enter",kind);
        let mut state=gate.state.lock().unwrap();state.0=true;gate.arrived.notify_one();
        let (state,timed)=gate.release.wait_timeout_while(state,std::time::Duration::from_secs(15),|state|!state.1).map_err(|_|"fixture_gate_poisoned")?;
        trace(if timed.timed_out()&&!state.1{"gate_worker_timeout"}else{"gate_worker_released"},kind);
        if timed.timed_out()&&!state.1{return Err("fixture_gate_timeout".into());}
    }Ok(())
}
pub fn pause_io(_app:&tauri::AppHandle,kind:&str)->Result<(),String>{pause_kind(kind)}
pub fn pause_write(path:&std::path::Path)->Result<(),String>{
    if !admission_enabled()&&!transaction_enabled(){return Ok(());}
    let root=std::env::var_os("LEAF_UPDATE_TEST_DIR").map(std::path::PathBuf::from).ok_or("fixture_root_absent")?;
    let root=std::fs::canonicalize(root).map_err(|_|"fixture_root_unavailable")?;
    if !path.starts_with(root){return Err("fixture_write_outside_isolation".into());}pause_kind("write")
}
#[derive(Default)]
struct DeferredBridge {armed:bool,pending:Option<(String,Value)>}
#[derive(Default)]
struct DeferredReply {armed:bool,pending:Option<(String,String,Value)>}
fn deferred_reply()->&'static Mutex<DeferredReply>{static REPLY:std::sync::OnceLock<Mutex<DeferredReply>>=std::sync::OnceLock::new();REPLY.get_or_init(||Mutex::new(DeferredReply::default()))}
pub fn defer_reply(app:&tauri::AppHandle,label:&str,call:&str,value:Value)->bool{
    if !admission_enabled(){return false;}
    let mut deferred=deferred_reply().lock().unwrap();if !deferred.armed{return false;}
    deferred.armed=false;deferred.pending=Some((label.into(),call.into(),value));notify_change(app);true
}
pub fn notify_change(app:&tauri::AppHandle){app.state::<Driver>().changed.notify_one();}
pub fn observe_save_attempt(app:&tauri::AppHandle,label:&str){
    if admission_enabled()&&app.state::<crate::update_admission::AdmissionRegistry>().has_renderer_fence(label){
        *app.state::<Driver>().fenced_save.lock().unwrap()=true;notify_change(app);
    }
}
#[cfg(target_os="macos")]
pub fn report_print(app:&tauri::AppHandle,success:bool){
    let main:objc2::runtime::Bool=unsafe{objc2::msg_send![objc2::class!(NSThread),isMainThread]};
    let active=app.state::<crate::update_admission::AdmissionRegistry>().snapshot().active;
    *app.state::<Driver>().print_result.lock().unwrap()=Some((success,main.as_bool(),active));notify_change(app);
}
fn deferred_bridge()->&'static Mutex<DeferredBridge>{static DEFERRED:std::sync::OnceLock<Mutex<DeferredBridge>>=std::sync::OnceLock::new();DEFERRED.get_or_init(||Mutex::new(DeferredBridge::default()))}
#[derive(Default)]
struct FinishHold{armed:bool,pending:Vec<(String,Value)>}
fn finish_hold()->&'static Mutex<FinishHold>{static HOLD:std::sync::OnceLock<Mutex<FinishHold>>=std::sync::OnceLock::new();HOLD.get_or_init(||Mutex::new(FinishHold::default()))}
pub fn defer_bridge(app:&tauri::AppHandle,label:&str,operation:&str,payload:Value)->bool{
    if prepare_enabled()&&operation=="finish"{
        let mut hold=finish_hold().lock().unwrap();if hold.armed{hold.pending.push((label.into(),payload));notify_change(app);return true;}
    }
    if !admission_enabled()||operation!="apply"{return false;}
    let mut deferred=deferred_bridge().lock().unwrap();if !deferred.armed{return false;}
    deferred.armed=false;deferred.pending=Some((label.into(),payload));
    app.state::<Driver>().changed.notify_one();true
}
#[derive(Default)]
pub struct Driver {
    observation:Mutex<Option<(u64,String,bool)>>,
    changed:tokio::sync::Notify,
    seen:Mutex<Vec<String>>,
    role_reports:Mutex<std::collections::HashMap<(String,String),Value>>,
    print_result:Mutex<Option<(bool,bool,usize)>>,
    fenced_save:Mutex<bool>,
    admission_cases:Mutex<Vec<Value>>,
    coordinator:Mutex<CoordinatorProbe>,
    prepare_ready:Mutex<std::collections::HashMap<String,u64>>,
}
pub fn network_fixture_enabled()->bool {enabled()||std::env::args().any(|arg|matches!(arg.as_str(),"--update-catalog-smoke"|"--update-package-smoke"|"--update-package-races"))}
pub fn package_fixture_enabled()->bool {preservation_enabled()||transaction_enabled()||std::env::args().any(|arg|matches!(arg.as_str(),"--update-package-smoke"|"--update-package-races"|"--mac-update-fixture"))}
pub fn service_probe() {
    let mode=std::env::args().find(|arg|matches!(arg.as_str(),"--update-catalog-smoke"|"--update-package-smoke"|"--update-package-races"));
    let Some(mode)=mode else{return;};
    let result=if mode=="--update-catalog-smoke" {
        let runtime=tokio::runtime::Runtime::new().expect("catalog fixture runtime");
        runtime.block_on(crate::update_releases::smoke())
    }else if mode=="--update-package-smoke" {
        crate::update_package::fixture_verify([73;16]).and_then(|package| {
            let candidate=package.candidate().opaque_id();
            if package.consume([74;16],&candidate).is_ok() {return Err("fixture_wrong_instance_consumed".into());}
            package.consume([73;16],&candidate)?;
            if package.consume([73;16],&candidate).is_ok()||package.revalidate(&||true).is_ok() {return Err("fixture_consumed_package_reused".into());}
            Ok(())
        })
    }else {
        let runtime=tokio::runtime::Runtime::new().expect("package races runtime");
        runtime.block_on(crate::updates::package_races())
    };
    match result {
        Ok(())=>{println!("native_update_service=passed scope={mode}");std::process::exit(0);},
        Err(code)=>{eprintln!("native_update_service=failed error={code}");std::process::exit(1);}
    }
}
pub fn ui_enabled()->bool {std::env::args().any(|a|a=="--update-ui-smoke")}
pub fn preservation_enabled()->bool{
    #[cfg(target_os="macos")] {crate::update_preservation_test_driver::enabled()}
    #[cfg(not(target_os="macos"))] {false}
}
pub fn enabled()->bool { preservation_enabled() || transaction_enabled() || admission_enabled() || ui_enabled() || std::env::args().any(|a|a=="--update-tracer"||a=="--update-tracer-role-matrix") }
pub fn configure(config:&mut tauri::utils::config::Config) {
    if !enabled() {return;}
    #[cfg(target_os="macos")]
    if preservation_enabled(){crate::update_preservation_test_driver::configure(config).expect("isolated preservation configuration");return;}
    let root=tempfile::Builder::new().prefix("leaf-update-tracer-").tempdir().expect("isolated update test directory").keep();
    std::env::set_var("LEAF_UPDATE_TEST_DIR",&root);
    config.identifier="studio.leaf.editor.dev.updatetest".into();
    config.build.dev_url=None;
    for window in &mut config.app.windows {
        window.incognito=true;
        #[cfg(target_os="macos")]
        {window.data_store_identifier=Some([37;16]);window.create=false;}
    }
}
#[tauri::command]
pub fn update_test_observe(app:tauri::AppHandle,window:tauri::WebviewWindow,revision:u64,state:String,editor_loaded:bool,title:String)->Result<(),String>{
    if !enabled()||window.label()!=crate::updates::LABEL {return Err("test_disabled".into());}
    let driver=app.state::<Driver>();
    driver.seen.lock().unwrap().push(state.clone());
    *driver.observation.lock().unwrap()=Some((revision,state,editor_loaded||title.is_empty()));
    driver.changed.notify_one();Ok(())
}
pub(crate) async fn observed(app:&tauri::AppHandle,expected:&str)->Result<(),String> {
    let driver=app.state::<Driver>();
    tokio::time::timeout(std::time::Duration::from_secs(15),async {
        loop {
            let changed=driver.changed.notified();
            let snapshot=app.state::<crate::updates::Updates>().snapshot();
            if let Some((revision,state,invalid))=driver.observation.lock().unwrap().as_ref() {
                if *revision==snapshot.state_revision && state==expected && snapshot.state!=crate::updates::UpdateState::Checking {
                    if *invalid {return Err("updater_editor_side_effect_or_empty_title".to_owned());}return Ok(());
                }
            }
            changed.await;
        }
    }).await.map_err(|_| {
        let native=app.state::<crate::updates::Updates>().snapshot();
        let observed=driver.observation.lock().unwrap().clone();
        let seen=driver.seen.lock().unwrap().clone();
        format!("renderer_state_timeout:{expected}:native={:?}:revision={}:observed={observed:?}:seen={seen:?}",native.state,native.state_revision)
    })?
}
async fn server(listener:tokio::net::TcpListener,scenario:Arc<Mutex<String>>) {
    use tokio::io::{AsyncReadExt,AsyncWriteExt};
    loop {
        let Ok((mut stream,_))=listener.accept().await else{return;};
        let scenario=scenario.clone();
        tokio::spawn(async move {
            let mut request=Vec::new();let mut buffer=[0u8;1024];
            while !request.windows(4).any(|bytes|bytes==b"\r\n\r\n") {
                let Ok(count)=stream.read(&mut buffer).await else{return;};
                if count==0||request.len()+count>8192 {return;}
                request.extend_from_slice(&buffer[..count]);
            }
            let path=String::from_utf8_lossy(&request).split_whitespace().nth(1).unwrap_or("/").to_owned();
            let mode=scenario.lock().unwrap().clone();
            let version=if mode=="current" {env!("CARGO_PKG_VERSION")}else{"9.0.0-beta.10"};
            let asset=format!("https://github.com/CoozeeWang/leaf-markdown/releases/download/v{version}/Leaf-test.zip");
            let payload=if path.contains("/manifest/") {
                let platform=format!("{}-{}",if cfg!(target_os="macos") {"darwin"}else if cfg!(target_os="windows") {"windows"}else{"linux"},std::env::consts::ARCH);
                json!({"version":version,"platforms":{platform:{"url":asset,"signature":"synthetic-check-only-signature"}}})
            }else if mode=="no_catalog" {json!([])} else {
                let mut assets=vec![json!({"id":12,"name":"Leaf-test.zip","browser_download_url":asset})];
                if mode=="available" {assets.push(json!({"id":11,"name":"latest.json","browser_download_url":format!("https://github.com/CoozeeWang/leaf-markdown/releases/download/v{version}/latest.json")}));}
                json!([{"id":1,"tag_name":format!("v{version}"),"draft":false,"published_at":"2026-01-01T00:00:00Z","body":"Synthetic release notes <script>not executable</script>","assets":assets}])
            };
            let (status,body)=if mode=="check_failed" {("503 Service Unavailable",Vec::new())}else{("200 OK",serde_json::to_vec(&payload).unwrap())};
            let header=format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
            let _=stream.write_all(header.as_bytes()).await;let _=stream.write_all(&body).await;
        });
    }
}
async fn run(app:tauri::AppHandle)->Result<(),String> {
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|_|"fixture_server")?;
    let source=format!("http://127.0.0.1:{}/releases",listener.local_addr().map_err(|_|"fixture_address")?.port());
    let scenario=Arc::new(Mutex::new("current".to_owned()));
    app.state::<crate::updates::Updates>().set_test_source(source);
    let server_task=tokio::spawn(server(listener,scenario.clone()));
    let (created_tx,created_rx)=tokio::sync::oneshot::channel();
    let handle=app.clone();
    app.run_on_main_thread(move|| {let _=created_tx.send(crate::create_document(handle,None,None,None));}).map_err(|_|"document_schedule")?;
    created_rx.await.map_err(|_|"document_creation")??;
    let document=app.state::<crate::Documents>().0.lock().unwrap().keys().next().cloned().ok_or("actual_document_absent")?;
    let left=app.clone();let right=app.clone();let caller=document.clone();
    // Both real native roles activate the exact menu action while creation is pending.
    let (a,b)=tokio::join!(async move {crate::dispatch_update_menu(&left,"main")},async move {crate::dispatch_update_menu(&right,&caller)});
    a?;b?;
    observed(&app,"current").await?;
    let updater=app.get_webview_window(crate::updates::LABEL).ok_or("updater_absent")?;
    if !updater.is_visible().unwrap_or(false) {return Err("updater_not_natively_visible".into());}
    if app.state::<crate::Documents>().0.lock().unwrap().contains_key(crate::updates::LABEL) {return Err("updater_registered_as_document".into());}
    let op=app.state::<crate::updates::Updates>().snapshot().op_id;
    // Concurrent callers converge while the same check remains authoritative.
    let left=app.clone();let right=app.clone();
    let (a,b)=tokio::join!(async move {crate::dispatch_update_menu(&left,"main")},async move {crate::dispatch_update_menu(&right,&document)});
    a?;b?;
    if app.webview_windows().values().filter(|w|w.label()==crate::updates::LABEL).count()!=1
        || app.state::<crate::updates::Updates>().snapshot().op_id!=op {return Err("singleton_or_reopen_operation".into());}
    for (mode,state) in [("no_catalog","no_package"),("no_package","no_package"),("available","available"),("check_failed","check_failed"),("current","current")] {
        let previous_op=app.state::<crate::updates::Updates>().snapshot().op_id;
        *scenario.lock().unwrap()=mode.into();
        // Click the real renderer button: IPC and the production reader must both execute.
        // Available's primary action is now confirmation, so check through the real production IPC.
        updater.eval("void window.__TAURI_INTERNALS__.invoke('update_check')").map_err(|_|"renderer_click")?;
        // A prior state with the same name must not satisfy the next observation.
        tokio::time::timeout(std::time::Duration::from_secs(15),async {
            let driver=app.state::<Driver>();
            loop {
                let notified=driver.changed.notified();
                if app.state::<crate::updates::Updates>().snapshot().op_id>previous_op {break;}
                notified.await;
            }
        }).await.map_err(|_|"retry_operation_timeout")?;
        observed(&app,state).await?;
        if mode=="no_catalog" && app.state::<crate::updates::Updates>().snapshot().reason.as_deref()!=Some("no_catalog") {return Err("empty_catalog_claimed_current".into());}
    }
    if !app.state::<Driver>().seen.lock().unwrap().iter().any(|state|state=="checking") {return Err("checking_never_rendered".into());}
    if std::env::args().any(|a|a=="--update-tracer-role-matrix") {role_matrix(&app).await?;}
    if ui_enabled() {ui_smoke(&app,&scenario).await?;}
    server_task.abort();
    Ok(())
}
pub fn start(app:&tauri::AppHandle) {
    if !enabled() {return;}
    #[cfg(target_os="macos")]
    if preservation_enabled(){crate::update_preservation_test_driver::start(app);return;}
    let handle=app.clone();
    tauri::async_runtime::spawn(async move {
        if prepare_enabled(){
            let result=tokio::time::timeout(std::time::Duration::from_secs(240),prepare_smoke(handle.clone())).await.unwrap_or_else(|_|Err("prepare_total_timeout".into()));
            if let Err(code)=result{
                let driver=handle.state::<Driver>();let mut probe=driver.coordinator.lock().unwrap();probe.effects.harness_exit+=1;
                coordinator_output(&json!({"pass":false,"layer":"actual-tauri","tracer":"updates-prepare","manual_driver":false,"production_listeners":true,"syntheticChooser":true,"noOSDialogClaim":true,"error":code,
                    "executed":probe.cases.len(),"scenarios":probe.cases,"side_effects":probe.effects}));
                drop(probe);handle.exit(1);
            }return;
        }
        if coordinator_enabled(){
            let result=tokio::time::timeout(std::time::Duration::from_secs(120),coordinator_smoke(handle.clone())).await.unwrap_or_else(|_|Err("coordinator_total_timeout".into()));
            if let Err(code)=result{
                let driver=handle.state::<Driver>();let mut probe=driver.coordinator.lock().unwrap();probe.effects.harness_exit+=1;
                coordinator_output(&json!({"pass":false,"layer":"actual-tauri","tracer":"updates-coordinator","error":code,
                    "executed":probe.cases.len(),"scenarios":probe.cases,"side_effects":probe.effects}));
                drop(probe);handle.exit(1);
            }
            return;
        }
        let result=tokio::time::timeout(std::time::Duration::from_secs(120),async{
            if admission_enabled(){admission_smoke(handle.clone()).await}else{run(handle.clone()).await}
        }).await
            .unwrap_or_else(|_|Err("tracer_total_timeout".into()));
        let label=if admission_enabled(){"updates-admission"}else if ui_enabled() {"updates-ui"}else if std::env::args().any(|a|a=="--update-tracer-role-matrix") {"updates-role-matrix"}else{"updates"};
        let mut report:Value=match &result {Ok(())=>json!({"pass":true,"layer":"actual-tauri","tracer":label}),Err(code)=>json!({"pass":false,"layer":"actual-tauri","tracer":label,"error":code})};
        if admission_enabled(){let cases=handle.state::<Driver>().admission_cases.lock().unwrap().clone();report["executed"]=json!(cases.len());report["scenarios"]=json!(cases);}
        println!("{report}");
        let output=std::path::PathBuf::from("test-results/desktop-updates-native");
        let _=std::fs::create_dir_all(&output);let _=std::fs::write(output.join(if admission_enabled(){"admission-result.json"}else if ui_enabled() {"ui-result.json"}else{"result.json"}),report.to_string());
        handle.exit(if result.is_ok(){0}else{1});
    });
}
struct GateControl(Arc<IoGate>);
impl GateControl {
    fn arm(kind:&'static str)->Result<Self,String>{
        let mut current=io_gate().lock().unwrap();if current.is_some(){return Err("fixture_gate_already_armed".into());}
        let gate=Arc::new(IoGate{kind,state:Mutex::new((false,false)),release:std::sync::Condvar::new(),arrived:tokio::sync::Notify::new()});*current=Some(gate.clone());Ok(Self(gate))
    }
    async fn started(&self)->Result<(),String>{
        trace("controller_wait",self.0.kind);
        tokio::time::timeout(std::time::Duration::from_secs(12),async{loop{
            let arrived=self.0.arrived.notified();tokio::pin!(arrived);arrived.as_mut().enable();
            if self.0.state.lock().unwrap().0{trace("controller_arrived",self.0.kind);return;}arrived.await;
        }}).await.map_err(|_|format!("fixture_gate_not_reached:{}",self.0.kind))
    }
    fn release(&self){trace("controller_release",self.0.kind);self.0.state.lock().unwrap().1=true;self.0.release.notify_all();}
}
impl Drop for GateControl {fn drop(&mut self){self.release();let mut gate=io_gate().lock().unwrap();if gate.as_ref().is_some_and(|current|Arc::ptr_eq(current,&self.0)){*gate=None;}}}
async fn changed_until(app:&tauri::AppHandle,name:&str,predicate:impl Fn()->bool)->Result<(),String>{
    tokio::time::timeout(std::time::Duration::from_secs(15),async{loop{
        let driver=app.state::<Driver>();let changed=driver.changed.notified();tokio::pin!(changed);changed.as_mut().enable();
        if predicate(){return;}changed.await;
    }}).await.map_err(|_|format!("admission_fixture_timeout:{name}"))
}
fn admission_case(app:&tauri::AppHandle,name:&str,details:Value){
    app.state::<Driver>().admission_cases.lock().unwrap().push(json!({"name":name,"pass":true,"details":details}));
}
async fn invoke_report(app:&tauri::AppHandle,window:&tauri::WebviewWindow,id:&str,command:&str,args:Value)->Result<Value,String>{
    role_report(app,window,id,&format!("try{{const value=await invoke({},{});return {{ok:true,value}}}}catch(error){{return {{ok:false,error:String(error)}}}}",json!(command),args)).await
}
pub(crate) async fn document_ready(app:&tauri::AppHandle,path:&std::path::Path)->Result<tauri::WebviewWindow,String>{
    let path=std::fs::canonicalize(path).map_err(|_|"fixture_ready_path_unavailable")?;
    let registry=app.state::<crate::update_admission::AdmissionRegistry>();
    changed_until(app,"document_ready",||{
        let label=app.state::<crate::Documents>().0.lock().unwrap().iter().find(|(_,candidate)|candidate.as_deref()==Some(path.as_path())).map(|(label,_)|label.clone());
        label.is_some_and(|label|registry.snapshot().participants.get(&label)==Some(&true)&&app.state::<crate::mcp::LeafMcpBroker>().window_binding(&label).is_some())
    }).await.map_err(|error|{
        let documents=app.state::<crate::Documents>().0.lock().unwrap().clone();
        format!("{error}:requested={path:?}:documents={documents:?}:admission={:?}",registry.snapshot())
    })?;
    let label=app.state::<crate::Documents>().0.lock().unwrap().iter().find(|(_,candidate)|candidate.as_deref()==Some(path.as_path())).map(|(label,_)|label.clone()).ok_or("fixture_document_missing")?;
    app.get_webview_window(&label).ok_or("fixture_document_window_missing".into())
}
pub(crate) async fn fixture_document(app:&tauri::AppHandle,name:&str)->Result<(tauri::WebviewWindow,std::path::PathBuf),String>{
    let path=crate::application_data(app).map_err(|_|"fixture_directory")?.join(name);
    std::fs::write(&path,"# Native admission\n").map_err(|_|"fixture_document_write")?;
    let path=std::fs::canonicalize(path).map_err(|_|"fixture_document_canonicalize")?;
    let handle=app.clone();let source=path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move||crate::open_document(handle,Some(source))).await.map_err(|_|"fixture_document_open")??;
    let window=document_ready(app,&path).await?;Ok((window,path))
}
async fn admission_smoke(app:tauri::AppHandle)->Result<(),String>{
    use crate::update_admission::{AdmissionRegistry,AdmissionState,OpenRequest};
    let registry=app.state::<AdmissionRegistry>().inner().clone();
    let broker=app.state::<crate::mcp::LeafMcpBroker>().inner().clone();
    let (window,path)=fixture_document(&app,"admission-source.md").await?;
    let (other,other_path)=fixture_document(&app,"admission-other.md").await?;
    registry.wait_idle(std::time::Duration::from_secs(10)).await?;
    // Actual renderer IPC is paused after admission but before resource bytes.
    let gate=GateControl::arm("resource")?;let handle=app.clone();let target=window.clone();
    let request=tauri::async_runtime::spawn(async move{invoke_report(&handle,&target,"late-resource","import_attachment",json!({"name":"late.png","data":[1,2,3],"source":null})).await});
    gate.started().await?;let barrier=registry.close()?;gate.release();
    let report=request.await.map_err(|_|"resource_task_failed")??;
    if report["ok"]!=false||path.with_file_name("admission-source.assets").exists(){return Err("late_resource_created_bytes".into());}
    registry.wait_idle(std::time::Duration::from_secs(10)).await?;barrier.abort();drop(gate);
    admission_case(&app,"resource_callback",json!({"actual_ipc":true,"late_bytes":false}));
    // Checkpoint's real blocking worker must reject after abort invalidates it.
    let before=app.state::<crate::OpenBuffers>().0.lock().unwrap().get(window.label()).cloned();
    let gate=GateControl::arm("recovery")?;let handle=app.clone();let target=window.clone();
    let request=tauri::async_runtime::spawn(async move{invoke_report(&handle,&target,"late-recovery","recovery_checkpoint",json!({"content":"forbidden late recovery","preserve":true})).await});
    gate.started().await?;let barrier=registry.close()?;barrier.abort();
    if registry.snapshot().state!=AdmissionState::AbortDraining{return Err("recovery_abort_faked_idle".into());}
    gate.release();let report=request.await.map_err(|_|"recovery_task_failed")??;
    if report["ok"]!=false||app.state::<crate::OpenBuffers>().0.lock().unwrap().get(window.label()).cloned()!=before{return Err("late_recovery_mutated_buffer".into());}
    registry.wait_idle(std::time::Duration::from_secs(10)).await?;drop(gate);
    admission_case(&app,"recovery_callback",json!({"actual_ipc":true,"abort_draining":true,"late_buffer_write":false}));
    // Cancel the actual command future while atomic_save is inside real I/O.
    let gate=GateControl::arm("write")?;let handle=app.clone();let target=other.clone();let destination=other_path.to_string_lossy().into_owned();
    let request=tokio::spawn(async move{crate::write_document(handle.clone(),target,handle.state::<crate::Documents>(),handle.state::<crate::DocumentAnchors>(),handle.state::<crate::RecoveryState>(),destination,"# Completed owned I/O\n".into(),Some("# Native admission\n".into()),Vec::new(),None,None).await});
    gate.started().await?;request.abort();let barrier=registry.close()?;barrier.abort();
    if registry.snapshot().state!=AdmissionState::AbortDraining||registry.snapshot().active==0||broker.inner.queue.try_lock().is_ok(){return Err("cancelled_write_released_real_operation".into());}
    let independent=registry.admit_for(Some(window.label()))?;drop(independent);
    gate.release();registry.wait_idle(std::time::Duration::from_secs(10)).await?;drop(gate);
    if std::fs::read_to_string(&other_path).map_err(|_|"write_result_read")?!="# Completed owned I/O\n"||!crate::anchor_matches(&app.state::<crate::DocumentAnchors>(),other.label(),&other_path){return Err("cancelled_write_lost_native_bookkeeping".into());}
    let identity=app.state::<crate::DocumentAnchors>().0.lock().unwrap().get(other.label()).map(|anchor|format!("file:{:?}",anchor.token()));
    if broker.window_binding(other.label()).map(|document|document.logical_identity)!=identity{return Err("cancelled_write_lost_broker_baseline".into());}
    admission_case(&app,"cancelled_save",json!({"actual_atomic_save":true,"queue_retained":true,"native_bookkeeping":true,"independent_document_resumed":true}));
    // Initialization reserves a participant before any disk read or window build.
    let pending_path=crate::application_data(&app).map_err(|_|"fixture_directory")?.join("admission-pending.md");std::fs::write(&pending_path,"# Pending\n").map_err(|_|"fixture_pending_write")?;
    let gate=GateControl::arm("open")?;let handle=app.clone();let source=pending_path.to_string_lossy().into_owned();
    let request=tauri::async_runtime::spawn_blocking(move||crate::open_document(handle,Some(source)));
    gate.started().await?;let barrier=registry.close()?;
    if !barrier.participants.values().any(|ready|!*ready)||barrier.validate_idle().is_ok(){return Err("initializing_document_escaped_snapshot".into());}
    barrier.abort();gate.release();if request.await.map_err(|_|"pending_open_task")?.is_ok(){return Err("stale_initialization_callback_opened".into());}drop(gate);
    registry.wait_idle(std::time::Duration::from_secs(10)).await?;
    let before=app.state::<crate::Documents>().0.lock().unwrap().len();let barrier=registry.close()?;
    crate::dispatch_os_request(&app,OpenRequest::Document(pending_path.clone()))?;
    if registry.snapshot().queued_opens!=1||app.state::<crate::Documents>().0.lock().unwrap().len()!=before{return Err("os_open_not_queued".into());}
    barrier.abort();let _queued=document_ready(&app,&pending_path).await?;registry.wait_idle(std::time::Duration::from_secs(10)).await?;
    admission_case(&app,"initialization_and_os_open",json!({"pending_captured":true,"stale_callback_rejected":true,"queued_open_restored":true}));
    // Use in-memory synthetic credentials; no keychain/profile provisioning.
    *broker.inner.enabled.lock().unwrap()=true;broker.inner.credentials.lock().unwrap().insert("admission-fixture".into(),"synthetic-memory-only".into());
    let credentials=broker.inner.credentials.lock().unwrap().clone();
    let document=broker.window_binding(window.label()).ok_or("fixture_binding")?;
    let document=broker.authorize(&app,window.label(),&document.session_id,"admission-fixture",json!({"from":0,"to":19})).await?;
    let mut binding=json!({"document_id":document.document_id,"session_id":document.session_id,"authorization_epoch":document.authorization_epoch});
    let snapshot=broker.call(&app,"admission-fixture","read_document",binding.clone()).await?;
    let mut begin=binding.clone();begin["request_id"]=json!("admission-settle");begin["revision"]=snapshot["revision"].clone();
    let task=broker.call(&app,"admission-fixture","begin_edit",begin.clone()).await?;
    let barrier=registry.close()?;
    if broker.call(&app,"admission-fixture","begin_edit",begin).await.is_ok(){return Err("barrier_admitted_mcp_begin".into());}
    let mut batch=binding.clone();batch["task_id"]=task["task_id"].clone();batch["request_id"]=json!("admission-blocked");batch["revision"]=snapshot["revision"].clone();batch["changes"]=json!([]);
    if broker.call(&app,"admission-fixture","apply_edit_batch",batch).await.is_ok(){return Err("barrier_admitted_mcp_apply".into());}
    let mut finish=binding.clone();finish["task_id"]=task["task_id"].clone();broker.call(&app,"admission-fixture","finish_edit",finish).await?;
    if *broker.inner.credentials.lock().unwrap()!=credentials{return Err("prepare_revoked_unrelated_client".into());}
    registry.wait_idle(std::time::Duration::from_secs(10)).await?;barrier.abort();
    admission_case(&app,"mcp_existing_task_settlement",json!({"actual_renderer":true,"new_batches_denied":true,"finish_allowed":true,"credentials_preserved":true}));
    // Lose a real apply dispatch, then let its production timeout settle. Its
    // per-document fence must survive the queue release until a matching reply.
    let snapshot=broker.call(&app,"admission-fixture","read_document",binding.clone()).await?;
    let mut begin=binding.clone();begin["request_id"]=json!("admission-timeout");begin["revision"]=snapshot["revision"].clone();let task=broker.call(&app,"admission-fixture","begin_edit",begin).await?;
    deferred_bridge().lock().unwrap().armed=true;
    let mut batch=binding.clone();batch["task_id"]=task["task_id"].clone();batch["request_id"]=json!("admission-timeout-batch");batch["revision"]=snapshot["revision"].clone();batch["changes"]=json!([{"from":2,"to":8,"expected":"Native","insert":"NATIVE"}]);
    let handle=app.clone();let service=broker.clone();let request=tauri::async_runtime::spawn(async move{service.call(&handle,"admission-fixture","apply_edit_batch",batch).await});
    changed_until(&app,"deferred_apply",||deferred_bridge().lock().unwrap().pending.is_some()).await?;
    let outcome=request.await.map_err(|_|"deferred_apply_task")?;
    if outcome.as_ref().err().map(String::as_str)!=Some("mutation_outcome_unknown")||!registry.has_renderer_fence(window.label()){
        return Err(format!("timeout_outcome_or_fence_incorrect:outcome={outcome:?}:admission={:?}",registry.snapshot()));
    }
    // Other documents' normal polling may already own the queue. Acquire and
    // release it within a bound to prove actual liveness, while the unresolved
    // target call remains fenced throughout. An instant try_lock is not proof.
    let serial=tokio::time::timeout(std::time::Duration::from_secs(5),broker.inner.queue.lock()).await
        .map_err(|_|format!("timeout_queue_did_not_release:admission={:?}",registry.snapshot()))?;
    trace("timeout_queue_acquired",window.label());drop(serial);
    if !registry.has_renderer_fence(window.label()){return Err(format!("timeout_fence_disappeared_before_reply:admission={:?}",registry.snapshot()));}
    let report=invoke_report(&app,&window,"fenced-competing-save","write_document",json!({"path":path,"content":"forbidden competing save","expected":"# Native admission\n","resources":[],"saveBinding":null})).await?;
    if report["ok"]!=false{return Err("timeout_competing_write_entered".into());}
    let unrelated=registry.admit_for(Some(other.label()))?;drop(unrelated);broker.bridge(&app,window.label(),"snapshot",json!({})).await?;
    let (label,payload)=deferred_bridge().lock().unwrap().pending.take().ok_or("deferred_apply_absent")?;broker.dispatch_deferred(&app,&label,payload)?;
    // This real renderer reply is stale_task and UNAPPLIED, not a forced clear.
    registry.wait_idle(std::time::Duration::from_secs(10)).await?;
    if std::fs::read_to_string(&path).map_err(|_|"timeout_file_read")?!="# Native admission\n"{return Err("late_apply_changed_disk".into());}
    admission_case(&app,"mcp_timeout_late_apply",json!({"production_timeout":true,"same_document_blocked":true,"unrelated_document_and_read_allowed":true,"real_reply_released_fence":true}));
    // Drop only the actual successful mutation ACK. Autosave has to run its
    // observation -> checkpoint -> write sequence while that fence is present.
    let current=broker.window_binding(window.label()).ok_or("fixture_binding")?;let document=broker.authorize(&app,window.label(),&current.session_id,"admission-fixture",json!({"from":0,"to":19})).await?;
    binding=json!({"document_id":document.document_id,"session_id":document.session_id,"authorization_epoch":document.authorization_epoch});
    let snapshot=broker.call(&app,"admission-fixture","read_document",binding.clone()).await?;let mut begin=binding.clone();begin["request_id"]=json!("admission-autosave");begin["revision"]=snapshot["revision"].clone();let task=broker.call(&app,"admission-fixture","begin_edit",begin).await?;
    *app.state::<Driver>().fenced_save.lock().unwrap()=false;deferred_reply().lock().unwrap().armed=true;
    let gate=GateControl::arm("write")?;let mut batch=binding.clone();batch["task_id"]=task["task_id"].clone();batch["request_id"]=json!("admission-autosave-batch");batch["revision"]=snapshot["revision"].clone();batch["changes"]=json!([{"from":2,"to":8,"expected":"Native","insert":"NATIVE"}]);
    let handle=app.clone();let service=broker.clone();let request=tauri::async_runtime::spawn(async move{service.call(&handle,"admission-fixture","apply_edit_batch",batch).await});
    changed_until(&app,"deferred_reply",||deferred_reply().lock().unwrap().pending.is_some()).await?;
    let receipt=request.await.map_err(|_|"autosave_apply_task")??;
    gate.started().await?;
    if registry.snapshot().active==0||!*app.state::<Driver>().fenced_save.lock().unwrap(){return Err("autosave_io_untracked_or_fence_not_exercised".into());}
    gate.release();registry.wait_idle(std::time::Duration::from_secs(10)).await?;drop(gate);
    if std::fs::read_to_string(&path).map_err(|_|"autosave_file_read")?!="# NATIVE admission\n"{return Err("matching_receipt_autosave_failed".into());}
    // The pending renderer fence was already resolved by exact receipt proof;
    // replaying its delayed ACK cannot resolve another call or mutate again.
    let (label,call,value)=deferred_reply().lock().unwrap().pending.take().ok_or("deferred_reply_absent")?;
    if broker.renderer_reply(&label,&call,value).is_ok(){return Err("proved_reply_reused".into());}
    let mut finish=binding;finish["task_id"]=task["task_id"].clone();broker.call(&app,"admission-fixture","finish_edit",finish).await?;
    let records=broker.inner.ledger.records.lock().unwrap().values().filter(|record|record.mutation_id==receipt["mutation_id"]).cloned().collect::<Vec<_>>();
    if records.len()!=1||records[0].result.as_ref().is_none_or(|result|result["diskResult"]["state"]!="saved"){return Err("autosave_native_receipt_not_saved".into());}
    admission_case(&app,"mcp_receipt_autosave",json!({"actual_apply_ack_withheld":true,"actual_autosave":true,"autosave_started_while_fenced":true,"exact_receipt_proof":true,"native_saved_result":true,"replayed_ack_denied":true}));
    // Seal rejects whole finalization before mutating a real active task.
    let mut begin=json!({"document_id":document.document_id,"session_id":document.session_id,"authorization_epoch":document.authorization_epoch,"request_id":"admission-sealed-task","revision":receipt["applied_revision"]});
    let task=broker.call(&app,"admission-fixture","begin_edit",begin.clone()).await?;
    registry.wait_idle(std::time::Duration::from_secs(10)).await?;let barrier=registry.close()?;let _seal=barrier.seal()?;
    let mut current=broker.window_binding(window.label()).ok_or("fixture_binding")?;let previous=serde_json::to_value(&current).map_err(|_|"fixture_binding_json")?;
    if broker.finalize(&app,&mut current).await.is_ok()||serde_json::to_value(&current).map_err(|_|"fixture_binding_json")?!=previous{return Err("sealed_finalize_mutated".into());}
    let ready=registry.snapshot().participants;
    if broker.retire_authorization(&app,window.label(),&current.session_id,current.authorization_epoch).await.err().as_deref()!=Some(crate::update_admission::BUSY){return Err("sealed_retirement_entered".into());}
    let registered=invoke_report(&app,&window,"sealed-register","mcp_register",json!({})).await?;
    let after=broker.window_binding(window.label()).ok_or("fixture_binding")?;
    if registered["error"]!=crate::update_admission::BUSY||serde_json::to_value(after).map_err(|_|"fixture_binding_json")?!=previous||registry.snapshot().participants!=ready{return Err("sealed_registration_or_retirement_mutated".into());}
    let close=invoke_report(&app,&window,"native-close-decision","mcp_document_boundary",json!({"reason":"close"})).await?;
    if close["error"]!="update_prepare_cancelled"||registry.snapshot().state!=AdmissionState::Open||app.get_webview_window(window.label()).is_none(){return Err("native_close_did_not_cancel_prepare".into());}barrier.abort();
    begin["task_id"]=task["task_id"].clone();broker.call(&app,"admission-fixture","finish_edit",begin).await?;
    admission_case(&app,"sealed_settlement",json!({"whole_finalize_denied":true,"whole_retirement_denied":true,"actual_register_ipc_denied":true,"native_binding_unchanged":true,"native_ready_unchanged":true,"actual_close_ipc_cancelled_prepare":true,"window_retained":true}));
    let root=crate::application_data(&app).map_err(|_|"fixture_directory")?;
    let barrier=registry.close()?;let commands=vec![
        ("new_document",json!({"path":root.join("forbidden.md")})),
        ("open_document",json!({"path":path})),
        ("write_document",json!({"path":path,"content":"forbidden","expected":"# NATIVE admission\n","resources":[],"saveBinding":null})),
        ("rename_document",json!({"path":path,"name":"forbidden.md","expected":"# NATIVE admission\n","content":"forbidden"})),
        ("relocate_document",json!({"path":path,"expected":"# NATIVE admission\n","loadedImages":[]})),
        ("import_attachment",json!({"name":"forbidden.png","data":[4,5,6],"source":null})),
        ("copy_pasted_images",json!({"sourceLabel":other.label(),"references":[]})),
        ("recovery_checkpoint",json!({"content":"forbidden","preserve":true})),
        ("recovery_delete",json!({"key":"synthetic-record","id":"synthetic-entry"})),
        ("recovery_open",json!({"key":"synthetic-record","id":"synthetic-entry"})),
        ("recovery_retention",json!({"days":30})),
        ("open_export",json!({"snapshot":{"source":"forbidden","name":"Synthetic.md","numbered":false}})),
        ("export_bundle",json!({"directory":root,"content":"forbidden","resources":[]})),
        ("language_set",json!({"preference":"en"})),
    ];
    let blocked_count=commands.len();
    for (index,(command,args)) in commands.into_iter().enumerate(){
        let report=invoke_report(&app,&window,&format!("blocked-{index}"),command,args).await?;
        if report["ok"]!=false||report["error"]!=crate::update_admission::BUSY{return Err(format!("mapped_mutator_not_rejected:{command}:{report}"));}
    }
    if broker.set_enabled(&app,false).await.err().as_deref()!=Some(crate::update_admission::BUSY)||broker.stop_tunnel(&app).await.err().as_deref()!=Some(crate::update_admission::BUSY){return Err("connection_mutator_admitted".into());}
    let read=invoke_report(&app,&window,"allowed-pure-read","read_document",json!({"path":path})).await?;
    let expiry=invoke_report(&app,&window,"paused-expiry","recovery_expire",json!({})).await?;
    if read["ok"]!=true||expiry["value"]!=0{return Err("barrier_read_or_expiry_incorrect".into());}
    barrier.abort();
    admission_case(&app,"mapped_native_mutators",json!({"rejected_commands":blocked_count,"connection_operations_rejected":2,"pure_read_allowed":true,"expiry_paused":true}));
    // Positive resource/paste/export and transaction Save As run the same real
    // commands, exercising nested rehome and checkpoint I/O under one scope.
    let imported=invoke_report(&app,&window,"positive-import","import_attachment",json!({"name":"synthetic.png","data":[1,2,3,4],"source":null})).await?;
    if imported["ok"]!=true{return Err("resource_positive_import_failed".into());}
    let relative=imported["value"].as_str().ok_or("resource_positive_path")?.to_owned();
    let pasted=invoke_report(&app,&other,"positive-paste","copy_pasted_images",json!({"sourceLabel":window.label(),"references":[relative]})).await?;
    if pasted["ok"]!=true||pasted["value"].as_array().is_none_or(|mappings|mappings.len()!=1){return Err("resource_positive_paste_failed".into());}
    let content=format!("# Scoped save\n\n![synthetic]({relative})\n");let destination=root.join("admission-scoped.md");
    registry.wait_idle(std::time::Duration::from_secs(10)).await?;let barrier=registry.close()?;let permission=barrier.save_scope(window.label())?;
    let checkpoint=invoke_report(&app,&window,"scoped-checkpoint","recovery_checkpoint",json!({"content":content,"preserve":true})).await?;
    let saved=invoke_report(&app,&window,"scoped-save-as","write_document",json!({"path":destination,"content":content,"expected":null,"resources":[relative],"saveBinding":null})).await?;
    if checkpoint["ok"]!=true||saved["ok"]!=true{return Err(format!("scoped_native_save_failed:{checkpoint}:{saved}"));}
    drop(permission);registry.wait_idle(std::time::Duration::from_secs(10)).await?;barrier.validate_idle()?;barrier.abort();
    let saved_content=std::fs::read_to_string(&destination).map_err(|_|"scoped_save_result_read")?;
    if !saved_content.contains("admission-scoped.assets/")||!destination.with_file_name("admission-scoped.assets").is_dir(){return Err("scoped_save_rehome_missing".into());}
    let export=invoke_report(&app,&window,"positive-bundle","export_bundle",json!({"directory":root,"content":saved_content,"resources":[]})).await?;
    if export["ok"]!=true{return Err("resource_positive_bundle_failed".into());}
    admission_case(&app,"scoped_save_and_resource_io",json!({"actual_import":true,"actual_paste":true,"native_save_scope":true,"actual_checkpoint":true,"actual_save_as_rehome":true,"actual_bundle":true}));
    #[cfg(target_os="macos")]
    {
        let report=invoke_report(&app,&window,"admission-export","open_export",json!({"snapshot":{"source":"# Synthetic PDF\n\nAdmission completion fixture.","name":"Synthetic admission.md","numbered":false}})).await?;
        if report["ok"]!=true{return Err("fixture_export_open_failed".into());}
        let label=app.state::<crate::Exports>().0.lock().unwrap().keys().next().cloned().ok_or("fixture_export_missing")?;let export=app.get_webview_window(&label).ok_or("fixture_export_window")?;
        let report=role_report(&app,&export,"admission-pdf-ready","await document.fonts.ready;const ready=()=>document.querySelector('.print-document')?.textContent.includes('Synthetic PDF');if(!ready())await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{observer.disconnect();reject(new Error('pdf_dom_timeout'))},10000);const observer=new MutationObserver(()=>{if(ready()){clearTimeout(timer);observer.disconnect();resolve()}});observer.observe(document,{childList:true,subtree:true})});return {ready:ready()};").await?;
        if report["ready"]!=true{return Err("fixture_pdf_dom_missing".into());}
        let report=invoke_report(&app,&export,"admission-pdf-print","print_export",json!({})).await?;if report["ok"]!=true{return Err("fixture_print_command".into());}
        changed_until(&app,"print_did_run",||app.state::<Driver>().print_result.lock().unwrap().is_some()).await?;
        let (success,main,active)=app.state::<Driver>().print_result.lock().unwrap().ok_or("fixture_print_result")?;
        if !success||!main||active==0{return Err("print_callback_lifetime_or_thread".into());}
        registry.wait_idle(std::time::Duration::from_secs(10)).await?;
        let bytes=std::fs::read(crate::application_data(&app).map_err(|_|"fixture_directory")?.join("admission.pdf")).map_err(|_|"fixture_pdf_read")?;
        if !bytes.starts_with(b"%PDF-")||!bytes.windows(5).any(|bytes|bytes==b"%%EOF"){return Err("fixture_pdf_incomplete".into());}
        admission_case(&app,"actual_print_completion",json!({"did_run":true,"main_thread_release":true,"lease_alive_in_callback":true,"pdf_header_and_eof":true,"bytes":bytes.len()}));
    }
    if *broker.inner.credentials.lock().unwrap()!=credentials{return Err("fixture_credentials_changed".into());}
    Ok(())
}
async fn ui_smoke(app:&tauri::AppHandle,scenario:&Arc<Mutex<String>>)->Result<(),String> {
    use crate::updates::{UpdateState,Updates,LABEL};
    *scenario.lock().unwrap()="available".into();
    let updater=app.get_webview_window(LABEL).ok_or("updater_absent")?;
    let _=role_report(app,&updater,"ui-check","await invoke('update_check');return {requested:true};").await?;
    observed(app,"available").await?;
    let report=role_report(app,&updater,"ui-confirm",r#"
        document.getElementById('update-action').click();
        const safe=document.activeElement?.id==='update-confirm-cancel'&&document.getElementById('app').inert;
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',repeat:true,bubbles:true}));
        return {safe,cancelled:!document.querySelector('[role=alertdialog]'),focus:document.activeElement?.id==='update-action'};
    "#).await?;
    if report["safe"]!=true||report["cancelled"]!=true||report["focus"]!=true||!updater.is_visible().unwrap_or(false) {return Err("ui_confirmation_focus_or_escape".into());}
    let _=role_report(app,&updater,"ui-start",r#"
        document.getElementById('update-action').click();document.getElementById('update-confirm-submit').click();
        return {requested:true};
    "#).await?;
    observed(app,"downloading").await?;
    let started=app.state::<Updates>().snapshot();let candidate=started.candidate_id.clone().ok_or("ui_candidate_missing")?;
    let report=role_report(app,&updater,"ui-replay",&format!(r#"
        let rejected=false;try{{await invoke('update_start',{{candidateId:{},stateRevision:{}}})}}catch(_){{rejected=true}}
        await invoke('update_close');return {{rejected}};
    "#,serde_json::to_string(&candidate).unwrap(),started.state_revision)).await?;
    if report["rejected"]!=true||updater.is_visible().unwrap_or(true) {return Err("ui_replay_or_hide_failed".into());}
    let hidden=app.state::<Updates>().snapshot();
    if hidden.op_id!=started.op_id||hidden.state!=UpdateState::Downloading {return Err("ui_hide_cancelled_download".into());}
    let ready=app.state::<Updates>().test_complete_download(started.op_id,&candidate).ok_or("ui_download_completion")?;
    if ready.state!=UpdateState::Ready {return Err("ui_hidden_intent_survived".into());}
    // Deliberately omit the hidden event: focus must reconcile actual native status.
    crate::updates::open_update_window(app)?;observed(app,"ready").await?;
    if !updater.is_visible().unwrap_or(false) {return Err("ui_reopen_invisible".into());}
    let report=role_report(app,&updater,"ui-resume-confirm",r#"
        document.getElementById('update-action').click();
        return {confirmation:!!document.querySelector('[role=alertdialog]'),safe:document.activeElement?.id==='update-confirm-cancel'};
    "#).await?;
    if report["confirmation"]!=true||report["safe"]!=true||app.state::<Updates>().snapshot().state!=UpdateState::Ready {return Err("ui_ready_implicitly_resumed".into());}
    let _=role_report(app,&updater,"ui-resume","document.getElementById('update-confirm-submit').click();return {requested:true};").await?;
    observed(app,"preparing").await?;
    crate::updates::hide_update_window(app)?;
    if app.state::<Updates>().snapshot().state!=UpdateState::PrepareFailed {return Err("ui_preparation_not_cancelled".into());}
    Ok(())
}
pub fn official_probe()->bool {
    if !std::env::args().any(|a|a=="--update-official-probe") {return false;}
    let runtime=tokio::runtime::Runtime::new().expect("probe runtime");
    let result=runtime.block_on(async {tokio::time::timeout(std::time::Duration::from_secs(100),async {
        crate::updates::read_official_catalog_probe().await
    }).await});
    match result {
        Ok(Ok(result))=>{println!("fixed_official_tls_query=passed state={:?}",result.state);std::process::exit(0);},
        Ok(Err(code))=>{eprintln!("fixed_official_tls_query=failed error={code}");std::process::exit(1);},
        Err(_)=>{eprintln!("fixed_official_tls_query=failed error=update_probe_timeout");std::process::exit(1);}
    }
}

#[tauri::command]
pub fn update_test_role_report(app:tauri::AppHandle,window:tauri::WebviewWindow,case_id:String,report:Value)->Result<(),String> {
    if !enabled() {return Err("test_disabled".into());}
    let driver=app.state::<Driver>();
    trace("ipc_report_received",&case_id);
    driver.role_reports.lock().unwrap().insert((window.label().to_owned(),case_id),report);
    driver.changed.notify_one();Ok(())
}
pub fn notify_window_change(app:&tauri::AppHandle) {
    if enabled() {app.state::<Driver>().changed.notify_one();}
}
pub(crate) async fn role_report(app:&tauri::AppHandle,window:&tauri::WebviewWindow,case_id:&str,body:&str)->Result<Value,String> {
    let entered=if admission_enabled(){format!("await invoke('update_test_role_report',{{caseId:{},report:{{stage:'entered'}}}});",json!(format!("{case_id}:entered")))}else{String::new()};
    let settled=if admission_enabled(){format!("await invoke('update_test_role_report',{{caseId:{},report:{{stage:'settled'}}}});",json!(format!("{case_id}:settled")))}else{String::new()};
    let script=format!("(async()=>{{const invoke=window.__TAURI_INTERNALS__.invoke;{entered}let report;try{{report=await(async()=>{{{body}}})()}}catch(_){{report={{exception:true}}}}{settled}await invoke('update_test_role_report',{{caseId:{},report}})}})()",serde_json::to_string(case_id).unwrap());
    trace("role_eval",case_id);
    window.eval(script).map_err(|_|"role_probe_eval")?;
    let key=(window.label().to_owned(),case_id.to_owned());let driver=app.state::<Driver>();
    tokio::time::timeout(std::time::Duration::from_secs(15),async {
        loop {
            let changed=driver.changed.notified();
            if let Some(report)=driver.role_reports.lock().unwrap().remove(&key) {return report;}
            changed.await;
        }
    }).await.map_err(|_|{
        trace("role_timeout",case_id);
        let keys=driver.role_reports.lock().unwrap().keys().cloned().collect::<Vec<_>>();
        let admission=app.state::<crate::update_admission::AdmissionRegistry>().snapshot();
        format!("role_report_timeout:{case_id}:received={keys:?}:admission={admission:?}")
    })
}
async fn probe_window(app:&tauri::AppHandle,label:&str)->Result<tauri::WebviewWindow,String> {
    let (ready_tx,ready_rx)=tokio::sync::oneshot::channel();
    let ready=Arc::new(Mutex::new(Some(ready_tx)));
    let (built_tx,built_rx)=tokio::sync::oneshot::channel();
    let handle=app.clone();let owned=label.to_owned();
    app.run_on_main_thread(move|| {
        let builder=tauri::WebviewWindowBuilder::new(&handle,&owned,tauri::WebviewUrl::App("index.html?updateWindow=1".into()))
            .title("Leaf Role Test").visible(false).on_page_load(move|_,payload| {
                if payload.event()==tauri::webview::PageLoadEvent::Finished {
                    if let Some(tx)=ready.lock().unwrap().take() {let _=tx.send(());}
                }
            });
        let result=crate::development_window(&handle,builder).build().map_err(|_|"role_window_build".to_owned());
        let _=built_tx.send(result);
    }).map_err(|_|"role_window_schedule")?;
    let window=built_rx.await.map_err(|_|"role_window_build")??;
    tokio::time::timeout(std::time::Duration::from_secs(15),ready_rx).await.map_err(|_|"role_window_load_timeout")?.map_err(|_|"role_window_load")?;
    Ok(window)
}
async fn role_matrix(app:&tauri::AppHandle)->Result<(),String> {
    let updater=app.get_webview_window(crate::updates::LABEL).ok_or("role_updater_absent")?;
    let document=crate::document_window(app).ok_or("role_document_absent")?;
    if app.state::<crate::mcp::LeafMcpBroker>().window_binding(crate::updates::LABEL).is_some() {return Err("updater_registered_with_mcp".into());}
    let report=role_report(app,&updater,"updater-authority",r#"
        const commands=['new_document','open_document','write_document','read_document','rename_document','import_attachment','recovery_checkpoint','recovery_open','open_export','mcp_register','mcp_configure_tunnel','ordinary_quit_cancelled','language_set'];
        const denied=[];
        for(const command of commands){try{await invoke(command,{});denied.push(false)}catch(error){denied.push(error==='window_role_denied')}}
        let capabilityDenied=false;
        try{await invoke('plugin:window|destroy',{label:'desktop-update'})}catch(_){capabilityDenied=true}
        return {denied:denied.every(Boolean),capabilityDenied};
    "#).await?;
    if report["denied"]!=true || report["capabilityDenied"]!=true {return Err("updater_authority_not_narrow".into());}
    for label in ["document-unregistered","role-unrecognized"] {
        let window=probe_window(app,label).await?;
        if crate::verified_window_role(app,label)!=crate::window_role::WindowRole::Unknown {return Err("forged_label_gained_authority".into());}
        let report=role_report(app,&window,"unknown-authority",r#"
            let denied=false;try{await invoke('write_document',{})}catch(error){denied=error==='window_role_denied'}
            return {denied};
        "#).await?;
        if report["denied"]!=true {return Err("unknown_window_mutation".into());}
        if crate::dispatch_document_menu(app,label,"new")? {return Err("unknown_window_menu".into());}
        window.destroy().map_err(|_|"probe_close")?;
    }
    for command in ["new","save","save-as","undo","settings"] {
        if crate::dispatch_document_menu(app,updater.label(),command)? {return Err("updater_document_menu".into());}
    }
    // A real document may cancel only the current numbered ordinary Quit.
    let participants=[document.label().to_owned()].into_iter().collect();
    let old=app.state::<Mutex<crate::window_role::OrdinaryQuit>>().lock().unwrap().begin(participants).map_err(str::to_owned)?;
    let current=app.state::<Mutex<crate::window_role::OrdinaryQuit>>().lock().unwrap().begin([document.label().to_owned()].into_iter().collect()).map_err(str::to_owned)?;
    let body=format!(r#"
        let wrongRole=false,stale=false,cancelled=false;
        try{{await invoke('update_status')}}catch(error){{wrongRole=error==='window_role_denied'}}
        try{{await invoke('ordinary_quit_cancelled',{{quitId:{old}}})}}catch(error){{stale=error==='quit_intent_stale'}}
        try{{await invoke('ordinary_quit_cancelled',{{quitId:{current}}});cancelled=true}}catch(_){{}}
        return {{wrongRole,stale,cancelled}};
    "#);
    let report=role_report(app,&document,"ordinary-quit-cancel",&body).await?;
    if report["wrongRole"]!=true||report["stale"]!=true||report["cancelled"]!=true {return Err("ordinary_quit_cancellation_identity".into());}
    if app.get_webview_window(document.label()).is_none() || app.get_webview_window(updater.label()).is_none() {return Err("quit_cancel_destroyed_window".into());}
    // Close and re-open only hides the updater and never repeats its check.
    let op=app.state::<crate::updates::Updates>().snapshot().op_id;
    let report=role_report(app,&updater,"updater-hide","await invoke('update_close');return {closed:true};").await?;
    if report["closed"]!=true||updater.is_visible().unwrap_or(true)||app.get_webview_window(document.label()).is_none() {return Err("updater_hide_affected_document".into());}
    crate::dispatch_update_menu(app,document.label())?;
    if !updater.is_visible().unwrap_or(false)||app.state::<crate::updates::Updates>().snapshot().op_id!=op {return Err("updater_reopen_rechecked".into());}
    // A registered export retains its normal read/print identity, then closes
    // without removing either the document or updater.
    let export_label="export-role-probe";
    app.state::<crate::Exports>().0.lock().unwrap().insert(export_label.into(),crate::ExportSnapshot{source:"# Synthetic export".into(),name:"Synthetic.md".into(),numbered:false,base_path:None});
    let export=probe_window(app,export_label).await?;
    let report=role_report(app,&export,"export-authority",r#"
        let readable=false,denied=false;
        try{const snapshot=await invoke('export_snapshot');readable=snapshot.name==='Synthetic.md'}catch(_){}
        try{await invoke('write_document',{})}catch(error){denied=error==='window_role_denied'}
        return {readable,denied};
    "#).await?;
    if report["readable"]!=true||report["denied"]!=true {return Err("export_contract_changed".into());}
    if crate::dispatch_document_menu(app,export_label,"save")? {return Err("export_document_menu".into());}
    export.destroy().map_err(|_|"export_close")?;
    if app.get_webview_window(document.label()).is_none()||app.get_webview_window(updater.label()).is_none() {return Err("export_close_affected_other_roles".into());}
    // Last-document close preserves even a hidden updater and the exact state.
    crate::updates::hide_update_window(app)?;
    document.destroy().map_err(|_|"last_document_close")?;
    let driver=app.state::<Driver>();
    tokio::time::timeout(std::time::Duration::from_secs(15),async {
        loop {
            let changed=driver.changed.notified();
            if app.state::<crate::Documents>().0.lock().unwrap().is_empty() && app.get_webview_window(document.label()).is_none() {break;}
            changed.await;
        }
    }).await.map_err(|_|"last_document_close_timeout")?;
    if app.get_webview_window(updater.label()).is_none()||!app.get_webview_window(crate::LAUNCHER).is_some_and(|w|w.is_visible().unwrap_or(false)) {return Err("hidden_updater_left_no_launcher".into());}
    crate::dispatch_update_menu(app,crate::LAUNCHER)?;
    if !updater.is_visible().unwrap_or(false)||app.state::<crate::updates::Updates>().snapshot().op_id!=op {return Err("last_document_lost_update_snapshot".into());}
    // Repeat the last-document boundary with an already-visible updater.
    let (tx,rx)=tokio::sync::oneshot::channel();let handle=app.clone();
    app.run_on_main_thread(move||{let _=tx.send(crate::create_document(handle,None,None,None));}).map_err(|_|"second_document_schedule")?;
    rx.await.map_err(|_|"second_document_create")??;
    let final_document=crate::document_window(app).ok_or("second_document_absent")?;
    final_document.destroy().map_err(|_|"visible_updater_document_close")?;
    tokio::time::timeout(std::time::Duration::from_secs(15),async {
        loop {
            let changed=driver.changed.notified();
            if app.state::<crate::Documents>().0.lock().unwrap().is_empty() && app.get_webview_window(final_document.label()).is_none() {break;}
            changed.await;
        }
    }).await.map_err(|_|"visible_updater_document_close_timeout")?;
    if !updater.is_visible().unwrap_or(false)||app.get_webview_window(crate::LAUNCHER).is_none() {return Err("last_document_destroyed_visible_updater".into());}
    Ok(())
}

#[derive(Default,Clone,serde::Serialize)]
struct CoordinatorEffects {
    destroy:u64,exit:u64,install:u64,restart:u64,leaf_close:u64,
    accepted_exit_requested:u64,rejected_exit_requested:u64,exit_events:u64,harness_exit:u64,shutdown_destroyed:u64,
}
#[derive(Default)]
struct CoordinatorProbe {effects:CoordinatorEffects,cases:Vec<Value>,final_pending:bool}
pub fn coordinator_enabled()->bool{std::env::args().any(|arg|arg=="--update-coordinator-smoke")}
pub fn coordinator_leaf_close(app:&tauri::AppHandle){if transaction_enabled(){app.state::<Driver>().coordinator.lock().unwrap().effects.leaf_close+=1;}}
pub fn coordinator_destroyed(app:&tauri::AppHandle,label:&str){
    if transaction_enabled()&&crate::role_for_label(label)==crate::WindowRole::Document{
        let committed=app.state::<crate::update_coordinator::UpdateCoordinator>().committed();
        let driver=app.state::<Driver>();let mut probe=driver.coordinator.lock().unwrap();
        if committed{probe.effects.shutdown_destroyed+=1;}else{probe.effects.destroy+=1;}
    }
}
pub fn coordinator_exit_requested(app:&tauri::AppHandle,accepted:bool){
    if !transaction_enabled(){return;}
    let driver=app.state::<Driver>();let mut probe=driver.coordinator.lock().unwrap();
    if accepted{probe.effects.accepted_exit_requested+=1;}else{probe.effects.rejected_exit_requested+=1;}
}
fn coordinator_output(report:&Value){
    println!("{report}");
    let output=std::path::PathBuf::from("test-results/desktop-updates-native");
    let _=std::fs::create_dir_all(&output);let _=std::fs::write(output.join(if prepare_enabled(){"prepare-result.json"}else{"coordinator-result.json"}),report.to_string());
}
pub fn coordinator_exited(app:&tauri::AppHandle){
    if !transaction_enabled(){return;}
    let driver=app.state::<Driver>();let mut probe=driver.coordinator.lock().unwrap();
    probe.effects.exit_events+=1;
    if !probe.final_pending{return;}
    let actual=probe.effects.clone();
    let pass=actual.exit==1&&actual.accepted_exit_requested==1&&actual.exit_events==1
        &&actual.rejected_exit_requested==0&&actual.install==0&&actual.restart==0&&actual.leaf_close==0&&actual.harness_exit==0
        &&actual.destroy==0&&probe.cases.len()==(if prepare_enabled(){21}else{14})&&probe.cases.iter().all(|case|case["pass"]==true);
    if let Some(last)=probe.cases.last_mut(){
        last["pass"]=json!(pass);last["side_effects"]=json!(actual);
        last["details"]["actual_run_event_exit"]=json!(true);
    }
    coordinator_output(&json!({"pass":pass,"layer":"actual-tauri","tracer":if prepare_enabled(){"updates-prepare"}else{"updates-coordinator"},
        "manual_driver":coordinator_enabled(),"production_listeners":prepare_enabled(),"syntheticChooser":prepare_enabled(),"noOSDialogClaim":true,
        "executed":probe.cases.len(),"scenarios":probe.cases,"side_effects":actual,
        "scope":if prepare_enabled(){"production renderer/native participant matrix; actual install/restart deferred to Plan17-06"}else{"native coordinator manual driver; renderer matrix separately Plan17-11"},
        "handoff":"synthetic native readiness channel; no installer launched"}));
}
fn coordinator_no_effects(app:&tauri::AppHandle)->Result<CoordinatorEffects,String>{
    let value=app.state::<Driver>().coordinator.lock().unwrap().effects.clone();
    if value.destroy!=0||value.exit!=0||value.install!=0||value.restart!=0||value.leaf_close!=0
        ||value.accepted_exit_requested!=0||value.exit_events!=0{return Err("coordinator_precommit_side_effect".into());}
    Ok(value)
}
fn coordinator_case(app:&tauri::AppHandle,name:&str,details:Value)->Result<(),String>{
    let effects=coordinator_no_effects(app)?;
    app.state::<Driver>().coordinator.lock().unwrap().cases.push(json!({"name":name,"pass":true,"details":details,"side_effects":effects}));Ok(())
}
async fn broker_snapshot(app:&tauri::AppHandle,label:&str)->Result<Value,String>{
    app.state::<crate::mcp::LeafMcpBroker>().bridge(app,label,"snapshot",json!({})).await
}
async fn coordinator_reply(app:&tauri::AppHandle,window:&tauri::WebviewWindow,case_id:&str,reply:&crate::update_coordinator::PrepareReply)->Result<Value,String>{
    invoke_report(app,window,case_id,"update_participant_reply",json!({"reply":reply})).await
}
fn ready_reply(challenge:&crate::update_coordinator::Challenge)->crate::update_coordinator::PrepareReply{
    crate::update_coordinator::PrepareReply{prepare_id:challenge.prepare_id.clone(),phase:challenge.phase,identity:challenge.identity.clone(),result:crate::update_coordinator::ReplyResult::Ready}
}
async fn coordinator_freeze(app:&tauri::AppHandle,id:&crate::update_coordinator::PrepareId)->Result<(),String>{
    let coordinator=app.state::<crate::update_coordinator::UpdateCoordinator>();
    let registry=app.state::<crate::update_admission::AdmissionRegistry>();
    // Core's manual renderer driver must wait for actual admitted settlement,
    // just as the production preparation loop does after admission is closed.
    let drain_error=|stage:&str,code:String|{
        let snapshot=registry.snapshot();
        format!("coordinator_freeze_{stage}:{code}:{}",json!({"active":snapshot.active,"state":format!("{:?}",snapshot.state),
            "participants":snapshot.participants.len(),"pending_participants":snapshot.participants.values().filter(|ready|!**ready).count(),"queued_opens":snapshot.queued_opens}))
    };
    registry.wait_idle(std::time::Duration::from_secs(10)).await.map_err(|code|drain_error("wait",code))?;
    crate::update_coordinator::drain_once(app,id).map_err(|code|drain_error("drain",code))?;
    for label in coordinator.labels(id)?{
        let identity=crate::update_coordinator::native_identity(app,&label).await?;
        coordinator.settle_identity(&label,id,identity)?;
        let challenge=coordinator.expect(&label,id,crate::update_coordinator::ReplyPhase::Frozen)?;
        let window=app.get_webview_window(&label).ok_or("coordinator_window_missing")?;
        let report=coordinator_reply(app,&window,&format!("freeze-{}-{label}",id.0),&ready_reply(&challenge)).await?;
        if report["ok"]!=true{return Err(format!("coordinator_freeze_rejected:{report}"));}
    }Ok(())
}
async fn coordinator_native_save(app:&tauri::AppHandle,id:&crate::update_coordinator::PrepareId,label:&str,target:Option<std::path::PathBuf>)->Result<crate::update_coordinator::PrepareReply,String>{
    let coordinator=app.state::<crate::update_coordinator::UpdateCoordinator>();
    let challenge=coordinator.expect(label,id,crate::update_coordinator::ReplyPhase::Saved)?;
    let window=app.get_webview_window(label).ok_or("coordinator_window_missing")?;
    let current=app.state::<crate::Documents>().0.lock().unwrap().get(label).cloned().flatten().ok_or("coordinator_document_path")?;
    let target=target.unwrap_or_else(||current.clone());
    let snapshot=app.state::<crate::mcp::LeafMcpBroker>().bridge(app,label,"snapshot",json!({})).await?;
    let content=snapshot["content"].as_str().ok_or("coordinator_content")?;
    let expected=if target==current{Some(std::fs::read_to_string(&current).map_err(|_|"coordinator_disk_read")?)}else{None};
    let report=invoke_report(app,&window,&format!("save-{}-{label}",id.0),"write_document",json!({
        "path":target,"content":content,"expected":expected,"resources":[],"prepareId":id,
        "saveBinding":{"session_id":challenge.identity.session_id,"document_id":challenge.identity.document_id,"revision":snapshot["revision"]}
    })).await?;
    if report["ok"]!=true{return Err(format!("coordinator_actual_save_failed:{report}"));}
    let identity=crate::update_coordinator::native_identity(app,label).await?;
    Ok(crate::update_coordinator::PrepareReply{identity,..ready_reply(&challenge)})
}
async fn coordinator_save_all(app:&tauri::AppHandle,id:&crate::update_coordinator::PrepareId)->Result<(),String>{
    let coordinator=app.state::<crate::update_coordinator::UpdateCoordinator>();
    for label in coordinator.labels(id)?{
        let reply=coordinator_native_save(app,id,&label,None).await?;
        let window=app.get_webview_window(&label).ok_or("coordinator_window_missing")?;
        if coordinator_reply(app,&window,&format!("saved-{}-{label}",id.0),&reply).await?["ok"]!=true{return Err("coordinator_saved_reply_failed".into());}
    }Ok(())
}
async fn coordinator_seal_all(app:&tauri::AppHandle,id:&crate::update_coordinator::PrepareId)->Result<(),String>{
    let coordinator=app.state::<crate::update_coordinator::UpdateCoordinator>();
    for label in coordinator.labels(id)?{
        let challenge=coordinator.expect(&label,id,crate::update_coordinator::ReplyPhase::Sealed)?;
        let window=app.get_webview_window(&label).ok_or("coordinator_window_missing")?;
        if coordinator_reply(app,&window,&format!("sealed-{}-{label}",id.0),&ready_reply(&challenge)).await?["ok"]!=true{return Err("coordinator_sealed_reply_failed".into());}
        coordinator.verify_saved_disk(id,&label)?;
    }Ok(())
}
async fn coordinator_smoke(app:tauri::AppHandle)->Result<(),String>{
    use crate::update_coordinator::{UpdateCoordinator,PrepareId,ReplyPhase,ReplyResult};
    use crate::update_admission::{AdmissionRegistry,AdmissionState,OpenRequest};
    let registry=app.state::<AdmissionRegistry>().inner().clone();
    let coordinator=app.state::<UpdateCoordinator>();let updates=app.state::<crate::updates::Updates>();
    let package=tauri::async_runtime::spawn_blocking(||crate::update_package::fixture_verify([73;16])).await.map_err(|_|"coordinator_package_worker")??;
    // The real native registry is empty here; even S=0 needs a current verified
    // package, live Intent and the same global seal/one-use permit protocol.
    let (empty,binding)=updates.test_prepare(&app,package.clone())?;
    crate::update_coordinator::drain_once(&app,&empty)?;
    let mut wrong=binding.clone();wrong.target.push('x');
    if coordinator.seal(&empty,&wrong,true).is_ok(){return Err("coordinator_empty_wrong_target".into());}
    let permit=coordinator.seal(&empty,&binding,true)?;
    if coordinator.commit(permit,&binding,false,||Ok(())).is_ok(){return Err("coordinator_empty_handoff_committed".into());}
    crate::update_coordinator::abort_and_release(&app,"fixture_handoff_not_ready");
    coordinator_case(&app,"empty_set_global_gate",json!({"participants":0,"verified_package":true,"live_intent":true,"wrong_target_denied":true,"helper_not_ready_aborted":true}))?;

    let (window,initial_path)=fixture_document(&app,"coordinator-first.md").await?;
    let (single,_)=updates.test_prepare(&app,package.clone())?;coordinator_freeze(&app,&single).await?;
    let challenge=coordinator.expect(window.label(),&single,ReplyPhase::Saved)?;
    let report=coordinator_reply(&app,&window,"saved-claim-without-io",&ready_reply(&challenge)).await?;
    if report["ok"]!=false||report["error"]!="update_native_save_missing"{return Err(format!("coordinator_saved_claim_admitted:{report}"));}
    crate::update_coordinator::abort_and_release(&app,"fixture_missing_native_save");
    coordinator_case(&app,"native_saved_ledger",json!({"participants":1,"actual_document_ipc":true,"saved_claim_without_native_write_denied":true}))?;

    // Real WebView DOM input changes the actual editor snapshot after the
    // pre-settle challenge. This is synthetic input, not native IME acceptance.
    let (id,_)=updates.test_prepare(&app,package.clone())?;crate::update_coordinator::drain_once(&app,&id)?;
    let original_snapshot=broker_snapshot(&app,window.label()).await?;
    let original_disk=std::fs::read(&initial_path).map_err(|_|"coordinator_settle_disk_read")?;
    let original_identity=crate::update_coordinator::native_identity(&app,window.label()).await?;
    coordinator.settle_identity(window.label(),&id,original_identity.clone())?;
    let challenge=coordinator.expect(window.label(),&id,ReplyPhase::Frozen)?;
    let original_text=original_snapshot["content"].as_str().ok_or("coordinator_original_text")?;
    let new_text=format!("{original_text}Settled synthetic native input\n");
    let input=role_report(&app,&window,"settle-real-dom-input",&format!(
        "const node=document.querySelector('.cm-content');if(!node||node.contentEditable!=='true')return {{inserted:false}};node.focus();const range=document.createRange();range.selectNodeContents(node);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);return {{inserted:document.execCommand('insertText',false,{})}};",json!(new_text))).await?;
    if input["inserted"]!=true{return Err("coordinator_actual_dom_input_failed".into());}
    let settled=crate::update_coordinator::native_identity(&app,window.label()).await?;
    if settled.revision<=original_identity.revision||settled.content_digest==original_identity.content_digest{return Err("coordinator_actual_settlement_did_not_change_snapshot".into());}
    if coordinator_reply(&app,&window,"old-pre-settle-reply",&ready_reply(&challenge)).await?["ok"]!=false{return Err("coordinator_old_settle_reply_advanced".into());}
    let reply=crate::update_coordinator::PrepareReply{identity:settled.clone(),..ready_reply(&challenge)};
    if coordinator_reply(&app,&window,"native-current-settled-reply",&reply).await?["ok"]!=true{return Err("coordinator_native_settle_reply_refused".into());}
    let status=invoke_report(&app,&window,"late-listener-native-status","update_participant_status",json!({})).await?;
    if status["ok"]!=true||status["value"]["prepare_id"]!=json!(id)||status["value"]["window_nonce"]!=settled.window_nonce
        ||status["value"]["identity"]["revision"]!=settled.revision{return Err("coordinator_authoritative_settle_status_wrong".into());}
    // Keep the actual edited fixture content. Later native saves read the live
    // renderer snapshot and the real on-disk expected baseline independently.
    // A second DOM replacement is unnecessary and can race editor settlement.
    let current=crate::update_coordinator::native_identity(&app,window.label()).await?;
    if current!=settled||std::fs::read(&initial_path).map_err(|_|"coordinator_settle_disk_read")?!=original_disk{
        return Err(format!("coordinator_settle_baseline_changed:{}",json!({"settled_revision":settled.revision,"current_revision":current.revision,"native_identity_unchanged":current==settled})));
    }
    crate::update_coordinator::abort_and_release(&app,"fixture_settled_snapshot_done");
    let retained=crate::update_coordinator::native_identity(&app,window.label()).await?;
    if retained.revision!=settled.revision||retained.content_digest!=settled.content_digest
        ||std::fs::read(&initial_path).map_err(|_|"coordinator_settle_disk_read")?!=original_disk{
        return Err(format!("coordinator_abort_lost_settled_buffer:{}",json!({"settled_revision":settled.revision,"retained_revision":retained.revision,"digest_retained":retained.content_digest==settled.content_digest})));
    }
    coordinator_case(&app,"native_settled_snapshot",json!({"actual_webview_dom_input":true,"actual_native_snapshot_revision_changed":true,
        "old_reply_rejected":true,"same_native_binding_required":true,"authoritative_status_after_missed_event":true,"live_synthetic_text_retained":true,"post_abort_buffer_retained":true,"disk_baseline_unchanged":true,"real_ime_acceptance":false}))?;

    let (other,_)=fixture_document(&app,"coordinator-second.md").await?;
    registry.wait_idle(std::time::Duration::from_secs(10)).await?;
    let updater=probe_window(&app,crate::updates::LABEL).await?;
    let export=probe_window(&app,"export-coordinator-probe").await?;
    let unknown=probe_window(&app,"coordinator-unknown").await?;
    let (id,_)=updates.test_prepare(&app,package.clone())?;crate::update_coordinator::drain_once(&app,&id)?;
    let labels=coordinator.labels(&id)?;let first=&labels[0];
    let target=app.get_webview_window(first).ok_or("coordinator_window_missing")?;
    let native=crate::update_coordinator::native_identity(&app,first).await?;
    coordinator.settle_identity(first,&id,native)?;
    let challenge=coordinator.expect(first,&id,ReplyPhase::Frozen)?;let original=ready_reply(&challenge);
    let mut rejected=0;
    for (index,wrong) in [updater.clone(),export,unknown].into_iter().enumerate(){
        let result=coordinator_reply(&app,&wrong,&format!("wrong-role-{index}"),&original).await?;
        if result["ok"]!=false||result["error"]!="window_role_denied"{return Err(format!("coordinator_wrong_role:{result}"));}rejected+=1;
    }
    let wrong_window=if other.label()!=first{other.clone()}else{window.clone()};
    if coordinator_reply(&app,&wrong_window,"wrong-real-window",&original).await?["ok"]!=false{return Err("coordinator_wrong_window_advanced".into());}rejected+=1;
    let mut variants=Vec::new();
    let mut value=original.clone();value.prepare_id=PrepareId("stale-transaction".into());variants.push(value);
    let mut value=original.clone();value.phase=ReplyPhase::Saved;variants.push(value);
    let mut value=original.clone();value.identity.window_nonce+=1;variants.push(value);
    let mut value=original.clone();value.identity.document_id.push('x');variants.push(value);
    let mut value=original.clone();value.identity.session_id.push('x');variants.push(value);
    let mut value=original.clone();value.identity.authorization_epoch+=1;variants.push(value);
    let mut value=original.clone();value.identity.revision+=1;variants.push(value);
    let mut value=original.clone();value.identity.content_digest.push('x');variants.push(value);
    let mut value=original.clone();value.identity.session_id.push('x');value.result=ReplyResult::Cancelled;variants.push(value);
    for (index,value) in variants.into_iter().enumerate(){
        if coordinator_reply(&app,&target,&format!("bad-identity-{index}"),&value).await?["ok"]!=false{return Err("coordinator_invalid_identity_advanced".into());}rejected+=1;
    }
    if coordinator_reply(&app,&target,"correct-after-invalid",&original).await?["ok"]!=true{return Err("coordinator_invalid_consumed_pending".into());}
    if coordinator_reply(&app,&target,"duplicate-frozen",&original).await?["ok"]!=false{return Err("coordinator_duplicate_advanced".into());}rejected+=1;
    crate::update_coordinator::abort_and_release(&app,"fixture_identity_done");
    if coordinator_reply(&app,&target,"late-frozen",&original).await?["ok"]!=false{return Err("coordinator_late_advanced".into());}rejected+=1;
    coordinator_case(&app,"actual_reply_identity_matrix",json!({"actual_tauri_ipc":true,"rejected":rejected,"correct_reply_after_invalid":true,"duplicate_and_late_denied":true,"negative_wrong_identity_did_not_cancel":true}))?;

    let (id,_)=updates.test_prepare(&app,package.clone())?;coordinator_freeze(&app,&id).await?;
    let labels=coordinator.labels(&id)?;let first=&labels[0];let second=&labels[1];
    let reply=coordinator_native_save(&app,&id,first,None).await?;
    let first_window=app.get_webview_window(first).ok_or("coordinator_window_missing")?;
    if coordinator_reply(&app,&first_window,"partial-saved",&reply).await?["ok"]!=true{return Err("coordinator_partial_save_reply".into());}
    let path=app.state::<crate::Documents>().0.lock().unwrap().get(first).cloned().flatten().ok_or("coordinator_document_path")?;
    let protected=std::fs::read(&path).map_err(|_|"coordinator_saved_read")?;
    let challenge=coordinator.expect(second,&id,ReplyPhase::Saved)?;let mut cancel=ready_reply(&challenge);cancel.result=ReplyResult::Cancelled;
    let second_window=app.get_webview_window(second).ok_or("coordinator_window_missing")?;
    if coordinator_reply(&app,&second_window,"second-cancelled",&cancel).await?["ok"]!=false{return Err("coordinator_cancel_not_applied".into());}
    if coordinator.labels(&id).is_ok()||std::fs::read(path).map_err(|_|"coordinator_saved_read")?!=protected
        ||app.get_webview_window(first).is_none()||app.get_webview_window(second).is_none(){return Err("coordinator_partial_cancel_lost_document".into());}
    let cancelled=updates.snapshot();
    if cancelled.state!=crate::updates::UpdateState::PrepareFailed||updates.preparation_live(cancelled.op_id,&package.candidate().opaque_id()){return Err("coordinator_cancel_kept_intent".into());}
    coordinator_case(&app,"partial_save_cancel",json!({"actual_native_write":true,"already_saved_bytes_preserved":true,"both_windows_retained":true,"cancel_invalidated_transaction":true}))?;

    let (id,_)=updates.test_prepare(&app,package.clone())?;coordinator_freeze(&app,&id).await?;
    let first=coordinator.labels(&id)?[0].clone();let challenge=coordinator.expect(&first,&id,ReplyPhase::Saved)?;
    let target=app.get_webview_window(&first).ok_or("coordinator_window_missing")?;
    let snapshot=app.state::<crate::mcp::LeafMcpBroker>().bridge(&app,&first,"snapshot",json!({})).await?;
    let path=app.state::<crate::Documents>().0.lock().unwrap().get(&first).cloned().flatten().ok_or("coordinator_document_path")?;
    let gate=GateControl::arm("write")?;let handle=app.clone();let owner=target.clone();let destination=path.clone();
    let request=tauri::async_runtime::spawn(async move{invoke_report(&handle,&owner,"abort-real-io","write_document",json!({
        "path":destination,"content":snapshot["content"],"expected":snapshot["content"],"resources":[],"prepareId":challenge.prepare_id,
        "saveBinding":{"session_id":challenge.identity.session_id,"document_id":challenge.identity.document_id,"revision":snapshot["revision"]}
    })).await});
    gate.started().await?;crate::update_coordinator::abort_and_release(&app,"fixture_abort_in_real_io");
    if registry.snapshot().state!=AdmissionState::AbortDraining||registry.snapshot().active==0{return Err("coordinator_abort_faked_io_completion".into());}
    gate.release();let result=request.await.map_err(|_|"coordinator_real_io_task")??;registry.wait_idle(std::time::Duration::from_secs(10)).await?;drop(gate);
    if result["ok"]!=true||coordinator.labels(&id).is_ok(){return Err("coordinator_real_io_abort_result".into());}
    coordinator_case(&app,"abort_draining_real_write",json!({"actual_atomic_write":true,"lease_retained_until_real_return":true,"late_result_did_not_ready":true,"saved_file_preserved":path.exists()}))?;

    let broker=app.state::<crate::mcp::LeafMcpBroker>().inner().clone();
    *broker.inner.enabled.lock().unwrap()=true;broker.inner.credentials.lock().unwrap().insert("coordinator-fixture".into(),"synthetic-memory-only".into());
    let credentials=broker.inner.credentials.lock().unwrap().clone();
    // Follow the actual automatic-access discovery path, which reconciles the
    // live renderer epoch before returning the current native authorization.
    // Manual authorization can immediately become stale after delayed renderer
    // settlement; never force its epoch or disable authorization checks.
    let discovered=broker.call(&app,"coordinator-fixture","list_documents",json!({})).await.map_err(|code|format!("coordinator_mcp_discover:{code}"))?;
    if discovered["documents"].as_array().is_none_or(|documents|!documents.iter().any(|d|d["label"]==window.label())){return Err("coordinator_mcp_document_not_discovered".into());}
    let binding=broker.window_binding(window.label()).ok_or("coordinator_binding")?;
    let arguments=json!({"document_id":binding.document_id,"session_id":binding.session_id,"authorization_epoch":binding.authorization_epoch});
    let snapshot=broker.call(&app,"coordinator-fixture","read_document",arguments.clone()).await.map_err(|code|format!("coordinator_mcp_read:{code}"))?;
    let mut begin=arguments.clone();begin["revision"]=snapshot["revision"].clone();begin["request_id"]=json!("coordinator-busy-task");
    let task=broker.call(&app,"coordinator-fixture","begin_edit",begin.clone()).await.map_err(|code|format!("coordinator_mcp_begin:{code}"))?;
    let (id,_)=updates.test_prepare(&app,package.clone())?;
    if crate::update_coordinator::drain_once(&app,&id).err().as_deref()!=Some("update_mcp_busy"){return Err("coordinator_ignored_broker_task".into());}
    if broker.call(&app,"coordinator-fixture","begin_edit",begin).await.is_ok(){return Err("coordinator_new_mcp_task_admitted".into());}
    let mut finish=arguments;finish["task_id"]=task["task_id"].clone();broker.call(&app,"coordinator-fixture","finish_edit",finish).await.map_err(|code|format!("coordinator_mcp_finish:{code}"))?;
    registry.wait_idle(std::time::Duration::from_secs(10)).await?;crate::update_coordinator::drain_once(&app,&id)?;
    crate::update_coordinator::abort_and_release(&app,"fixture_mcp_settled");
    if *broker.inner.credentials.lock().unwrap()!=credentials{return Err("coordinator_revoked_unrelated_credentials".into());}
    coordinator_case(&app,"mcp_busy_and_finish",json!({"real_broker_task":true,"registry_idle_is_insufficient":true,"new_begin_rejected":true,"existing_finish_allowed":true,"credentials_preserved":true}))?;

    let pending=crate::application_data(&app).map_err(|_|"coordinator_fixture_root")?.join("coordinator-pending.md");
    std::fs::write(&pending,"# Queued native coordinator\n").map_err(|_|"coordinator_fixture_write")?;
    let gate=GateControl::arm("open")?;let handle=app.clone();let source=pending.to_string_lossy().into_owned();
    let request=tauri::async_runtime::spawn_blocking(move||crate::open_document(handle,Some(source)));
    gate.started().await?;let (id,_)=updates.test_prepare(&app,package.clone())?;
    if !registry.snapshot().participants.values().any(|ready|!*ready)||crate::update_coordinator::drain_once(&app,&id).is_ok(){return Err("coordinator_pending_window_omitted".into());}
    crate::update_coordinator::abort_and_release(&app,"fixture_pending_abort");gate.release();
    if request.await.map_err(|_|"coordinator_pending_task")?.is_ok(){return Err("coordinator_stale_open_completed".into());}drop(gate);
    registry.wait_idle(std::time::Duration::from_secs(10)).await?;
    let (id,_)=updates.test_prepare(&app,package.clone())?;let before=app.state::<crate::Documents>().0.lock().unwrap().len();
    crate::dispatch_os_request(&app,OpenRequest::Document(pending.clone()))?;
    if registry.snapshot().queued_opens!=1||app.state::<crate::Documents>().0.lock().unwrap().len()!=before{return Err("coordinator_os_open_escaped".into());}
    crate::update_coordinator::abort_and_release(&app,"fixture_queue_abort");let _queued=document_ready(&app,&pending).await?;
    registry.wait_idle(std::time::Duration::from_secs(10)).await?;
    let (latest,_)=updates.test_prepare(&app,package.clone())?;
    if coordinator.labels(&latest)?.len()!=before+1{return Err("coordinator_latest_set_omitted_new_document".into());}
    crate::update_coordinator::abort_and_release(&app,"fixture_latest_set_done");
    coordinator_case(&app,"pending_and_queued_open",json!({"actual_open_paused_before_creation":true,"pending_in_snapshot":true,"stale_open_denied":true,"actual_os_open_queued_then_restored":true,"latest_set_captured_after_open":true}))?;

    let (id,_)=updates.test_prepare(&app,package.clone())?;
    if coordinator.deadline_check(&id,std::time::Instant::now()+std::time::Duration::from_secs(31)).is_ok(){return Err("coordinator_drain_unbounded".into());}
    crate::update_coordinator::abort_and_release(&app,"update_drain_timeout");
    let (lost,_)=updates.test_prepare(&app,package.clone())?;
    let (id,labels)=coordinator.participant_lost(window.label()).ok_or("coordinator_loss_not_detected")?;
    crate::update_coordinator::release(&app,&id,labels,"update_prepare_disconnected");
    if coordinator.labels(&lost).is_ok()||app.get_webview_window(other.label()).is_none(){return Err("coordinator_loss_closed_survivor".into());}
    coordinator_case(&app,"timeout_and_participant_loss",json!({"production_monotonic_deadline_injected":true,"native_loss_callback_signal":true,"surviving_windows_retained":true,"no_process_crash_claim":true}))?;

    let (id,_)=updates.test_prepare(&app,package.clone())?;
    let nonce=registry.snapshot().instances[window.label()];window.close().map_err(|_|"coordinator_close_request")?;
    changed_until(&app,"coordinator_native_close",||coordinator.close_action(window.label(),nonce).is_some()).await?;
    let action=coordinator.close_action(window.label(),nonce).ok_or("coordinator_close_action_missing")?;
    if action.allowed||coordinator.labels(&id).is_ok(){return Err("coordinator_close_did_not_cancel_prepare".into());}
    let legacy=invoke_report(&app,&window,"legacy-close-suppressed","mcp_document_boundary",json!({"reason":"close"})).await?;
    if legacy["ok"]!=false||legacy["error"]!="update_prepare_cancelled"||coordinator.close_action(window.label(),nonce).is_none(){return Err(format!("coordinator_legacy_consumed_suppression:{legacy}"));}
    let wrong=invoke_report(&app,&window,"wrong-close-completion","update_close_complete",json!({"actionId":action.action_id+1,"windowNonce":nonce})).await?;
    if wrong["ok"]!=false{return Err("coordinator_wrong_close_completion".into());}
    let complete=invoke_report(&app,&window,"exact-close-completion","update_close_complete",json!({"actionId":action.action_id,"windowNonce":nonce})).await?;
    if complete["ok"]!=true{return Err("coordinator_close_completion_failed".into());}
    let duplicate=invoke_report(&app,&window,"duplicate-close-completion","update_close_complete",json!({"actionId":action.action_id,"windowNonce":nonce})).await?;
    if duplicate["ok"]!=false||app.get_webview_window(window.label()).is_none(){return Err("coordinator_duplicate_close_or_window_lost".into());}
    let late=invoke_report(&app,&window,"late-legacy-after-completion","mcp_document_boundary",json!({"reason":"close"})).await?;
    if late["ok"]!=false||late["error"]!="update_prepare_cancelled"{return Err("coordinator_late_legacy_regained_authority".into());}
    let next=invoke_report(&app,&window,"next-explicit-close","update_close_disposition",json!({})).await?;
    let next_id=next["value"]["action_id"].as_u64().ok_or("coordinator_next_action_id")?;
    if next["ok"]!=true||next["value"]["allowed"]!=true||next_id<=action.action_id{return Err("coordinator_explicit_close_fenced".into());}
    let boundary=invoke_report(&app,&window,"exact-next-boundary","mcp_document_boundary",json!({"reason":"close","closeActionId":next_id})).await?;
    if boundary["ok"]!=true{return Err(format!("coordinator_exact_boundary_refused:{boundary}"));}
    let ended=invoke_report(&app,&window,"complete-next-explicit","update_close_complete",json!({"actionId":next_id,"windowNonce":nonce})).await?;
    if ended["ok"]!=true{return Err("coordinator_exact_next_completion_failed".into());}
    coordinator_case(&app,"native_close_same_action",json!({"actual_close_requested":true,"legacy_boundary_rejected_before_hooks":true,"no_id_did_not_consume_token":true,"late_no_id_still_fenced":true,"new_exact_id_usable":true,"wrong_duplicate_completion_denied":true,"window_retained":true}))?;

    let (id,_)=updates.test_prepare(&app,package.clone())?;crate::request_ordinary_quit(&app);
    if coordinator.labels(&id).is_ok(){return Err("coordinator_quit_did_not_cancel_prepare".into());}
    let (decision,_)=coordinator.begin_quit(&registry)?;
    if decision!=crate::update_admission::CloseDecision::Allowed||updates.test_prepare(&app,package.clone()).is_ok(){return Err("coordinator_prepare_slipped_into_quit".into());}
    coordinator.cancel_quit(None);
    coordinator_case(&app,"ordinary_quit_competition",json!({"actual_request_ordinary_quit_cancelled_prepare":true,"separate_native_quit_claim_blocks_new_begin":true,"no_leaf_close_broadcast_on_prepare_cancel":true}))?;

    // An actual native Save As may change authorization epoch; only its actual
    // successful write can approve the new identity. The old reply is refused.
    let first_label=registry.snapshot().participants.keys().next().cloned().ok_or("coordinator_document_missing")?;
    let discovered=broker.call(&app,"coordinator-fixture","list_documents",json!({})).await.map_err(|code|format!("coordinator_save_as_discover:{code}"))?;
    if discovered["documents"].as_array().is_none_or(|documents|!documents.iter().any(|d|d["label"]==first_label)){return Err("coordinator_save_as_document_not_discovered".into());}
    let (id,_)=updates.test_prepare(&app,package.clone())?;coordinator_freeze(&app,&id).await?;
    let labels=coordinator.labels(&id)?;let first=&labels[0];
    let old=crate::update_coordinator::native_identity(&app,first).await?;
    let target=crate::application_data(&app).map_err(|_|"coordinator_fixture_root")?.join("coordinator-rebound.md");
    let reply=coordinator_native_save(&app,&id,first,Some(target)).await?;
    let owner=app.get_webview_window(first).ok_or("coordinator_window_missing")?;
    if reply.identity==old{return Err("coordinator_save_as_did_not_rebind_native_epoch".into());}
    let stale=crate::update_coordinator::PrepareReply{identity:old,..reply.clone()};
    if coordinator_reply(&app,&owner,"old-save-as-identity",&stale).await?["ok"]!=false{return Err("coordinator_old_save_as_reply_admitted".into());}
    if coordinator_reply(&app,&owner,"native-save-as-identity",&reply).await?["ok"]!=true{return Err("coordinator_native_save_as_reply_rejected".into());}
    crate::update_coordinator::abort_and_release(&app,"fixture_save_as_done");
    coordinator_case(&app,"native_save_as_rebind",json!({"actual_native_save_as":true,"native_epoch_changed":true,"old_identity_rejected":true,"native_success_required":true}))?;

    let (id,binding)=updates.test_prepare(&app,package.clone())?;coordinator_freeze(&app,&id).await?;coordinator_save_all(&app,&id).await?;coordinator_seal_all(&app,&id).await?;
    let permit=coordinator.seal(&id,&binding,true)?;
    if updates.commit_preparation(&app,binding.op_id,&binding.candidate,&binding,permit,false).is_ok(){return Err("coordinator_helper_failure_committed".into());}
    crate::update_coordinator::abort_and_release(&app,"fixture_helper_failed");
    let (new,_)=updates.test_prepare(&app,package.clone())?;
    if new==id||coordinator.seal(&id,&binding,true).is_ok(){return Err("coordinator_old_permit_authority_survived".into());}
    crate::update_coordinator::abort_and_release(&app,"fixture_retry_done");
    coordinator_case(&app,"handoff_failure_and_stale_permit",json!({"all_native_files_saved":true,"helper_ready_failure_aborted":true,"new_transaction_identity":true,"stale_seal_denied":true}))?;

    let (id,binding)=updates.test_prepare(&app,package.clone())?;coordinator_freeze(&app,&id).await?;coordinator_save_all(&app,&id).await?;coordinator_seal_all(&app,&id).await?;
    package.revalidate(&||updates.preparation_live(binding.op_id,&binding.candidate))?;
    let permit=coordinator.seal(&id,&binding,true)?;
    let (ready_tx,ready_rx)=tokio::sync::oneshot::channel();ready_tx.send(()).map_err(|_|"coordinator_ready_channel")?;ready_rx.await.map_err(|_|"coordinator_ready_channel")?;
    updates.commit_preparation(&app,binding.op_id,&binding.candidate,&binding,permit,true)?;
    if !package.consumed()||coordinator.seal(&id,&binding,true).is_ok()||!coordinator.committed(){return Err("coordinator_commit_or_replay_invalid".into());}
    coordinator_case(&app,"one_commit_real_exit",json!({"permit_consumptions":1,"verified_package_consumed":true,"live_intent_required":true,
        "duplicate_seal_denied":true,"synthetic_native_ready_channel":true,"actual_run_event_exit":false,"installer_invocations":0,"restart_invocations":0}))?;
    {let driver=app.state::<Driver>();let mut probe=driver.coordinator.lock().unwrap();probe.final_pending=true;probe.effects.exit+=1;}
    // This real app.exit must pass the production one-use UpdateCommit gate.
    // The final report is emitted only from the real RunEvent::Exit callback.
    app.exit(0);Ok(())
}

fn skipped_release()->&'static Mutex<Option<String>>{static LABEL:std::sync::OnceLock<Mutex<Option<String>>>=std::sync::OnceLock::new();LABEL.get_or_init(||Mutex::new(None))}
pub fn prepare_skip_release(label:&str)->bool{prepare_enabled()&&skipped_release().lock().unwrap().as_deref()==Some(label)}
#[derive(Default)]
struct BufferTrace{label:String,rows:Vec<Value>}
fn buffer_trace()->&'static Mutex<Option<BufferTrace>>{static TRACE:std::sync::OnceLock<Mutex<Option<BufferTrace>>>=std::sync::OnceLock::new();TRACE.get_or_init(||Mutex::new(None))}
pub fn prepare_renderer_ready(app:&tauri::AppHandle,label:&str){
    if prepare_enabled(){*app.state::<Driver>().prepare_ready.lock().unwrap().entry(label.into()).or_default()+=1;notify_change(app);}
}
pub fn prepare_enabled()->bool{std::env::args().any(|arg|arg=="--update-prepare-smoke")}
pub fn transaction_enabled()->bool{coordinator_enabled()||prepare_enabled()}
#[tauri::command]
pub fn update_test_prepare_mode(app:tauri::AppHandle,window:tauri::WebviewWindow)->bool{
    (prepare_enabled()||preservation_enabled())&&crate::verified_window_role(&app,window.label())==crate::WindowRole::Document
}
struct SelectPlan {label:String,target:Option<String>,held:bool,owner:Mutex<Option<crate::update_coordinator::PrepareId>>,started:Mutex<bool>,arrived:tokio::sync::Notify,released:tokio::sync::Notify,open:std::sync::atomic::AtomicBool}
fn select_plan()->&'static Mutex<Option<Arc<SelectPlan>>>{static PLAN:std::sync::OnceLock<Mutex<Option<Arc<SelectPlan>>>>=std::sync::OnceLock::new();PLAN.get_or_init(||Mutex::new(None))}
struct SelectorControl(Arc<SelectPlan>);
impl SelectorControl{
    fn arm(label:&str,target:Option<String>,held:bool)->Result<Self,String>{
        let mut slot=select_plan().lock().unwrap();if slot.is_some(){return Err("prepare_selector_already_armed".into());}
        let plan=Arc::new(SelectPlan{label:label.into(),target,held,owner:Mutex::new(None),started:Mutex::new(false),arrived:tokio::sync::Notify::new(),released:tokio::sync::Notify::new(),open:std::sync::atomic::AtomicBool::new(!held)});
        *slot=Some(plan.clone());Ok(Self(plan))
    }
    async fn started(&self)->Result<(),String>{
        tokio::time::timeout(std::time::Duration::from_secs(15),async{loop{
            let changed=self.0.arrived.notified();tokio::pin!(changed);changed.as_mut().enable();
            if *self.0.started.lock().unwrap(){return;}changed.await;
        }}).await.map_err(|_|"prepare_selector_not_reached".into())
    }
    fn release(&self){self.0.open.store(true,std::sync::atomic::Ordering::SeqCst);self.0.released.notify_waiters();}
}
impl Drop for SelectorControl{fn drop(&mut self){self.release();let mut slot=select_plan().lock().unwrap();if slot.as_ref().is_some_and(|p|Arc::ptr_eq(p,&self.0)){*slot=None;}}}
#[tauri::command]
pub async fn update_test_prepare_select(app:tauri::AppHandle,window:tauri::WebviewWindow,prepare_id:crate::update_coordinator::PrepareId)->Result<Option<String>,String>{
    if !update_test_prepare_mode(app.clone(),window.clone()){return Err("test_disabled".into());}
    let coordinator=app.state::<crate::update_coordinator::UpdateCoordinator>();
    coordinator.validate_declared_save(window.label(),Some(&prepare_id))?;
    let nonce=app.state::<crate::update_admission::AdmissionRegistry>().snapshot().instances.get(window.label()).copied().ok_or("prepare_selector_instance")?;
    let status=coordinator.status(window.label(),nonce);
    if status.prepare_id.as_ref()!=Some(&prepare_id)||status.phase!=Some(crate::update_coordinator::ReplyPhase::Saved){return Err("update_prepare_stale".into());}
    let plan=select_plan().lock().unwrap().clone().filter(|p|{
        if p.label!=window.label(){return false;}
        let mut owner=p.owner.lock().unwrap();
        match owner.as_ref(){
            Some(owner)=>owner==&prepare_id,
            None=>{*owner=Some(prepare_id.clone());true},
        }
    });
    let Some(plan)=plan else{
        let path=crate::application_data(&app).map_err(|_|"prepare_selector_root")?.join(format!("prepare-selected-{}.md",window.label()));
        return Ok(Some(path.to_string_lossy().into_owned()));
    };
    *plan.started.lock().unwrap()=true;plan.arrived.notify_waiters();
    if plan.held{tokio::time::timeout(std::time::Duration::from_secs(20),async{loop{
        let changed=plan.released.notified();tokio::pin!(changed);changed.as_mut().enable();
        if plan.open.load(std::sync::atomic::Ordering::SeqCst){return;}changed.await;
    }}).await.map_err(|_|"prepare_selector_timeout")?;}
    // This boundary returns a synthetic selector result, never authority to
    // write. The production session and native I/O recheck declared generation.
    Ok(plan.target.clone())
}
struct PhasePlan {label:String,phase:crate::update_coordinator::ReplyPhase,challenge:Mutex<Option<crate::update_coordinator::Challenge>>,arrived:tokio::sync::Notify,released:tokio::sync::Notify,open:std::sync::atomic::AtomicBool}
fn phase_plan()->&'static Mutex<Option<Arc<PhasePlan>>>{static PLAN:std::sync::OnceLock<Mutex<Option<Arc<PhasePlan>>>>=std::sync::OnceLock::new();PLAN.get_or_init(||Mutex::new(None))}
struct PhaseControl(Arc<PhasePlan>);
impl PhaseControl{
    fn arm(label:&str,phase:crate::update_coordinator::ReplyPhase)->Result<Self,String>{
        let mut slot=phase_plan().lock().unwrap();if slot.is_some(){return Err("prepare_phase_already_armed".into());}
        let plan=Arc::new(PhasePlan{label:label.into(),phase,challenge:Mutex::new(None),arrived:tokio::sync::Notify::new(),released:tokio::sync::Notify::new(),open:std::sync::atomic::AtomicBool::new(false)});
        *slot=Some(plan.clone());Ok(Self(plan))
    }
    async fn started(&self)->Result<crate::update_coordinator::Challenge,String>{
        tokio::time::timeout(std::time::Duration::from_secs(15),async{loop{
            let changed=self.0.arrived.notified();tokio::pin!(changed);changed.as_mut().enable();
            if let Some(value)=self.0.challenge.lock().unwrap().clone(){return value;}changed.await;
        }}).await.map_err(|_|"prepare_phase_not_reached".into())
    }
    fn release(&self){self.0.open.store(true,std::sync::atomic::Ordering::SeqCst);self.0.released.notify_waiters();}
}
impl Drop for PhaseControl{fn drop(&mut self){self.release();let mut slot=phase_plan().lock().unwrap();if slot.as_ref().is_some_and(|p|Arc::ptr_eq(p,&self.0)){*slot=None;}}}
pub async fn prepare_phase(_app:&tauri::AppHandle,label:&str,challenge:&crate::update_coordinator::Challenge)->Result<(),String>{
    if !prepare_enabled(){return Ok(());}
    let plan=phase_plan().lock().unwrap().clone().filter(|p|p.label==label&&p.phase==challenge.phase);
    if let Some(plan)=plan{
        *plan.challenge.lock().unwrap()=Some(challenge.clone());plan.arrived.notify_waiters();
        tokio::time::timeout(std::time::Duration::from_secs(20),async{loop{
            let changed=plan.released.notified();tokio::pin!(changed);changed.as_mut().enable();
            if plan.open.load(std::sync::atomic::Ordering::SeqCst){return;}changed.await;
        }}).await.map_err(|_|"prepare_phase_gate_timeout")?;
    }Ok(())
}

pub async fn prepare_status_gate(label:&str,phase:Option<crate::update_coordinator::ReplyPhase>)->Result<(),String>{
    if !prepare_enabled(){return Ok(());}
    let plan=phase_plan().lock().unwrap().clone().filter(|p|p.label==label&&Some(p.phase)==phase);
    if let Some(plan)=plan{
        tokio::time::timeout(std::time::Duration::from_secs(20),async{loop{
            let changed=plan.released.notified();tokio::pin!(changed);changed.as_mut().enable();
            if plan.open.load(std::sync::atomic::Ordering::SeqCst){return;}changed.await;
        }}).await.map_err(|_|"prepare_status_gate_timeout")?;
    }Ok(())
}
struct CrossPreparation{
    app:tauri::AppHandle,id:crate::update_coordinator::PrepareId,binding:crate::update_coordinator::PackageBinding,
    task:Option<tauri::async_runtime::JoinHandle<Result<crate::update_coordinator::CommitPermit,String>>>,
}
impl CrossPreparation{
    async fn result(&mut self)->Result<crate::update_coordinator::CommitPermit,String>{
        self.task.take().ok_or("prepare_task_already_taken")?.await.map_err(|_|"prepare_task_failed")?
    }
}
impl Drop for CrossPreparation{fn drop(&mut self){
    let labels=self.app.state::<crate::update_coordinator::UpdateCoordinator>().abort(&self.id);
    crate::update_coordinator::release(&self.app,&self.id,labels,"fixture_prepare_finished");
}}
async fn cross_begin(app:&tauri::AppHandle,package:Arc<crate::update_package::VerifiedPackage>,staged:bool)->Result<CrossPreparation,String>{
    let updates=app.state::<crate::updates::Updates>();let coordinator=app.state::<crate::update_coordinator::UpdateCoordinator>();
    if !coordinator.renderer_supported(&app.state::<crate::update_admission::AdmissionRegistry>()){return Err("prepare_listener_handshake_missing".into());}
    if !staged{updates.test_stage_download(package.clone())?;}
    updates.test_finish_staged_download()?;
    let snapshot=updates.snapshot();let candidate=snapshot.candidate_id.ok_or("prepare_candidate_missing")?;
    let (_,binding)=updates.preparation_authority(app,snapshot.op_id,&candidate)?;
    package.revalidate(&||updates.preparation_live(snapshot.op_id,&candidate))?;
    let id=updates.begin_preparation(app,snapshot.op_id,&candidate,&binding)?;
    crate::update_coordinator::announce_begin(app,&id)?;
    let handle=app.clone();let owner=id.clone();let target=binding.clone();let op=snapshot.op_id;
    let task=tauri::async_runtime::spawn(async move{crate::update_coordinator::run_preparation(&handle,&owner,&target,package,op,&candidate).await});
    Ok(CrossPreparation{app:app.clone(),id,binding,task:Some(task)})
}
async fn prepare_bridge(app:&tauri::AppHandle,window:&tauri::WebviewWindow,args:Value)->Result<Value,String>{
    app.state::<crate::mcp::LeafMcpBroker>().bridge(app,window.label(),"test",args).await
}
async fn prepare_state(app:&tauri::AppHandle,window:&tauri::WebviewWindow,command:&str)->Result<Value,String>{
    prepare_bridge(app,window,json!({"action":"update-prepare","command":command})).await
}
pub(crate) async fn prepare_edit(app:&tauri::AppHandle,window:&tauri::WebviewWindow,content:&str)->Result<(),String>{
    let changed=prepare_bridge(app,window,json!({"action":"human","content":content})).await?;
    if changed["content"]!=content{return Err("prepare_actual_edit_failed".into());}
    prepare_bridge(app,window,json!({"action":"pause-auto-timer"})).await?;Ok(())
}
async fn prepare_released(app:&tauri::AppHandle)->Result<(),String>{
    app.state::<crate::update_admission::AdmissionRegistry>().wait_idle(std::time::Duration::from_secs(10)).await?;
    let labels=app.state::<crate::Documents>().0.lock().unwrap().keys().cloned().collect::<Vec<_>>();
    for label in labels{
        let window=app.get_webview_window(&label).ok_or("prepare_window_lost")?;
        let state=prepare_state(app,&window,"settle-released").await?;
        if let Some(trace)=buffer_trace().lock().unwrap().as_mut(){if trace.label==label{trace.rows.push(json!({"stage":"released_probe","renderer_trace":state["trace"]}));}}
        if state["preparing"]!=false||state["manual_driver"]!=false{return Err(format!("prepare_renderer_not_released:{state}"));}
        prepare_bridge(app,&window,json!({"action":"pause-auto-timer"})).await?;
    }Ok(())
}
async fn prepare_untitled(app:&tauri::AppHandle,content:&str)->Result<tauri::WebviewWindow,String>{
    let before=app.state::<crate::Documents>().0.lock().unwrap().keys().cloned().collect::<Vec<_>>();
    let handle=app.clone();let recovered=content.to_owned();
    tauri::async_runtime::spawn_blocking(move||crate::create_document(handle,None,Some(recovered),None)).await.map_err(|_|"prepare_untitled_task")??;
    let label=app.state::<crate::Documents>().0.lock().unwrap().keys().find(|label|!before.contains(label)).cloned().ok_or("prepare_untitled_absent")?;
    changed_until(app,"untitled_ready",||app.state::<crate::update_admission::AdmissionRegistry>().snapshot().participants.get(&label)==Some(&true)
        &&app.state::<crate::mcp::LeafMcpBroker>().window_binding(&label).is_some()).await?;
    let window=app.get_webview_window(&label).ok_or("prepare_untitled_window")?;
    let state=prepare_state(app,&window,"reconcile").await?;
    if state["manual_driver"]!=false{return Err("prepare_manual_driver_not_allowed".into());}
    let actual=broker_snapshot(app,window.label()).await?;
    if actual["content"]!=content{return Err(format!("prepare_untitled_fixture_content_missing:{}",json!({"initial_draft_matches":false,"native_path_none":app.state::<crate::Documents>().0.lock().unwrap().get(window.label())==Some(&None)})));}
    prepare_bridge(app,&window,json!({"action":"pause-auto-timer"})).await?;Ok(window)
}
fn require_abort(result:Result<crate::update_coordinator::CommitPermit,String>,case:&str)->Result<String,String>{
    match result{Ok(_)=>Err(format!("prepare_failure_sealed:{case}")),Err(code)=>Ok(code)}
}
async fn prepare_all_disk_matches(app:&tauri::AppHandle)->Result<(),String>{
    let docs=app.state::<crate::Documents>().0.lock().unwrap().clone();
    for(label,path)in docs{
        let path=path.ok_or("prepare_saved_path_missing")?;
        let snapshot=broker_snapshot(app,&label).await?;
        if std::fs::read_to_string(path).map_err(|_|"prepare_saved_disk_read")?!=snapshot["content"].as_str().ok_or("prepare_saved_content")?{
            return Err("prepare_disk_not_latest_buffer".into());
        }
    }Ok(())
}
pub async fn prepare_handoff(app:&tauri::AppHandle,op:u64,candidate:&str,binding:&crate::update_coordinator::PackageBinding,permit:crate::update_coordinator::CommitPermit)->Result<(),String>{
    if !prepare_enabled(){return Err("test_disabled".into());}
    if app.state::<Driver>().coordinator.lock().unwrap().cases.len()!=20{return Err("prepare_final_case_count".into());}
    prepare_all_disk_matches(app).await?;
    let (ready_tx,ready_rx)=tokio::sync::oneshot::channel();ready_tx.send(()).map_err(|_|"prepare_ready_channel")?;ready_rx.await.map_err(|_|"prepare_ready_channel")?;
    let(package,live_binding)=app.state::<crate::updates::Updates>().preparation_authority(app,op,candidate)?;
    if &live_binding!=binding{return Err("prepare_commit_live_binding_changed".into());}
    app.state::<crate::updates::Updates>().commit_preparation(app,op,candidate,binding,permit,true)?;
    let verified_package_consumed=package.consumed();
    let coordinator=app.state::<crate::update_coordinator::UpdateCoordinator>();
    if !verified_package_consumed||!coordinator.committed()||coordinator.seal(&crate::update_coordinator::PrepareId("stale".into()),binding,true).is_ok(){return Err("prepare_commit_replay".into());}
    coordinator_case(app,"one_confirmed_commit_real_exit",json!({"actual_updater_confirmation":true,"production_prepare_loop":true,"production_participant_listeners":true,
        "permit_consumptions":1,"verified_package_consumed":verified_package_consumed,"live_intent_required":true,
        "synthetic_native_ready_channel":true,"actual_run_event_exit":false,"installer_invocations":0,"restart_invocations":0}))?;
    {let driver=app.state::<Driver>();let mut probe=driver.coordinator.lock().unwrap();probe.final_pending=true;probe.effects.exit+=1;}
    notify_change(app);app.exit(0);Ok(())
}
async fn prepare_smoke(app:tauri::AppHandle)->Result<(),String>{
    use crate::update_coordinator::{UpdateCoordinator,ReplyPhase,PrepareId};
    use crate::update_admission::{AdmissionRegistry,AdmissionState,OpenRequest};
    let package=crate::update_package::fixture_verify([73;16])?;
    let coordinator=app.state::<UpdateCoordinator>();let updates=app.state::<crate::updates::Updates>();
    let registry=app.state::<AdmissionRegistry>().inner().clone();
    let (first,first_path)=fixture_document(&app,"prepare-first.md").await?;
    let (second,second_path)=fixture_document(&app,"prepare-second.md").await?;
    prepare_state(&app,&first,"reconcile").await?;prepare_state(&app,&second,"reconcile").await?;
    let untouched_second=broker_snapshot(&app,second.label()).await?;
    prepare_edit(&app,&first,"# Latest synthetic first\n").await?;
    if broker_snapshot(&app,second.label()).await?["content"]!=untouched_second["content"]{return Err("prepare_cross_window_first_edit_changed_second".into());}
    prepare_edit(&app,&second,"# Latest synthetic second\n").await?;
    if broker_snapshot(&app,first.label()).await?["content"]!="# Latest synthetic first\n"{return Err("prepare_cross_window_second_edit_changed_first".into());}
    let mut flight=cross_begin(&app,package.clone(),false).await?;
    let permit=flight.result().await?;prepare_all_disk_matches(&app).await?;drop(permit);drop(flight);prepare_released(&app).await?;
    coordinator_case(&app,"two_dirty_latest_saved",json!({"documents":2,"latest_native_disk_matches":true,"automatic_participant":true,"actual_cross_window_edit_isolation":true}))?;

    let untitled=prepare_untitled(&app,"# Unsaved synthetic latest\n").await?;
    *buffer_trace().lock().unwrap()=Some(BufferTrace{label:untitled.label().into(),rows:Vec::new()});
    prepare_edit(&app,&first,"# First saved before another cancellation\n").await?;
    if broker_snapshot(&app,untitled.label()).await?["content"]!="# Unsaved synthetic latest\n"{return Err("prepare_cross_window_first_edit_changed_untitled".into());}
    let selector=SelectorControl::arm(untitled.label(),None,false)?;
    let mut flight=cross_begin(&app,package.clone(),false).await?;
    let abort_code=require_abort(flight.result().await,"untitled_cancel")?;
    let selector_reached=*selector.0.started.lock().unwrap();
    drop(flight);drop(selector);prepare_released(&app).await?;
    let first_disk_latest=std::fs::read_to_string(&first_path).map_err(|_|"prepare_partial_disk")?=="# First saved before another cancellation\n";
    let untitled_native_path_none=app.state::<crate::Documents>().0.lock().unwrap().get(untitled.label())==Some(&None);
    let after_snapshot=broker_snapshot(&app,untitled.label()).await?;
    let after_content=after_snapshot["content"].as_str().ok_or("prepare_partial_content")?;
    let untitled_buffer_latest=after_content=="# Unsaved synthetic latest\n";
    let trace=buffer_trace().lock().unwrap().take().ok_or("prepare_buffer_trace_missing")?.rows;
    if !first_disk_latest||!untitled_native_path_none||!untitled_buffer_latest||!selector_reached{
        return Err(format!("prepare_partial_cancel_lost_buffer:{}",json!({"first_disk_latest":first_disk_latest,"untitled_native_path_none":untitled_native_path_none,
            "untitled_buffer_latest":untitled_buffer_latest,"selector_reached":selector_reached,"abort_code":abort_code,"buffer_trace":trace,
            "after_model":after_content.chars().take(512).collect::<String>(),"after_model_utf8_bytes":after_content.len(),"after_model_digest":crate::mcp::source_digest(after_content),"after_revision":after_snapshot["revision"]})));
    }
    coordinator_case(&app,"partial_save_untitled_cancel",json!({"first_saved":true,"untitled_still_dirty":true,"all_windows_retained":true,"synthetic_selector_cancel":true}))?;

    // Real filesystem failures in the checkpoint store and native save target.
    let root=crate::application_data(&app).map_err(|_|"prepare_fixture_root")?;
    let recovery=root.join("recovery-v1");let backup=root.join("recovery-fixture-backup");
    registry.wait_idle(std::time::Duration::from_secs(10)).await?;
    std::fs::rename(&recovery,&backup).map_err(|_|"prepare_checkpoint_fixture_move")?;
    std::fs::write(&recovery,b"synthetic file blocks checkpoint directory").map_err(|_|"prepare_checkpoint_fixture_block")?;
    prepare_edit(&app,&first,"# Checkpoint failure keeps latest\n").await?;
    let checkpoint_result=async{let mut flight=cross_begin(&app,package.clone(),false).await?;let error=require_abort(flight.result().await,"checkpoint")?;drop(flight);Ok::<_,String>(error)}.await;
    std::fs::remove_file(&recovery).map_err(|_|"prepare_checkpoint_fixture_remove")?;
    std::fs::rename(&backup,&recovery).map_err(|_|"prepare_checkpoint_fixture_restore")?;
    let error=checkpoint_result?;prepare_released(&app).await?;
    if broker_snapshot(&app,first.label()).await?["content"]!="# Checkpoint failure keeps latest\n"{return Err("prepare_checkpoint_lost_buffer".into());}
    coordinator_case(&app,"actual_checkpoint_failure",json!({"actual_filesystem_directory_collision":true,"error":error,"latest_buffer_retained":true}))?;

    let original=std::fs::metadata(&first_path).map_err(|_|"prepare_save_permissions")?.permissions();let mut readonly=original.clone();readonly.set_readonly(true);
    std::fs::set_permissions(&first_path,readonly).map_err(|_|"prepare_save_readonly")?;
    let write_result=async{let mut flight=cross_begin(&app,package.clone(),false).await?;let error=require_abort(flight.result().await,"save")?;drop(flight);Ok::<_,String>(error)}.await;
    std::fs::set_permissions(&first_path,original).map_err(|_|"prepare_save_permissions_restore")?;
    let error=write_result?;prepare_released(&app).await?;
    coordinator_case(&app,"actual_save_failure",json!({"actual_readonly_file":true,"error":error,"windows_retained":true}))?;

    // A real checkpoint is already admitted. Concurrent stale/no-ID commands
    // must be rejected before entering that participant's borrowed SaveScope.
    let phase=PhaseControl::arm(first.label(),ReplyPhase::Saved)?;
    let mut flight=cross_begin(&app,package.clone(),false).await?;phase.started().await?;
    let io=GateControl::arm("recovery")?;phase.release();io.started().await?;
    let stale=PrepareId("prior-fixture-generation".into());let before=std::fs::read(&first_path).map_err(|_|"prepare_generation_disk")?;
    for (index,declared) in [Value::Null,json!(stale)].into_iter().enumerate(){
        let result=invoke_report(&app,&first,&format!("prepare-generation-{index}"),"recovery_checkpoint",json!({"content":"forbidden stale callback","preserve":false,"prepareId":declared})).await?;
        if result["ok"]!=false||result["error"]!="update_prepare_stale"{return Err(format!("prepare_generation_admitted:{result}"));}
    }
    if std::fs::read(&first_path).map_err(|_|"prepare_generation_disk")?!=before{return Err("prepare_stale_generation_changed_disk".into());}
    crate::update_coordinator::abort_and_release(&app,"fixture_generation_abort");io.release();require_abort(flight.result().await,"generation")?;drop(flight);drop(io);drop(phase);prepare_released(&app).await?;
    let late=invoke_report(&app,&first,"prepare-generation-after-abort","write_document",json!({"path":first_path,"content":"forbidden late","expected":null,"resources":[],"saveBinding":null,"prepareId":stale})).await?;
    if late["ok"]!=false||late["error"]!="update_prepare_stale"{return Err("prepare_late_generation_admitted".into());}
    coordinator_case(&app,"native_generation_fence",json!({"actual_ipc":true,"no_id_saved_scope_denied":true,"stale_id_denied_during_and_after_abort":true,"disk_unchanged":true}))?;

    let late_target=root.join("forbidden-stale-selector.md");
    let selector=SelectorControl::arm(untitled.label(),Some(late_target.to_string_lossy().into_owned()),true)?;
    let mut old=cross_begin(&app,package.clone(),false).await?;selector.started().await?;
    crate::update_coordinator::abort_and_release(&app,"fixture_selector_abort");
    // Start the newer native generation while the old JS save still owns its
    // session queue; releasing the stale result must not write the old target.
    let mut newer=cross_begin(&app,package.clone(),false).await?;selector.release();
    require_abort(old.result().await,"stale_selector")?;drop(old);drop(selector);
    drop(newer.result().await?);drop(newer);prepare_released(&app).await?;
    if late_target.exists(){return Err("prepare_stale_selector_created_file".into());}
    coordinator_case(&app,"stale_selector_abort_retry",json!({"actual_frontend_selector_continuation":true,"new_generation_started_before_old_result":true,"stale_target_absent":true}))?;

    // One more untitled document proves successful native SaveAs completion
    // after abort still reconciles its own live renderer path and saved baseline.
    let late_window=prepare_untitled(&app,"# Late SaveAs actual buffer\n").await?;
    let late_path=root.join(format!("prepare-selected-{}.md",late_window.label()));
    let phase=PhaseControl::arm(late_window.label(),ReplyPhase::Saved)?;
    let mut flight=cross_begin(&app,package.clone(),false).await?;phase.started().await?;
    let io=GateControl::arm("write")?;phase.release();io.started().await?;
    crate::update_coordinator::abort_and_release(&app,"fixture_admitted_save_abort");
    if registry.snapshot().state!=AdmissionState::AbortDraining||registry.snapshot().active==0{return Err("prepare_admitted_lease_released_early".into());}
    io.release();require_abort(flight.result().await,"admitted_save")?;drop(flight);drop(io);drop(phase);prepare_released(&app).await?;
    let state=prepare_bridge(&app,&late_window,json!({"action":"session-state"})).await?;
    let native_path=app.state::<crate::Documents>().0.lock().unwrap().get(late_window.label()).cloned().flatten().ok_or("prepare_late_native_path")?;
    if state["path"]!=json!(native_path)||!late_path.exists(){return Err(format!("prepare_late_success_not_reconciled:{state}"));}
    coordinator_case(&app,"admitted_save_as_late_success",json!({"actual_native_write":true,"lease_retained_until_completion":true,"renderer_native_path_reconciled":true,"old_prepare_not_ready":true}))?;

    let broker=app.state::<crate::mcp::LeafMcpBroker>().inner().clone();
    *broker.inner.enabled.lock().unwrap()=true;broker.inner.credentials.lock().unwrap().insert("prepare-fixture".into(),"synthetic-memory-only".into());
    // The real MCP server starts production pending-finish maintenance. Direct
    // broker calls alone do not start that service; no external client is used.
    let fixture_port=broker.serve_http(app.clone(),"prepare-fixture".into(),"synthetic-memory-only".into()).await?;
    if fixture_port==0{return Err("prepare_mcp_service_not_started".into());}
    let credentials=broker.inner.credentials.lock().unwrap().clone();
    broker.call(&app,"prepare-fixture","list_documents",json!({})).await?;
    let binding=broker.window_binding(first.label()).ok_or("prepare_mcp_binding")?;
    let args=json!({"document_id":binding.document_id,"session_id":binding.session_id,"authorization_epoch":binding.authorization_epoch});
    let snapshot=broker.call(&app,"prepare-fixture","read_document",args.clone()).await?;
    let mut begin=args.clone();begin["revision"]=snapshot["revision"].clone();begin["request_id"]=json!("prepare-live-mcp");
    let task=broker.call(&app,"prepare-fixture","begin_edit",begin).await?;
    let mut batch=args.clone();batch["task_id"]=task["task_id"].clone();batch["request_id"]=json!("prepare-live-apply");batch["revision"]=snapshot["revision"].clone();
    batch["changes"]=json!([{"from":0,"to":0,"expected":"","insert":"Synthetic admitted MCP\n"}]);
    broker.call(&app,"prepare-fixture","apply_edit_batch",batch.clone()).await?;
    prepare_bridge(&app,&first,json!({"action":"pause-auto-timer"})).await?;
    let mut flight=cross_begin(&app,package.clone(),false).await?;
    if !broker.window_locked(first.label())||crate::update_coordinator::drain_once(&app,&flight.id).is_ok(){return Err("prepare_mcp_task_ignored".into());}
    batch["request_id"]=json!("prepare-denied-new-apply");
    if broker.call(&app,"prepare-fixture","apply_edit_batch",batch).await.is_ok(){return Err("prepare_new_mcp_apply_allowed".into());}
    let mut finish=args.clone();finish["task_id"]=task["task_id"].clone();broker.call(&app,"prepare-fixture","finish_edit",finish).await?;
    drop(flight.result().await?);drop(flight);prepare_released(&app).await?;
    if *broker.inner.credentials.lock().unwrap()!=credentials{return Err("prepare_mcp_credentials_changed".into());}
    coordinator_case(&app,"live_mcp_apply_and_finish",json!({"actual_apply_before_prepare":true,"new_apply_denied":true,"existing_finish_settled":true,"credentials_preserved":true}))?;

    // A real failed finish leaves pending_finish after the task itself retires.
    broker.call(&app,"prepare-fixture","list_documents",json!({})).await?;
    let binding=broker.window_binding(first.label()).ok_or("prepare_finish_binding")?;
    let args=json!({"document_id":binding.document_id,"session_id":binding.session_id,"authorization_epoch":binding.authorization_epoch});
    let snapshot=broker.call(&app,"prepare-fixture","read_document",args.clone()).await?;
    let mut begin=args.clone();begin["revision"]=snapshot["revision"].clone();begin["request_id"]=json!("prepare-pending-finish");
    let task=broker.call(&app,"prepare-fixture","begin_edit",begin).await?;
    finish_hold().lock().unwrap().armed=true;
    let mut finish=args;finish["task_id"]=task["task_id"].clone();
    if broker.call(&app,"prepare-fixture","finish_edit",finish).await.is_ok(){return Err("prepare_withheld_finish_acked".into());}
    if broker.window_binding(first.label()).is_none_or(|d|d.task.is_some())||!broker.window_locked(first.label()){return Err("prepare_pending_finish_not_real".into());}
    let mut flight=cross_begin(&app,package.clone(),false).await?;
    if crate::update_coordinator::drain_once(&app,&flight.id).is_ok(){return Err("prepare_pending_finish_ignored".into());}
    let pending={let mut hold=finish_hold().lock().unwrap();hold.armed=false;std::mem::take(&mut hold.pending)};
    let deferred_finish_calls=pending.len();
    for(label,payload)in pending{broker.dispatch_deferred(&app,&label,payload)?;}
    drop(flight.result().await?);drop(flight);prepare_released(&app).await?;
    coordinator_case(&app,"pending_finish_settlement",json!({"actual_task_retired":true,"actual_pending_finish_blocked_drain":true,"real_finish_reply_released":true,
        "real_watchdog_service_started":fixture_port>0,"deferred_finish_calls":deferred_finish_calls,"external_client_transport_exercised":false}))?;

    let pending=root.join("prepare-pending.md");std::fs::write(&pending,"# Captured pending start\n").map_err(|_|"prepare_pending_write")?;
    let io=GateControl::arm("open")?;let handle=app.clone();let source=pending.to_string_lossy().into_owned();
    let opening=tauri::async_runtime::spawn_blocking(move||crate::open_document(handle,Some(source)));io.started().await?;
    updates.test_stage_download(package.clone())?;updates.test_finish_staged_download()?;
    let snapshot=updates.snapshot();let candidate=snapshot.candidate_id.ok_or("prepare_candidate")?;
    let (_,binding)=updates.preparation_authority(&app,snapshot.op_id,&candidate)?;
    let id=updates.begin_preparation(&app,snapshot.op_id,&candidate,&binding)?;
    crate::update_coordinator::announce_begin(&app,&id)?;
    if !registry.snapshot().participants.values().any(|ready|!*ready){return Err("prepare_pending_not_captured".into());}
    crate::dispatch_os_request(&app,OpenRequest::Document(pending.clone()))?;
    if registry.snapshot().queued_opens!=1{return Err("prepare_os_open_not_queued".into());}
    crate::update_coordinator::abort_and_release(&app,"fixture_pending_start_abort");io.release();
    if opening.await.map_err(|_|"prepare_pending_task")?.is_ok(){return Err("prepare_stale_pending_start_completed".into());}drop(io);
    document_ready(&app,&pending).await?;prepare_released(&app).await?;
    coordinator_case(&app,"pending_start_and_queued_open",json!({"pending_native_instance_captured":true,"stale_start_rejected":true,"queued_os_open_replayed_after_abort":true}))?;

    updates.test_stage_download(package.clone())?;
    if updates.snapshot().state!=crate::updates::UpdateState::Downloading{return Err("prepare_download_stage_missing".into());}
    prepare_edit(&app,&second,"# Edited during staged download\n").await?;
    let (downloaded,_)=fixture_document(&app,"prepare-opened-during-download.md").await?;
    prepare_state(&app,&downloaded,"reconcile").await?;
    let mut flight=cross_begin(&app,package.clone(),true).await?;
    if !coordinator.labels(&flight.id)?.contains(&downloaded.label().to_owned()){return Err("prepare_new_document_not_recaptured".into());}
    drop(flight.result().await?);prepare_all_disk_matches(&app).await?;drop(flight);prepare_released(&app).await?;
    if std::fs::read_to_string(&second_path).map_err(|_|"prepare_download_edit_disk")?!="# Edited during staged download\n"{return Err("prepare_download_edit_lost".into());}
    coordinator_case(&app,"download_edits_new_document",json!({"download_state_fixture":true,"network_download_exercised":false,"actual_edit_and_open":true,"latest_participants_recaptured":true}))?;

    prepare_state(&app,&first,"dispose").await?;
    let phase=PhaseControl::arm(first.label(),ReplyPhase::Frozen)?;
    let mut flight=cross_begin(&app,package.clone(),false).await?;let challenge=phase.started().await?;
    let reply=ready_reply(&challenge);let mut wrong=reply.clone();wrong.identity.session_id="wrong-session".into();
    if coordinator_reply(&app,&first,"prepare-wrong-identity",&wrong).await?["ok"]!=false{return Err("prepare_wrong_identity_accepted".into());}
    if coordinator_reply(&app,&second,"prepare-wrong-window",&reply).await?["ok"]!=false{return Err("prepare_wrong_window_accepted".into());}
    phase.release();prepare_state(&app,&first,"restart").await?;drop(flight.result().await?);
    if coordinator_reply(&app,&first,"prepare-duplicate-reply",&reply).await?["ok"]!=false{return Err("prepare_duplicate_accepted".into());}
    drop(flight);drop(phase);prepare_released(&app).await?;
    if coordinator_reply(&app,&first,"prepare-late-reply",&reply).await?["ok"]!=false{return Err("prepare_late_reply_accepted".into());}
    coordinator_case(&app,"wrong_duplicate_late_reply",json!({"actual_tauri_commands":true,"wrong_window_identity_duplicate_late_denied":true,"production_listener_completed_valid_reply":true}))?;

    let rebind=prepare_untitled(&app,"# Native SaveAs rebind latest\n").await.map_err(|error|format!("prepare_rebind/open:{error}"))?;
    // This case proves retirement of a real native authorization, not merely
    // assigning a first path to an ungranted untitled document.
    broker.call(&app,"prepare-fixture","list_documents",json!({})).await.map_err(|error|format!("prepare_rebind/authorize:{error}"))?;
    let before=broker.window_binding(rebind.label()).ok_or("prepare_rebind_before")?;
    if before.client.is_none()||before.scope.is_none(){return Err("prepare_rebind_authorization_missing".into());}
    let mut flight=cross_begin(&app,package.clone(),false).await.map_err(|error|format!("prepare_rebind/begin:{error}"))?;drop(flight.result().await.map_err(|error|format!("prepare_rebind/flight:{error}"))?);
    let after=broker.window_binding(rebind.label()).ok_or("prepare_rebind_after")?;
    let renderer=prepare_bridge(&app,&rebind,json!({"action":"session-state"})).await.map_err(|error|format!("prepare_rebind/renderer:{error}"))?;
    let path=app.state::<crate::Documents>().0.lock().unwrap().get(rebind.label()).cloned().flatten().ok_or("prepare_rebind_path")?;
    let renderer_path_matches=renderer["path"]==json!(path);
    let binding_changed=before.document_id!=after.document_id||before.authorization_epoch!=after.authorization_epoch;
    if !renderer_path_matches||!binding_changed{return Err(format!("prepare_actual_save_as_not_rebound:{}",json!({"renderer_path_matches":renderer_path_matches,
        "binding_epoch_changed":before.authorization_epoch!=after.authorization_epoch,"document_id_changed":before.document_id!=after.document_id,
        "logical_anchor_changed":before.logical_identity!=after.logical_identity,"native_authorization_was_active":before.client.is_some()&&before.scope.is_some()})));}
    drop(flight);prepare_released(&app).await.map_err(|error|format!("prepare_rebind/release:{error}"))?;
    coordinator_case(&app,"save_as_native_rebind",json!({"actual_native_write_ledger":true,"renderer_and_native_path_match":true,"native_binding_changed":true}))?;

    let draft=role_report(&app,&first,"prepare-live-draft",r#"const scope=document.querySelector('.shell')||document.getElementById('app');const box=document.createElement('textarea');box.id='prepare-synthetic-draft';box.value='latest uncommitted synthetic composition';scope.append(box);box.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'synthetic'}));return {value:box.value};"#).await?;
    if draft["value"]!="latest uncommitted synthetic composition"{return Err("prepare_draft_setup_failed".into());}
    let before=broker_snapshot(&app,first.label()).await?;let mut flight=cross_begin(&app,package.clone(),false).await?;
    require_abort(flight.result().await,"live_ime")?;drop(flight);prepare_released(&app).await?;
    let retained=role_report(&app,&first,"prepare-retained-draft",r#"const box=document.getElementById('prepare-synthetic-draft');const value=box?.value;box?.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'synthetic'}));box?.remove();return {value};"#).await?;
    if retained["value"]!="latest uncommitted synthetic composition"||broker_snapshot(&app,first.label()).await?["content"]!=before["content"]{return Err("prepare_live_draft_replaced".into());}
    // Also exercise the actual comment-draft DOM settlement seam.
    let _=role_report(&app,&first,"prepare-comment-draft",r#"const list=document.getElementById('commentsList');const card=document.createElement('div');card.className='comment-card';card.dataset.commentId='synthetic-uncommitted';card.id='prepare-synthetic-comment';const box=document.createElement('textarea');box.value='latest comment draft';card.append(box);list.append(card);return {attached:true};"#).await?;
    let mut flight=cross_begin(&app,package.clone(),false).await?;require_abort(flight.result().await,"comment_draft")?;drop(flight);prepare_released(&app).await?;
    let retained=role_report(&app,&first,"prepare-comment-retained",r#"const card=document.getElementById('prepare-synthetic-comment');const value=card?.querySelector('textarea')?.value;card?.remove();return {value};"#).await?;
    if retained["value"]!="latest comment draft"{return Err("prepare_comment_draft_replaced".into());}
    coordinator_case(&app,"live_ime_draft_abort",json!({"actual_editor_composition_guard":true,"actual_comment_dom_settlement":true,"latest_drafts_unchanged":true,"synthetic_composition_input":true,"real_ime_acceptance":false}))?;

    // Dispose only this synthetic listener to omit begin/release delivery.
    prepare_state(&app,&first,"dispose").await?;let phase=PhaseControl::arm(first.label(),ReplyPhase::Frozen)?;
    let mut flight=cross_begin(&app,package.clone(),false).await?;phase.started().await?;
    phase.release();prepare_state(&app,&first,"restart").await?;drop(flight.result().await?);
    *skipped_release().lock().unwrap()=Some(first.label().into());
    drop(flight);drop(phase);
    let state=prepare_state(&app,&first,"reconcile").await?;
    *skipped_release().lock().unwrap()=None;
    if state["preparing"]!=false{return Err("prepare_missed_release_not_recovered".into());}
    prepare_released(&app).await?;
    coordinator_case(&app,"missed_begin_release_recovery",json!({"events_intentionally_omitted_for_one_listener":true,"authoritative_status_recovered_both":true,"listener_ready_handshake":true}))?;

    let phase=PhaseControl::arm(first.label(),ReplyPhase::Saved)?;
    let mut flight=cross_begin(&app,package.clone(),false).await?;phase.started().await?;
    // Rebuild the actual participant lifecycle, preserving the real live editor
    // and session. A Saved reload has no local Frozen proof and must abort.
    prepare_state(&app,&first,"dispose").await?;phase.release();prepare_state(&app,&first,"restart").await?;
    require_abort(flight.result().await,"saved_listener_reload")?;drop(flight);drop(phase);prepare_released(&app).await?;
    let latest=broker_snapshot(&app,first.label()).await?["content"].clone();
    let generation=*app.state::<Driver>().prepare_ready.lock().unwrap().get(first.label()).unwrap_or(&0);
    let phase=PhaseControl::arm(first.label(),ReplyPhase::Sealed)?;
    let mut flight=cross_begin(&app,package.clone(),false).await?;phase.started().await?;
    prepare_all_disk_matches(&app).await?;
    first.eval("window.__prepare_reload_marker=true;location.reload()").map_err(|_|"prepare_actual_reload_request")?;
    changed_until(&app,"actual_reload_invalidates_prepare",||coordinator.labels(&flight.id).is_err()).await?;
    phase.release();require_abort(flight.result().await,"actual_webview_reload")?;drop(flight);drop(phase);
    changed_until(&app,"actual_reload_mcp_and_protocol_ready",||app.state::<Driver>().prepare_ready.lock().unwrap().get(first.label()).is_some_and(|value|*value>generation)).await?;
    let fresh=role_report(&app,&first,"prepare-fresh-webview",r#"return {fresh:window.__prepare_reload_marker!==true,editable:document.querySelector('.cm-content')?.contentEditable==='true'};"#).await?;
    if fresh["fresh"]!=true||fresh["editable"]!=true||broker_snapshot(&app,first.label()).await?["content"]!=latest{return Err(format!("prepare_actual_reload_not_recovered:{fresh}"));}
    prepare_released(&app).await?;
    coordinator_case(&app,"reload_mid_saved_abort",json!({"saved_controller_recreation_aborted":true,"actual_webview_reloaded_at_sealed":true,
        "all_files_durable_before_reload":true,"fresh_webview_global":true,"native_ready_generation_changed":true,"mcp_registration_and_ordinary_editing_restored":true,"latest_durable_content_retained":true,"dirty_unstaged_reload_claim":false}))?;

    let phase=PhaseControl::arm(first.label(),ReplyPhase::Saved)?;
    let mut flight=cross_begin(&app,package.clone(),false).await?;phase.started().await?;
    first.close().map_err(|_|"prepare_native_close_request")?;phase.release();
    require_abort(flight.result().await,"native_close")?;drop(flight);drop(phase);prepare_released(&app).await?;
    let close_state=role_report(&app,&first,"prepare-native-close-retained",r#"return {prompt:!!document.querySelector('[role=alertdialog]')};"#).await?;
    if close_state["prompt"]!=false||app.get_webview_window(first.label()).is_none(){return Err("prepare_native_close_continued_after_cancel".into());}
    let nonce=registry.snapshot().instances[first.label()];
    changed_until(&app,"suppressed_close_completed",||coordinator.close_action(first.label(),nonce).is_none()).await?;
    prepare_edit(&app,&first,"# Ordinary close keeps this latest edit\n").await?;
    first.close().map_err(|_|"prepare_ordinary_close_request")?;
    let prompt=role_report(&app,&first,"prepare-ordinary-close-prompt",r#"const root=document.body;await new Promise((resolve,reject)=>{if(document.querySelector('[role=alertdialog]'))return resolve();const timeout=setTimeout(()=>{observer.disconnect();reject(Error('prompt_timeout'));},10000);const observer=new MutationObserver(()=>{if(document.querySelector('[role=alertdialog]')){clearTimeout(timeout);observer.disconnect();resolve();}});observer.observe(root,{childList:true,subtree:true});});return {prompt:true};"#).await?;
    if prompt["prompt"]!=true||coordinator.close_action(first.label(),nonce).is_none(){return Err("prepare_ordinary_close_owner_missing".into());}
    if cross_begin(&app,package.clone(),false).await.is_ok(){return Err("prepare_started_during_ordinary_prompt".into());}
    let _=role_report(&app,&first,"prepare-ordinary-close-cancel",r#"document.querySelector('[data-choice=cancel]').click();return {cancelled:true};"#).await?;
    changed_until(&app,"ordinary_close_completed",||coordinator.close_action(first.label(),nonce).is_none()).await?;
    let phase=PhaseControl::arm(first.label(),ReplyPhase::Frozen)?;
    prepare_state(&app,&first,"dispose").await?;
    let mut flight=cross_begin(&app,package.clone(),false).await?;phase.started().await?;
    crate::request_ordinary_quit(&app);phase.release();require_abort(flight.result().await,"ordinary_quit")?;drop(flight);drop(phase);
    prepare_state(&app,&first,"restart").await?;prepare_released(&app).await?;
    coordinator_case(&app,"native_close_ordinary_quit_race",json!({"actual_native_close_event_and_frontend_callback":true,"same_action_suppressed":true,"ordinary_prompt_owned_until_explicit_cancel":true,"new_prepare_denied_during_prompt":true,"quit_cancelled_prepare_without_close_broadcast":true}))?;

    for loss in [false,true]{
        prepare_state(&app,&first,"dispose").await?;let phase=PhaseControl::arm(first.label(),ReplyPhase::Frozen)?;
        let mut flight=cross_begin(&app,package.clone(),false).await?;phase.started().await?;
        if loss{let(id,labels)=coordinator.participant_lost(first.label()).ok_or("prepare_loss_not_detected")?;crate::update_coordinator::release(&app,&id,labels,"fixture_loss_signal");}
        else{if coordinator.deadline_check(&flight.id,std::time::Instant::now()+std::time::Duration::from_secs(301)).is_ok(){return Err("prepare_timeout_not_detected".into());}crate::update_coordinator::abort_and_release(&app,"update_prepare_timeout");}
        phase.release();require_abort(flight.result().await,"timeout_or_loss")?;drop(flight);drop(phase);
        prepare_state(&app,&first,"restart").await?;prepare_released(&app).await?;
    }
    coordinator_case(&app,"timeout_and_loss",json!({"production_monotonic_deadline_checked_with_advanced_instant":true,"actual_native_participant_loss_callback":true,"real_process_crash":false,"authority_invalidated_before_release":true}))?;

    let phase=PhaseControl::arm(first.label(),ReplyPhase::Saved)?;
    let mut flight=cross_begin(&app,package.clone(),false).await?;phase.started().await?;
    let handle=app.clone();let(tx,rx)=tokio::sync::oneshot::channel();app.run_on_main_thread(move||{
        crate::refresh_document_menu(&handle);
        let values=["save","new","open","undo","paste","export-pdf"].map(|id|crate::document_menu_item(&handle,id).is_some_and(|item|item.is_enabled().unwrap_or(true)));
        let _=tx.send(values);
    }).map_err(|_|"prepare_menu_schedule")?;
    if rx.await.map_err(|_|"prepare_menu_response")?.iter().any(|value|*value){return Err("prepare_mutating_menu_enabled".into());}
    crate::update_coordinator::abort_and_release(&app,"fixture_menu_abort");phase.release();require_abort(flight.result().await,"menu_abort")?;drop(flight);drop(phase);prepare_released(&app).await?;
    let handle=app.clone();let(tx,rx)=tokio::sync::oneshot::channel();app.run_on_main_thread(move||{
        crate::refresh_document_menu(&handle);let _=tx.send(crate::document_menu_item(&handle,"save").is_some_and(|item|item.is_enabled().unwrap_or(false)));
    }).map_err(|_|"prepare_menu_restore_schedule")?;
    if !rx.await.map_err(|_|"prepare_menu_restore_response")?{return Err("prepare_menu_not_reopened".into());}
    coordinator_case(&app,"native_menu_barrier_reopen",json!({"actual_native_menu_enabled_states":true,"disabled_during_barrier":true,"enabled_after_abort":true}))?;

    let mut flight=cross_begin(&app,package.clone(),false).await?;let permit=flight.result().await?;
    if updates.commit_preparation(&app,flight.binding.op_id,&flight.binding.candidate,&flight.binding,permit,false).is_ok(){return Err("prepare_installer_absence_committed".into());}
    drop(flight);prepare_released(&app).await?;
    coordinator_case(&app,"installer_not_ready_abort",json!({"independent_helper_ready_required":true,"actual_installer_absent":true,"saved_files_retained":true}))?;

    // Resume the real updater using its one confirmation dialog. The cached
    // TEST-ONLY package is staged; this does not claim a network download.
    updates.test_ready_for_confirmation(&app,package)?;
    crate::updates::open_update_window(&app)?;observed(&app,"ready").await?;
    let updater=app.get_webview_window(crate::updates::LABEL).ok_or("prepare_updater_missing")?;
    let confirmed=role_report(&app,&updater,"prepare-one-confirmation",r#"document.getElementById('update-action').click();const modal=!!document.querySelector('[role=alertdialog]');document.getElementById('update-confirm-submit').click();return {modal};"#).await?;
    if confirmed["modal"]!=true{return Err("prepare_confirmation_missing".into());}
    changed_until(&app,"confirmed_prepare_completion",||app.state::<Driver>().coordinator.lock().unwrap().final_pending||updates.snapshot().state==crate::updates::UpdateState::PrepareFailed).await?;
    if !app.state::<Driver>().coordinator.lock().unwrap().final_pending{return Err(format!("prepare_confirmed_flow_failed:{:?}",updates.snapshot().error_code));}
    Ok(())
}
