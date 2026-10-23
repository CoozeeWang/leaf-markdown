use crate::*;
use crate::update_install::windows::{self,WindowsInstallPlan,InstallResult,InstallState,native::{self,NativePlatform,ChannelMessage}};
use std::{io::{BufRead,Read,Write},process::{Child,ChildStdin,Stdio},sync::mpsc};
#[derive(Default)]
pub(crate) struct Handoff(Mutex<Option<ReadyHelper>>);
struct ReadyHelper{child:Child,input:Option<ChildStdin>,root:Option<tempfile::TempDir>,plan:WindowsInstallPlan,digest:String,detached:bool}
impl Drop for ReadyHelper{fn drop(&mut self){if !self.detached{self.input.take();let _=self.child.kill();let _=self.child.wait();}}}
impl ReadyHelper{fn send(&mut self,kind:&str)->Result<(),String>{let input=self.input.as_mut().ok_or("update_helper_channel")?;serde_json::to_writer(&mut *input,&native::channel_message(kind,&self.plan,&self.digest)).map_err(|_|"update_helper_channel")?;input.write_all(b"\n").and_then(|_|input.flush()).map_err(|_|"update_helper_channel".into())}}
fn write_private(path:&Path,bytes:&[u8])->Result<(),String>{let mut file=fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|_|"update_install_journal")?;file.write_all(bytes).and_then(|_|file.sync_all()).map_err(|_|"update_install_journal".into())}
fn stage_and_arm(package:std::sync::Arc<crate::update_package::VerifiedPackage>,id:update_coordinator::PrepareId,binding:update_coordinator::PackageBinding)->Result<ReadyHelper,String>{
    let executable=PathBuf::from(&binding.target).canonicalize().map_err(|_|"update_target_unavailable")?;
    if executable.file_name().is_none_or(|name|name!="leaf.exe"){return Err("update_install_scope".into());}
    let target=executable.parent().ok_or("update_install_scope")?.to_path_buf();
    let registry=native::registry()?;let old_version=native::installed_version(&target,&registry)?;
    let parent=target.parent().ok_or("update_install_scope")?;
    let root=tempfile::Builder::new().prefix(".leaf-update-").tempdir_in(parent).map_err(|_|"update_install_target_not_writable")?;
    let root_path=root.path().canonicalize().map_err(|_|"update_install_path")?;
    native::protect_root(&root_path)?;
    let staged=root_path.join("Prepared");let metadata=package.authenticated_metadata();
    if metadata.identifier!=binding.bundle||package.digest()!=binding.digest||metadata.platform!="windows"||metadata.arch!="x86_64"{return Err("update_install_package_binding".into());}
    let mut new=windows::Inventory::new();let prefix=format!("{}/",metadata.root);
    for entry in &metadata.inventory{if entry.path==metadata.root{continue;}let path=entry.path.strip_prefix(&prefix).ok_or("update_install_inventory")?;let value=match entry.kind.as_str(){"directory"=>"directory".into(),"file"=>entry.sha256.clone().ok_or("update_install_inventory")?,_=>return Err("update_install_inventory".into())};if new.insert(path.into(),value).is_some(){return Err("update_install_inventory".into());}}
    windows::copy_tree(package.staged_root(),&staged,&new)?;
    let installer_digest=new.remove(".leaf-update-installer.exe").ok_or("update_install_installer_missing")?;
    let helper=root_path.join("leaf-update-helper.exe");fs::copy(staged.join("leaf-update-helper.exe"),&helper).map_err(|_|"update_install_helper_missing")?;
    let mut token=[0u8;32];getrandom::fill(&mut token).map_err(|_|"update_instance_entropy")?;
    let plan=WindowsInstallPlan{transaction:id.0,target:target.clone(),staged,helper:helper.clone(),backup:root_path.join("Previous"),journal:root_path.join("result.json"),gui_pid:std::process::id(),gui_executable:executable,target_anchor:native::anchor(&target)?,installer_digest,package_digest:binding.digest,token:token.iter().map(|byte|format!("{byte:02x}")).collect(),created_unix:std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|"update_install_clock")?.as_secs(),old_version,new_version:metadata.version.clone(),old:windows::inventory(&target)?,new,registry};
    let path=root_path.join("plan.json");let encoded=serde_json::to_vec(&plan).map_err(|_|"update_install_plan")?;let digest=windows::hash(&encoded);
    write_private(&path,&encoded)?;write_private(&root_path.join("plan.sha256"),digest.as_bytes())?;write_private(&root_path.join("transaction-id"),plan.transaction.as_bytes())?;
    windows::check_ready(&plan,&mut NativePlatform{plan_path:path.clone(),digest:digest.clone()})?;
    let mut child=std::process::Command::new(&helper).arg("--install-plan").arg(&path).arg(&digest).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_|"update_helper_start")?;
    let input=child.stdin.take();let output=child.stdout.take().ok_or("update_helper_channel")?;let mut ready=ReadyHelper{child,input,root:Some(root),plan,digest,detached:false};
    let(sender,receiver)=mpsc::sync_channel(2);std::thread::spawn(move||{let mut output=std::io::BufReader::new(output);for _ in 0..2{let mut line=String::new();let read=(&mut output).take(8193).read_line(&mut line);let message=if read.is_ok()&&line.len()<=8192&&line.ends_with('\n'){serde_json::from_str::<ChannelMessage>(&line).ok()}else{None};let valid=message.is_some();let _=sender.send(message);if !valid{break;}}});
    let receive=|kind:&str,ready:&ReadyHelper|->Result<(),String>{let message=receiver.recv_timeout(std::time::Duration::from_secs(30)).map_err(|_|"update_helper_ready_timeout")?.ok_or("update_helper_channel")?;if !native::valid_message(&message,kind,&ready.plan,&ready.digest){return Err("update_helper_authority".into());}Ok(())};
    receive("ready",&ready)?;ready.send("arm")?;receive("armed",&ready)?;if ready.child.try_wait().map_err(|_|"update_helper_channel")?.is_some(){return Err("update_helper_exited".into());}Ok(ready)
}
    pub(crate) async fn handoff(app:&tauri::AppHandle,id:&update_coordinator::PrepareId,op:u64,candidate:&str,binding:&update_coordinator::PackageBinding,package:std::sync::Arc<crate::update_package::VerifiedPackage>)->Result<(),String>{
        if app.state::<Handoff>().0.lock().unwrap().is_some(){return Err("update_install_busy".into());}
        let(_,current)=app.state::<updates::Updates>().preparation_authority(app,op,candidate)?;
        if &current!=binding{return Err("update_install_package_binding".into());}
        let owner=id.clone();let target=binding.clone();let staged_package=package.clone();
        let(permit,mut ready)=update_coordinator::run_preparation_with_ready(app,id,binding,package,op,candidate,move||async move{
            tauri::async_runtime::spawn_blocking(move||stage_and_arm(staged_package,owner,target)).await.map_err(|_|"update_helper_start".to_owned())?
        }).await?;
        if ready.child.try_wait().map_err(|_|"update_helper_channel")?.is_some(){return Err("update_helper_exited".into());}
        let handoff=app.state::<Handoff>();let mut pending=handoff.0.lock().unwrap();
        if pending.is_some(){return Err("update_install_busy".into());}
        // All fallible channel work precedes this irreversible authority consume.
        app.state::<updates::Updates>().commit_preparation(app,op,candidate,binding,permit,true)?;
        *pending=Some(ready);drop(pending);
        app.exit(0);Ok(())
    }
    pub(crate) fn application_exited(app:&tauri::AppHandle){
        let Some(mut ready)=app.state::<Handoff>().0.lock().unwrap().take()else{return;};
        if !app.state::<update_coordinator::UpdateCoordinator>().update_exit_for(&update_coordinator::PrepareId(ready.plan.transaction.clone())){return;}
        // The directory must outlive the GUI and retain the old app/recovery log.
        if let Some(root)=ready.root.take(){let _=root.keep();}
        let marker=windows::hash(format!("{}:{}:{}",ready.plan.transaction,ready.digest,ready.plan.token).as_bytes());
        let authorized=write_private(&ready.plan.journal.with_file_name("commit-authorized"),marker.as_bytes());
        if authorized.is_err()||ready.send("commit").is_err(){let _=windows::persist_result(&ready.plan,&windows::result(&ready.plan,InstallState::InstallFailed,Some("update_helper_final_token_failed".into())));return;}
        ready.detached=true;ready.input.take();
    }
