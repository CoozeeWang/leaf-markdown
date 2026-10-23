//! Real Leaf GUI preservation, restricted to an owned disposable native fixture.
use std::{fs,path::{Path,PathBuf},sync::{Arc,atomic::{AtomicBool,AtomicU64,Ordering}}};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use tauri::Manager;
pub(crate) fn enabled()->bool{
    let args=std::env::args().skip(1).collect::<Vec<_>>();
    (args.first().is_some_and(|value|value=="--mac-update-preservation-smoke")
        ||(args.len()==4&&args[0]=="--leaf-update-reconcile"))
        &&std::env::var_os("LEAF_UPDATE_PRESERVATION_ROOT").is_some()
}
pub(crate) fn resumed()->bool{std::env::args().nth(1).as_deref()==Some("--leaf-update-reconcile")}
fn fail(code:&str)->String{format!("preservation_{code}")}
pub(crate) fn root()->Result<PathBuf,String>{
    use std::os::unix::fs::MetadataExt;
    let path=PathBuf::from(std::env::var_os("LEAF_UPDATE_PRESERVATION_ROOT").ok_or_else(||fail("root"))?);
    let canonical=path.canonicalize().map_err(|_|fail("root"))?;let temp=std::env::temp_dir().canonicalize().map_err(|_|fail("root"))?;
    let metadata=fs::symlink_metadata(&path).map_err(|_|fail("root"))?;
    let owner=tempfile::tempfile().and_then(|file|file.metadata()).map_err(|_|fail("root"))?;
    if path!=canonical||!canonical.starts_with(&temp)||canonical==temp||metadata.file_type().is_symlink()||!metadata.is_dir()
        ||metadata.uid()!=owner.uid()||metadata.mode()&0o077!=0||!canonical.file_name().is_some_and(|name|name.to_string_lossy().starts_with("leaf-update-test-")){return Err(fail("root"));}
    Ok(canonical)
}
pub(crate) fn read_private(path:&Path,max:u64)->Result<Vec<u8>,String>{
    use std::os::unix::fs::MetadataExt;
    let root=root()?;let metadata=fs::symlink_metadata(path).map_err(|_|fail("private_file"))?;
    let owner=fs::metadata(&root).map_err(|_|fail("root"))?;
    if !path.starts_with(&root)||path.canonicalize().ok().as_deref()!=Some(path)||!metadata.is_file()||metadata.file_type().is_symlink()
        ||metadata.nlink()!=1||metadata.uid()!=owner.uid()||metadata.mode()&0o077!=0||metadata.len()>max{return Err(fail("private_file"));}
    fs::read(path).map_err(|_|fail("private_file"))
}
fn seed()->Result<Value,String>{serde_json::from_slice(&read_private(&root()?.join("preservation-seed.json"),65536)?).map_err(|_|fail("seed"))}
pub(crate) fn profile()->Result<PathBuf,String>{Ok(root()?.join("profile"))}
pub(crate) fn store_id()->Result<[u8;16],String>{
    let seed=seed()?;let run=seed["run_id"].as_str().filter(|run|run.len()==36).ok_or_else(||fail("run"))?;
    let digest=Sha256::digest(run.as_bytes());let mut id=[0u8;16];id.copy_from_slice(&digest[..16]);Ok(id)
}
pub(crate) fn configure(config:&mut tauri::utils::config::Config)->Result<(),String>{
    crate::mcp::ai_credentials::private_directory(&profile()?)?;
    std::env::set_var("LEAF_UPDATE_TEST_DIR",profile()?);
    crate::mcp::ai_credentials::install_preservation_vault(synthetic_vault)?;
    config.identifier="studio.leaf.editor".into();config.build.dev_url=None;
    for window in &mut config.app.windows{window.incognito=false;window.create=false;window.data_store_identifier=Some(store_id()?);}
    Ok(())
}
pub(crate) fn vault_path(reference:&str)->Result<PathBuf,String>{
    let directory=profile()?.join("synthetic-runtime-vault");crate::mcp::ai_credentials::private_directory(&directory)?;
    Ok(directory.join(format!("{:x}",Sha256::digest(reference.as_bytes()))))
}
fn synthetic_vault(reference:&str,action:&str,key:Option<&str>)->Result<String,String>{
    if !enabled(){return Err(fail("vault_disabled"));}
    let path=vault_path(reference)?;
    match action{
        "set"=>{let key=key.ok_or("synthetic_runtime_key")?;crate::mcp::ai_credentials::write_private(&path,key)?;Ok(String::new())},
        "get"=>String::from_utf8(read_private(&path,16384)?).map_err(|_|"synthetic_runtime_key".into()),
        "delete"=>{match fs::remove_file(path){Ok(())=>{},Err(error)if error.kind()==std::io::ErrorKind::NotFound=>{},Err(_)=>return Err("synthetic_runtime_key".into())};Ok(String::new())},
        _=>Err("synthetic_runtime_key".into()),
    }
}
fn seed_runtime(app:&tauri::AppHandle,key:&str)->Result<(),String>{
    use crate::mcp::ai_credentials::{TunnelProfile,SessionSecrets,GuiRuntimeSecretStore};
    if !enabled(){return Err("test_disabled".into());}
    let root=profile()?;let directory=root.join("mcp/tunnel");crate::mcp::ai_credentials::private_directory(&directory)?;
    let broker=app.state::<crate::mcp::LeafMcpBroker>();let mut profiles=broker.inner.profiles.lock().unwrap();let store=profiles.as_mut().ok_or("profiles_unavailable")?;
    if *broker.inner.enabled.lock().unwrap(){return Err("synthetic_connection_enabled".into());}
    let profile=store.status("chatgpt")?;
    let tunnel=TunnelProfile{proxy_url:String::new(),tunnel_id:"synthetic-preservation".into(),executable:directory.join("synthetic-tunnel-not-launched"),
        profile:directory.join("synthetic.yaml"),health_file:directory.join("synthetic-health.json"),generation:0,digest:"synthetic-preservation".into()};
    store.configure_tunnel(tunnel,key,"synthetic-preservation-seed",profile.generation,&SessionSecrets,&GuiRuntimeSecretStore)?;
    Ok(())
}