fn reconcile_one(app:&tauri::AppHandle,target:&Path,path:&Path,digest:&str,transaction:Option<&str>)->Result<(),String>{
    let plan=native::read_plan(path,digest,false)?;
    if target!=plan.target||transaction.is_some_and(|id|id!=plan.transaction){return Err("update_install_reconcile_invalid".into());}
    let marker=windows::hash(format!("{}:{}:{}",plan.transaction,digest,plan.token).as_bytes());
    if fs::read(plan.journal.with_file_name("commit-authorized")).map_err(|_|"update_install_reconcile_invalid")?!=marker.as_bytes(){return Err("update_install_reconcile_invalid".into());}
    let bytes=fs::read(&plan.journal).map_err(|_|"update_install_reconcile_invalid")?;
    if bytes.len()>32*1024{return Err("update_install_reconcile_invalid".into());}
    let result:InstallResult=serde_json::from_slice(&bytes).map_err(|_|"update_install_reconcile_invalid")?;
    if result.transaction!=plan.transaction||result.old_digest!=windows::hash(&serde_json::to_vec(&plan.old).map_err(|_|"update_install_reconcile_invalid")?)||result.new_digest!=windows::hash(&serde_json::to_vec(&plan.new).map_err(|_|"update_install_reconcile_invalid")?){return Err("update_install_reconcile_invalid".into());}
    let current=windows::inventory(target)?;let registry=native::registry()?;
    let version=native::installed_version(target,&registry)?;
    let recovery=if windows::inventory(&plan.backup).ok().as_ref()==Some(&plan.old){Some(plan.backup.to_string_lossy().into_owned())}else{None};
    let state=match result.state{
        InstallState::Installed if current==plan.new&&version==plan.new_version&&result.restart_count==1&&plan.journal.with_extension("restart-claim").is_file()=>updates::UpdateState::Installed,
        InstallState::RolledBack if current==plan.old&&registry==plan.registry&&version==plan.old_version=>updates::UpdateState::RolledBack,
        InstallState::RollbackFailed|InstallState::Installing if recovery.is_some()=>updates::UpdateState::RollbackFailed,
        InstallState::InstallFailed if current==plan.old||current==plan.new=>updates::UpdateState::InstallFailed,
        _=>return Err("update_install_reconcile_invalid".into()),
    };
    for role in ["leaf","leaf-mcp-adapter","leaf-update-helper"]{native::verify_binary(&target.join(format!("{role}.exe")),&version,role)?;}
    app.state::<updates::Updates>().reconcile_install_result(state,version,plan.new_version,result.error,if matches!(result.state,InstallState::RollbackFailed|InstallState::Installing|InstallState::InstallFailed){recovery}else{None})
}
pub(crate) fn reconcile_launch(app:&tauri::AppHandle){
    let Ok(executable)=std::env::current_exe().and_then(fs::canonicalize)else{return;};let Some(target)=executable.parent()else{return;};
    let args=std::env::args().skip(1).collect::<Vec<_>>();
    if args.first().is_some_and(|arg|arg=="--leaf-update-reconcile"){
        if args.len()!=4{return;}let deadline=std::time::Instant::now()+std::time::Duration::from_secs(5);
        loop{if reconcile_one(app,target,Path::new(&args[1]),&args[2],Some(&args[3])).is_ok()||std::time::Instant::now()>=deadline{break;}std::thread::sleep(std::time::Duration::from_millis(25));}return;
    }
    let Some(parent)=target.parent()else{return;};let Ok(entries)=fs::read_dir(parent)else{return;};let mut roots=entries.filter_map(Result::ok).filter(|entry|entry.file_name().to_string_lossy().starts_with(".leaf-update-")).take(32).map(|entry|entry.path()).collect::<Vec<_>>();
    roots.sort_by_key(|path|std::cmp::Reverse(fs::metadata(path).and_then(|metadata|metadata.modified()).ok()));
    for root in roots{if let Ok(digest)=fs::read_to_string(root.join("plan.sha256")){if digest.len()==64&&reconcile_one(app,target,&root.join("plan.json"),&digest,None).is_ok(){break;}}}
}