fn persist(name:&str,value:&Value)->Result<(),String>{
    use std::{io::Write,os::unix::fs::OpenOptionsExt};
    let path=root()?.join(name);let mut file=fs::OpenOptions::new().create_new(true).write(true).mode(0o600).open(path).map_err(|_|fail("immutable_evidence"))?;
    file.write_all(&serde_json::to_vec(value).map_err(|_|fail("serialize"))?).and_then(|_|file.sync_all()).map_err(|_|fail("evidence"))
}
fn hmac(key:&str,challenge:&str)->String{
    let mut block=[0u8;64];let shortened;if key.len()>64{shortened=Sha256::digest(key.as_bytes()).to_vec();block[..shortened.len()].copy_from_slice(&shortened);}else{block[..key.len()].copy_from_slice(key.as_bytes());}
    let mut inside=Sha256::new();inside.update(block.map(|byte|byte^0x36));inside.update(challenge.as_bytes());
    let mut outside=Sha256::new();outside.update(block.map(|byte|byte^0x5c));outside.update(inside.finalize());format!("{:x}",outside.finalize())
}
fn credential(app:&tauri::AppHandle,challenge:&str)->Result<String,String>{
    let broker=app.state::<crate::mcp::LeafMcpBroker>();let mut profiles=broker.inner.profiles.lock().unwrap();
    let key=profiles.as_mut().ok_or_else(||fail("native_profiles"))?.runtime_key(&crate::mcp::ai_credentials::SessionSecrets,&crate::mcp::ai_credentials::GuiRuntimeSecretStore)?;
    Ok(hmac(&key,challenge))
}
struct Control{proceed:tokio::sync::Notify,finish:tokio::sync::Notify,continued:AtomicBool,finished:AtomicBool,downloads:AtomicU64}
impl Default for Control{fn default()->Self{Self{proceed:tokio::sync::Notify::new(),finish:tokio::sync::Notify::new(),continued:AtomicBool::new(false),finished:AtomicBool::new(false),downloads:AtomicU64::new(0)}}}
async fn wait_signal(notify:&tokio::sync::Notify,flag:&AtomicBool)->Result<(),String>{
    tokio::time::timeout(std::time::Duration::from_secs(90),async{loop{let changed=notify.notified();tokio::pin!(changed);changed.as_mut().enable();if flag.load(Ordering::SeqCst){return;}changed.await;}}).await.map_err(|_|fail("controller_timeout"))
}
async fn server(app:tauri::AppHandle,listener:tokio::net::TcpListener,control:Arc<Control>,candidate:crate::update_releases::CandidateIdentity,payload:PathBuf)->Result<(),String>{
    use tokio::io::{AsyncReadExt,AsyncWriteExt};
    let token=seed()?["control_token"].as_str().filter(|value|value.len()==64).ok_or_else(||fail("control_token"))?.to_owned();
    loop{
        let(mut stream,_)=listener.accept().await.map_err(|_|fail("control_accept"))?;
        let mut request=Vec::new();let mut chunk=[0u8;1024];
        loop{let count=tokio::time::timeout(std::time::Duration::from_secs(5),stream.read(&mut chunk)).await.map_err(|_|fail("request_timeout"))?.map_err(|_|fail("request_read"))?;
            if count==0||request.len()+count>8192{return Err(fail("request_limit"));}request.extend_from_slice(&chunk[..count]);
            if let Some(end)=request.windows(4).position(|bytes|bytes==b"\r\n\r\n"){
                let head=String::from_utf8_lossy(&request[..end]);let length=head.lines().find_map(|line|line.to_ascii_lowercase().strip_prefix("content-length:").and_then(|value|value.trim().parse::<usize>().ok())).unwrap_or(0);
                if request.len()>=end+4+length{break;}
            }
        }
        let text=String::from_utf8_lossy(&request);let path=text.split_whitespace().nth(1).unwrap_or("");
        let mut status="200 OK";
        let body=if path=="/releases"||path=="/releases?per_page=100&page=1"{
            serde_json::to_vec(&json!([{"id":candidate.release_id,"tag_name":candidate.tag,"draft":false,"prerelease":true,"published_at":"2026-01-01T00:00:00Z","body":"Synthetic real Leaf preservation update",
                "assets":[{"id":candidate.manifest_asset_id,"name":"latest.json","browser_download_url":format!("https://github.com/CoozeeWang/leaf-markdown/releases/download/{}/latest.json",candidate.tag)},
                    {"id":candidate.asset_id,"name":candidate.asset_name,"browser_download_url":candidate.url}]}])).map_err(|_|fail("catalog"))?
        }else if path==format!("/releases/manifest/{}",candidate.manifest_asset_id){
            serde_json::to_vec(&json!({"version":candidate.version,"platforms":{(candidate.platform.clone()):{"url":candidate.url,"signature":candidate.signature}}})).map_err(|_|fail("manifest"))?
        }else if path==format!("/releases/package/{}",candidate.asset_id){
            let bytes=fs::read(&payload).map_err(|_|fail("payload"))?;let count=control.downloads.fetch_add(1,Ordering::SeqCst)+1;
            if count==1{persist("actual-download.json",&json!({"count":count,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes))}))?;}bytes
        }else if !text.lines().any(|line|line.split_once(':').is_some_and(|(name,value)|name.eq_ignore_ascii_case("authorization")&&value.trim()==format!("Bearer {token}"))){status="403 Forbidden";b"{}".to_vec()}
        else if path=="/credential"{
            let body=text.split_once("\r\n\r\n").map(|(_,body)|body).unwrap_or("");
            let value:Value=serde_json::from_str(body).map_err(|_|fail("challenge"))?;
            let challenge=value["challenge"].as_str().filter(|value|value.len()==64&&value.bytes().all(|byte|byte.is_ascii_hexdigit())).ok_or_else(||fail("challenge"))?;
            serde_json::to_vec(&json!({"present":true,"response":credential(&app,challenge)?})).map_err(|_|fail("challenge"))?
        }else if path=="/status"{serde_json::to_vec(&app.state::<crate::updates::Updates>().snapshot()).map_err(|_|fail("status"))?}
        else if path=="/continue"&&!control.continued.swap(true,Ordering::SeqCst){control.proceed.notify_waiters();b"{\"ok\":true}".to_vec()}
        else if path=="/finish"&&!control.finished.swap(true,Ordering::SeqCst){control.finish.notify_waiters();b"{\"ok\":true}".to_vec()}
        else{status="409 Conflict";b"{}".to_vec()};
        stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await.map_err(|_|fail("response"))?;
        stream.write_all(&body).await.map_err(|_|fail("response"))?;
    }
}
async fn capture(app:&tauri::AppHandle,window:&tauri::WebviewWindow)->Result<Value,String>{
    let web=crate::update_test_driver::role_report(app,window,"preservation-read-web",r#"const names=['leaf-theme','leaf-body-fonts-v1','leaf-reading-v2-size','leaf-reading-v2-width','leaf-line-numbers','leaf-blank-markers','leaf-preservation-run'];const saved=Object.fromEntries(names.map(name=>[name,localStorage.getItem(name)]));return {saved,theme:document.documentElement.dataset.theme,fontSize:document.getElementById('fontSizeInput').value,width:document.getElementById('contentWidthInput').value};"#).await?;
    if web["exception"]==true{return Err(fail("webview_read"));}
    let directory=profile()?;let store=crate::recovery_store(app)?;
    let named=store.read("preservation-named")?;let untitled=store.read("preservation-untitled")?;let history=store.read("preservation-history")?;
    let recent=app.state::<crate::recent::Recent>().list().into_iter().map(|entry|json!({"path":entry.path,"name":entry.name})).collect::<Vec<_>>();
    let broker=app.state::<crate::mcp::LeafMcpBroker>();
    if *broker.inner.enabled.lock().unwrap(){return Err(fail("synthetic_connection_enabled"));}
    let mut connections=Vec::new();for value in broker.client_profiles()?{let mut value=serde_json::to_value(value).map_err(|_|fail("profiles"))?;value.as_object_mut().unwrap().remove("generation");value.as_object_mut().unwrap().remove("credential_ref");
        if let Some(tunnel)=value.get_mut("tunnel").and_then(Value::as_object_mut){tunnel.remove("generation");}connections.push(value);}
    let mut versions=history.versions.clone();
    for path in [directory.join("First.md"),directory.join("Second.md")] {versions.extend(store.read(&crate::recovery::file_key(&path))?.versions);}
    versions.sort_by(|left,right|left.timestamp.cmp(&right.timestamp).then(left.id.cmp(&right.id)));
    Ok(json!({"version":env!("CARGO_PKG_VERSION"),"application":{"identifier":app.config().identifier,"data_path":directory,"webview_path":format!("{:x?}",store_id()?)},
        "language":{"preference":crate::i18n::language_get(app.clone())?.preference},"theme":web["theme"],"bodyFonts":web["saved"]["leaf-body-fonts-v1"],
        "layout":{"size":web["fontSize"],"width":web["width"],"line_numbers":web["saved"]["leaf-line-numbers"]},"savePreferences":{"recovery_retention_days":crate::retention_days(app)?},
        "recentFiles":recent,"namedDrafts":named,"untitledDrafts":untitled,"recoveryRecords":history,"webviewStorage":web["saved"],"connectionConfig":connections,
        "history":versions}))
}
fn seed_recovery(app:&tauri::AppHandle)->Result<(),String>{
    let store=crate::recovery_store(app)?;
    store.checkpoint("preservation-named",Some(profile()?.join("Inactive.md").to_string_lossy().into_owned()),"# Named actual native draft","synthetic-preservation",true)?;
    store.checkpoint("preservation-untitled",None,"# Untitled actual native draft","synthetic-preservation",true)?;
    store.before_save("preservation-history","/Synthetic/History.md".into(),Some("# Actual native recovery version"))?;
    Ok(())
}
static ACCEPTED:AtomicU64=AtomicU64::new(0);
pub(crate) fn accepted_exit(accepted:bool){if enabled()&&accepted&&!resumed(){ACCEPTED.fetch_add(1,Ordering::SeqCst);}}
pub(crate) fn exited(app:&tauri::AppHandle){
    if !enabled(){return;}
    if resumed(){let _=persist("cleanup-exit.json",&json!({"actual_harness_exit_event":true}));}
    else{let snapshot=app.state::<crate::updates::Updates>().snapshot();let _=persist("actual-update-exit.json",&json!({"accepted_exit_requested":ACCEPTED.load(Ordering::SeqCst),"exit_events":1,"committed":app.state::<crate::update_coordinator::UpdateCoordinator>().committed(),"verified_package_consumed":app.state::<crate::updates::Updates>().preservation_consumed(),"state":snapshot.state}));}
}
pub(crate) fn start(app:&tauri::AppHandle){
    if !enabled(){return;}
    let handle=app.clone();tauri::async_runtime::spawn(async move{
        let result=tokio::time::timeout(std::time::Duration::from_secs(240),run(handle.clone())).await.unwrap_or_else(|_|Err(fail("timeout")));
        if let Err(code)=result{let _=persist("preservation-failure.json",&json!({"pass":false,"error":code,"resumed":resumed()}));handle.exit(1);}
    });
}
async fn run(app:tauri::AppHandle)->Result<(),String>{
    let(payload,candidate,trust)=crate::update_package::fixture_input()?;
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|_|fail("server"))?;
    let source=format!("http://127.0.0.1:{}/releases",listener.local_addr().map_err(|_|fail("server"))?.port());
    let address=format!("http://127.0.0.1:{}",listener.local_addr().map_err(|_|fail("server"))?.port());
    let control=Arc::new(Control::default());let server_task=tokio::spawn(server(app.clone(),listener,control.clone(),candidate,payload));
    let first_path=profile()?.join("First.md");
    let first=if resumed(){
        let handle=app.clone();let path=first_path.to_string_lossy().into_owned();
        tauri::async_runtime::spawn_blocking(move||crate::open_document(handle,Some(path))).await.map_err(|_|fail("reopen"))??;
        let first=crate::update_test_driver::document_ready(&app,&first_path).await?;
        let handle=app.clone();let second_path=profile()?.join("Second.md");let path=second_path.to_string_lossy().into_owned();
        tauri::async_runtime::spawn_blocking(move||crate::open_document(handle,Some(path))).await.map_err(|_|fail("reopen"))??;
        crate::update_test_driver::document_ready(&app,&second_path).await?;
        first
    }else{
        let(first,_)=crate::update_test_driver::fixture_document(&app,"First.md").await?;
        let(second,_)=crate::update_test_driver::fixture_document(&app,"Second.md").await?;
        let setup=format!(r#"const run={};localStorage.setItem('leaf-preservation-run',run);localStorage.setItem('leaf-line-numbers','true');localStorage.setItem('leaf-blank-markers','true');for(const[id,value,event]of [['themeSelect','dark','change'],['fontSizeInput','19','input'],['contentWidthInput','820','input']]){{const node=document.getElementById(id);node.value=value;node.dispatchEvent(new Event(event,{{bubbles:true}}));}}for(const id of ['chineseFontSelect','englishFontSelect']){{const node=document.getElementById(id);if(![...node.options].some(option=>option.value==='serif'))throw Error('font controls not ready');node.value='serif';node.dispatchEvent(new Event('change',{{bubbles:true}}));}}await invoke('language_set',{{preference:'zh-Hant-TW'}});await invoke('recovery_retention',{{days:90}});return {{seeded:true}};"#,seed()?["run_id"]);
        let setup=crate::update_test_driver::role_report(&app,&first,"preservation-seed-web",&setup).await?;
        if setup["seeded"]!=true{return Err(fail("webview_seed"));}
        seed_recovery(&app)?;
        seed_runtime(&app,seed()?["credential"].as_str().ok_or_else(||fail("credential_seed"))?)?;
        crate::update_test_driver::prepare_edit(&app,&first,"# First actual Leaf protected edit\n").await?;
        crate::update_test_driver::prepare_edit(&app,&second,"# Second actual Leaf protected edit\n").await?;
        first
    };
    let snapshot=capture(&app,&first).await?;
    let phase=if resumed(){"after"}else{"before"};
    persist(&format!("profile-{phase}.json"),&snapshot)?;
    persist(&format!("control-{phase}.json"),&json!({"address":address,"pid":std::process::id(),"version":env!("CARGO_PKG_VERSION"),"resumed":resumed(),"state":app.state::<crate::updates::Updates>().snapshot().state}))?;
    if resumed(){
        wait_signal(&control.finish,&control.finished).await?;server_task.abort();app.exit(0);return Ok(());
    }
    app.state::<crate::updates::Updates>().preservation_source(source,trust)?;
    crate::dispatch_update_menu(&app,first.label())?;
    crate::update_test_driver::observed(&app,"available").await?;
    let updater=app.get_webview_window(crate::updates::LABEL).ok_or_else(||fail("updater"))?;
    if !updater.is_visible().unwrap_or(false){return Err(fail("updater_invisible"));}
    wait_signal(&control.proceed,&control.continued).await?;
    let confirmed=crate::update_test_driver::role_report(&app,&updater,"preservation-confirm",r#"document.getElementById('update-action').click();const modal=!!document.querySelector('[role=alertdialog]');document.getElementById('update-confirm-submit').click();return {modal};"#).await?;
    if confirmed["modal"]!=true{return Err(fail("confirmation"));}
    persist("actual-confirmation.json",&json!({"one_confirmation":true,"actual_updater_visible":true,"actual_platform_menu_dispatch":true}))?;
    std::future::pending::<Result<(),String>>().await
}
#[cfg(test)]
mod tests{
    #[test]fn native_credential_hmac_matches_standard_vector(){assert_eq!(super::hmac("key","The quick brown fox jumps over the lazy dog"),"f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");}
}
