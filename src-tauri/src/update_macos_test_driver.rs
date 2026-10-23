//! Temporary TEST-ONLY signed Mac bundle matrix; no Tauri windows or daily data.
use crate::update_install::macos::{self,BundleIdentity,InstallResult,InstallState,MacInstallPlan,NativePlatform,Platform};
use crate::update_install_fixture::Fault;
use std::{fs,io::{BufRead,Read,Write},path::{Path,PathBuf},process::{Child,ChildStdin,Stdio},sync::mpsc,time::{Duration,Instant}};
use std::os::unix::fs::{MetadataExt,OpenOptionsExt};
use serde_json::{json,Value};

struct Owned(Child);
impl Drop for Owned{fn drop(&mut self){let _=self.0.kill();let _=self.0.wait();}}
fn require(ok:bool,code:&str)->Result<(),String>{if ok{Ok(())}else{Err(code.into())}}
fn write(path:&Path,bytes:&[u8])->Result<(),String>{
    let mut file=fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path).map_err(|_|"mac_fixture_write")?;
    file.write_all(bytes).and_then(|_|file.sync_all()).map_err(|_|"mac_fixture_write".into())
}
fn copy(from:&Path,to:&Path)->Result<(),String>{
    let status=std::process::Command::new("/usr/bin/ditto").arg(from).arg(to).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_|"mac_fixture_copy")?;
    require(status.success(),"mac_fixture_copy")
}
fn held(path:&Path)->Result<Owned,String>{
    let mut child=std::process::Command::new(path).arg("--hold").stdout(Stdio::piped()).stdin(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_|"mac_fixture_process")?;
    let stdout=child.stdout.take().ok_or("mac_fixture_process")?;let child=Owned(child);
    let(sender,receiver)=mpsc::sync_channel(1);
    std::thread::spawn(move||{let mut text=String::new();let read=std::io::BufReader::new(stdout).take(1024).read_line(&mut text);let _=sender.send(read.is_ok()&&text=="fixture-ready\n");});
    require(receiver.recv_timeout(Duration::from_secs(10)).unwrap_or(false),"mac_fixture_process_ready")?;Ok(child)
}
fn wait(child:&mut Child)->Result<std::process::ExitStatus,String>{
    let deadline=Instant::now()+Duration::from_secs(40);
    loop{if let Some(status)=child.try_wait().map_err(|_|"mac_fixture_helper_wait")?{return Ok(status);}
        if Instant::now()>=deadline{return Err("mac_fixture_helper_timeout".into());}
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn expected(package:&crate::update_package::VerifiedPackage)->Result<BundleIdentity,String>{
    let metadata=package.authenticated_metadata();let prefix=format!("{}/",metadata.root);let mut inventory=std::collections::BTreeMap::new();
    for item in &metadata.inventory{
        if item.path==metadata.root{continue;}
        let name=item.path.strip_prefix(&prefix).ok_or("mac_fixture_inventory")?;
        let digest=match item.kind.as_str(){"directory"=>"directory".into(),"symlink"=>format!("link:{}",item.target.as_deref().ok_or("mac_fixture_inventory")?),"file"=>item.sha256.clone().ok_or("mac_fixture_inventory")?,_=>return Err("mac_fixture_inventory".into())};
        require(inventory.insert(name.into(),digest).is_none(),"mac_fixture_inventory")?;
    }
    Ok(BundleIdentity{identifier:metadata.identifier.clone(),version:metadata.version.clone(),arch:metadata.arch.clone(),inventory})
}
struct Fixture{root:PathBuf,plan:MacInstallPlan,path:PathBuf,digest:String,gui:Option<Owned>,profile:Vec<(PathBuf,String)>}
impl Fixture{
    fn new(root:&Path,name:&str,package:&crate::update_package::VerifiedPackage)->Result<Self,String>{
        let directory=root.join("cases").join(name);fs::create_dir_all(&directory).map_err(|_|"mac_fixture_root")?;
        use std::os::unix::fs::PermissionsExt;fs::set_permissions(&directory,fs::Permissions::from_mode(0o700)).map_err(|_|"mac_fixture_root")?;
        let directory=directory.canonicalize().map_err(|_|"mac_fixture_root")?;
        let operation=directory.join(".leaf-update-fixture");fs::create_dir(&operation).map_err(|_|"mac_fixture_root")?;fs::set_permissions(&operation,fs::Permissions::from_mode(0o700)).map_err(|_|"mac_fixture_root")?;
        let target=directory.join("Target.app");copy(&root.join("Old.app"),&target)?;
        let staged=operation.join("Prepared.app");copy(&package.staged_root(),&staged)?;
        let helper=operation.join("leaf-update-helper");fs::copy(staged.join("Contents/MacOS/leaf-update-helper"),&helper).map_err(|_|"mac_fixture_copy")?;
        let gui=held(&target.join("Contents/MacOS/leaf"))?;let metadata=fs::metadata(&target).map_err(|_|"mac_fixture_target")?;
        let mut random=[0u8;32];getrandom::fill(&mut random).map_err(|_|"mac_fixture_entropy")?;
        let plan=MacInstallPlan{transaction:format!("synthetic-{name}"),target:target.clone(),staged,helper,journal:operation.join("result.json"),gui_pid:gui.0.id(),
            gui_executable:target.join("Contents/MacOS/leaf"),target_anchor:(metadata.dev(),metadata.ino()),package_digest:package.digest().into(),
            token:random.iter().map(|byte|format!("{byte:02x}")).collect(),created_unix:std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|"mac_fixture_clock")?.as_secs(),
            old:macos::capture_identity(&target)?,new:expected(package)?};
        let path=operation.join("plan.json");let bytes=serde_json::to_vec(&plan).map_err(|_|"mac_fixture_plan")?;let digest=macos::hash(&bytes);write(&path,&bytes)?;
        let mut profile=Vec::new();for name in ["Application Support/preferences.json","WebView/storage.bin","synthetic-profile/connection.json"]{
            let path=directory.join(name);fs::create_dir_all(path.parent().ok_or("mac_fixture_profile")?).map_err(|_|"mac_fixture_profile")?;
            write(&path,format!("Synthetic immutable sentinel {name}").as_bytes())?;profile.push((path.clone(),macos::file_hash(&path)?));
        }
        Ok(Self{root:directory,plan,path,digest,gui:Some(gui),profile})
    }
    fn platform(&self)->NativePlatform{NativePlatform{gui_executable:self.plan.gui_executable.clone(),plan_path:self.path.clone(),plan_digest:self.digest.clone(),transaction:self.plan.transaction.clone()}}
    fn unchanged(&self)->Result<(),String>{for(path,before)in &self.profile{require(macos::file_hash(path)?==*before,"mac_fixture_profile_changed")?;}Ok(())}
    fn old_at(&self,path:&Path)->bool{macos::validate_bundle(path,&self.plan.old,&self.platform()).is_ok()}
}
struct Helper{child:Owned,input:Option<ChildStdin>,messages:mpsc::Receiver<Option<macos::ChannelMessage>>}
impl Helper{
    fn start(f:&Fixture,fault:Fault)->Result<Self,String>{
        macos::check_ready(&f.plan,&f.platform())?;
        Self::start_checked(f,fault)
    }
    fn start_checked(f:&Fixture,fault:Fault)->Result<Self,String>{
        let mode=match fault{Fault::None=>"none",Fault::BeforeExchange=>"before",Fault::Exchange=>"exchange",Fault::PostCheck=>"post",Fault::SwapBack=>"rollback"};
        let mut child=std::process::Command::new(&f.plan.helper).args(["--mac-update-fixture-helper"]).arg(&f.path).arg(&f.digest).arg(mode)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().map_err(|_|"mac_fixture_helper")?;
        let input=child.stdin.take();let output=child.stdout.take().ok_or("mac_fixture_helper")?;
        let(sender,messages)=mpsc::sync_channel(4);
        std::thread::spawn(move||{let mut reader=std::io::BufReader::new(output);for _ in 0..4{
            let mut line=String::new();let read=(&mut reader).take(8193).read_line(&mut line);
            let message=if read.is_ok()&&line.len()<=8192&&line.ends_with('\n'){serde_json::from_str(&line).ok()}else{None};
            let valid=message.is_some();let _=sender.send(message);if !valid{break;}
        }});
        Ok(Self{child:Owned(child),input,messages})
    }
    fn receive(&self,f:&Fixture,kind:&str)->Result<(),String>{
        let message=self.messages.recv_timeout(Duration::from_secs(35)).map_err(|_|"mac_fixture_helper_message")?.ok_or("mac_fixture_helper_message")?;
        require(macos::valid_message(&message,kind,&f.plan,&f.digest),"mac_fixture_helper_binding")
    }
    fn send(&mut self,f:&Fixture,kind:&str,bad:bool)->Result<(),String>{
        let mut message=macos::channel_message(kind,&f.plan,&f.digest);if bad{message.token="wrong-token".into();}
        let input=self.input.as_mut().ok_or("mac_fixture_helper_channel")?;
        serde_json::to_writer(&mut *input,&message).map_err(|_|"mac_fixture_helper_channel")?;
        input.write_all(b"\n").and_then(|_|input.flush()).map_err(|_|"mac_fixture_helper_channel".into())
    }
}
fn result(f:&Fixture)->Result<InstallResult,String>{serde_json::from_slice(&fs::read(&f.plan.journal).map_err(|_|"mac_fixture_result")?).map_err(|_|"mac_fixture_result".into())}
fn effects(f:&Fixture)->Result<Value,String>{serde_json::from_slice(&fs::read(f.root.join(".leaf-update-fixture/effects.json")).map_err(|_|"mac_fixture_effects")?).map_err(|_|"mac_fixture_effects".into())}
fn run_transaction(f:&mut Fixture,fault:Fault,authority:&str)->Result<Value,String>{
    let mut helper=Helper::start(f,fault)?;helper.receive(f,"ready")?;helper.send(f,"arm",false)?;helper.receive(f,"armed")?;
    require(f.old_at(&f.plan.target)&&!f.plan.journal.exists(),"mac_fixture_arm_mutated")?;
    if authority=="eof"{helper.input.take();}
    else{helper.send(f,"commit",authority=="bad")?;if authority!="bad"{
        helper.receive(f,"waiting_gui")?;
        require(f.gui.as_mut().is_some_and(|gui|gui.0.try_wait().ok().flatten().is_none())&&f.old_at(&f.plan.target)&&!f.plan.journal.exists(),"mac_fixture_did_not_wait_for_gui")?;
        f.gui.take(); // Only this fixture-owned synthetic process is terminated/reaped.
    }}
    let status=wait(&mut helper.child.0)?;let saved=result(f)?;let effect=effects(f)?;f.unchanged()?;
    let(expected,swaps,restarts)=match(authority,fault){
        ("eof"|"bad",_)=>(InstallState::InstallFailed,0,0),
        (_,Fault::BeforeExchange|Fault::Exchange)=>(InstallState::InstallFailed,0,0),
        (_,Fault::PostCheck)=>(InstallState::RolledBack,2,0),
        (_,Fault::SwapBack)=>(InstallState::RollbackFailed,1,0),
        _=>(InstallState::Installed,1,1)};
    require(saved.state==expected&&saved.restart_count==restarts&&effect["exchanges"]==swaps&&effect["restarts"]==restarts,"mac_fixture_result_mismatch")?;
    require(status.success()==matches!(expected,InstallState::Installed|InstallState::RolledBack),"mac_fixture_helper_exit")?;
    require(f.old_at(&saved.old_location),"mac_fixture_old_recovery_lost")?;
    if restarts==1{
        let receipt=f.root.join(".leaf-update-fixture/restart-receipt.json");let deadline=Instant::now()+Duration::from_secs(10);
        loop{if receipt.exists(){break;}if Instant::now()>=deadline{return Err("mac_fixture_restart_receipt".into());}std::thread::sleep(Duration::from_millis(10));}
        let receipt:Value=serde_json::from_slice(&fs::read(receipt).map_err(|_|"mac_fixture_restart_receipt")?).map_err(|_|"mac_fixture_restart_receipt")?;
        require(receipt["version"]==f.plan.new.version&&receipt["role"]=="leaf"&&receipt["restart"]==1,"mac_fixture_restart_receipt")?;
        macos::validate_bundle(&f.plan.target,&f.plan.new,&f.platform())?;
    }
    Ok(json!({"state":saved.state,"exchanges":swaps,"restart_count":restarts,"old_recovery_verified":true,"profile_hashes_unchanged":true,
        "old_bundle_digest":saved.old_bundle_digest,"new_bundle_digest":saved.new_bundle_digest,"durable_result":true,"helper_ready_arm_observed":true,"actual_effects":effect,
        "gui_wait_observed":authority=="commit","synthetic_gui_termination":authority=="commit","actual_leaf_gui":false}))
}
fn blocked_occupancy(f:&Fixture,role:&str)->Result<Value,String>{
    let mut owned=held(&f.plan.target.join("Contents/MacOS").join(role))?;
    require(f.platform().prove_unrelated_process(owned.0.id()).err().as_deref()==Some("update_install_target_occupied"),"mac_fixture_matching_kernel_uuid_escaped")?;
    require(f.platform().prove_unrelated_signed_process(owned.0.id()).err().as_deref()==Some("update_install_target_occupied"),"mac_fixture_matching_kernel_cdhash_escaped")?;
    let error=macos::check_ready(&f.plan,&f.platform()).unwrap_err();
    require(error=="update_install_target_occupied"&&owned.0.try_wait().map_err(|_|"mac_fixture_process")?.is_none(),"mac_fixture_occupancy")?;
    require(f.old_at(&f.plan.target)&&!f.plan.journal.exists(),"mac_fixture_occupancy_mutated")?;f.unchanged()?;
    Ok(json!({"state":"rejected","error":error,"exchanges":0,"restart_count":0,"owned_process_still_running":true,"actual_kernel_uuid_match_refused":true,"actual_kernel_cdhash_match_refused":true,"profile_hashes_unchanged":true,"old_recovery_verified":true}))
}
fn negative(f:&mut Fixture,kind:&str)->Result<Value,String>{
    match kind{
        "wrong_bundle_identifier"=>f.plan.new.identifier="synthetic.invalid".into(),
        "wrong_bundle_version"=>f.plan.new.version="99.0.0".into(),
        "wrong_bundle_architecture"=>f.plan.new.arch=if f.plan.new.arch=="aarch64"{"x86_64"}else{"aarch64"}.into(),
        "bad_platform_signature"=>{
            fs::write(f.plan.staged.join("Contents/Resources/data.txt"),b"synthetic signed resource tamper").map_err(|_|"mac_fixture_tamper")?;
            require(f.platform().verify_signature(&f.plan.staged).is_err(),"mac_fixture_signature_not_rejected")?;
        },
        "missing_helper"=>fs::remove_file(f.plan.staged.join("Contents/MacOS/leaf-update-helper")).map_err(|_|"mac_fixture_tamper")?,
        "missing_adapter"=>fs::remove_file(f.plan.staged.join("Contents/MacOS/leaf-mcp-adapter")).map_err(|_|"mac_fixture_tamper")?,
        "changed_resource_inventory"=>fs::write(f.plan.staged.join("Contents/Resources/data.txt"),b"synthetic changed bytes").map_err(|_|"mac_fixture_tamper")?,
        "changed_external_helper"=>{fs::OpenOptions::new().append(true).open(&f.plan.helper).and_then(|mut file|file.write_all(b"synthetic tamper")).map_err(|_|"mac_fixture_tamper")?;},
        "changed_target_anchor"=>{
            let retained=f.root.join("RetainedOld.app");fs::rename(&f.plan.target,&retained).map_err(|_|"mac_fixture_tamper")?;copy(&retained,&f.plan.target)?;
        },
        _=>return Err("mac_fixture_negative_case".into()),
    }
    require(macos::check_ready(&f.plan,&f.platform()).is_err(),"mac_fixture_negative_accepted")?;
    require(f.old_at(&f.plan.target)&&!f.plan.journal.exists(),"mac_fixture_negative_mutated")?;f.unchanged()?;
    Ok(json!({"state":"rejected","exchanges":0,"restart_count":0,"old_recovery_verified":true,"profile_hashes_unchanged":true,"helper_executed":false}))
}
pub(crate) fn run()->Result<(),String>{
    let args=std::env::args().skip(1).collect::<Vec<_>>();require(args==["--mac-update-fixture"],"mac_fixture_arguments")?;
    let package=crate::update_package::fixture_verify([73;16])?;
    let root=PathBuf::from(std::env::var_os("LEAF_UPDATE_PACKAGE_TEST_ROOT").ok_or("mac_fixture_root")?).canonicalize().map_err(|_|"mac_fixture_root")?;
    let mut scenarios=Vec::new();let mut current=String::new();
    let cases=[("helper_wait_gui_exit_success",Fault::None,"commit"),("before_exchange_failure",Fault::BeforeExchange,"commit"),
        ("exchange_failure",Fault::Exchange,"commit"),("post_check_atomic_rollback",Fault::PostCheck,"commit"),
        ("swap_back_failure_recovery",Fault::SwapBack,"commit"),("invalid_commit_token",Fault::None,"bad"),("armed_eof_no_install",Fault::None,"eof")];
    let work=(||->Result<(),String>{
        for(name,fault,authority)in cases{
            current=name.into();let mut f=Fixture::new(&root,name,&package)?;let details=run_transaction(&mut f,fault,authority)?;
            scenarios.push(json!({"name":name,"pass":true,"details":details}));
        }
        for(name,role)in [("owned_leaf_occupancy","leaf"),("owned_adapter_occupancy","leaf-mcp-adapter"),("owned_helper_occupancy","leaf-update-helper")]{
            current=name.into();let f=Fixture::new(&root,name,&package)?;let details=blocked_occupancy(&f,role)?;scenarios.push(json!({"name":name,"pass":true,"details":details}));
        }
        current="same_name_unrelated_preserved".into();{
            let mut f=Fixture::new(&root,&current,&package)?;let unrelated=f.root.join("unrelated");fs::create_dir(&unrelated).map_err(|_|"mac_fixture_process")?;
            let path=unrelated.join("leaf");fs::copy(f.plan.staged.join("Contents/MacOS/leaf"),&path).map_err(|_|"mac_fixture_process")?;let mut process=held(&path)?;
            f.platform().prove_unrelated_process(process.0.id())?;
            f.platform().prove_unrelated_signed_process(process.0.id())?;
            let mut details=run_transaction(&mut f,Fault::None,"commit")?;
            require(process.0.try_wait().map_err(|_|"mac_fixture_process")?.is_none(),"mac_fixture_unrelated_stopped")?;
            details["unrelated_process_untouched"]=json!(true);details["actual_kernel_uuid_difference_proved"]=json!(true);details["actual_kernel_cdhash_difference_proved"]=json!(true);scenarios.push(json!({"name":current,"pass":true,"details":details}));
        }
        for name in ["wrong_bundle_identifier","wrong_bundle_version","wrong_bundle_architecture","bad_platform_signature","missing_helper","missing_adapter","changed_resource_inventory","changed_external_helper","changed_target_anchor"]{
            current=name.into();let mut f=Fixture::new(&root,name,&package)?;let details=negative(&mut f,name)?;scenarios.push(json!({"name":name,"pass":true,"details":details}));
        }
        current="replay_no_second_restart".into();{
            let mut f=Fixture::new(&root,&current,&package)?;let mut details=run_transaction(&mut f,Fault::None,"commit")?;
            let before=macos::file_hash(&f.plan.journal)?;let receipt=f.root.join(".leaf-update-fixture/restart-receipt.json");let receipt_hash=macos::file_hash(&receipt)?;
            f.platform().verify_signature(&f.plan.helper)?;
            let mut replay=Helper::start_checked(&f,Fault::None)?;require(!wait(&mut replay.child.0)?.success(),"mac_fixture_replay_succeeded")?;
            require(macos::file_hash(&f.plan.journal)?==before&&macos::file_hash(&receipt)?==receipt_hash,"mac_fixture_replay_overwrote_result")?;
            details["independent_helper_replay_rejected"]=json!(true);scenarios.push(json!({"name":current,"pass":true,"details":details}));
        }
        current="occupancy_after_ready".into();{
            let mut f=Fixture::new(&root,&current,&package)?;let mut helper=Helper::start(&f,Fault::None)?;helper.receive(&f,"ready")?;
            helper.send(&f,"arm",false)?;helper.receive(&f,"armed")?;
            let mut blocker=held(&f.plan.target.join("Contents/MacOS/leaf-mcp-adapter"))?;
            helper.send(&f,"commit",false)?;
            require(!wait(&mut helper.child.0)?.success(),"mac_fixture_late_occupancy_accepted")?;
            let saved=result(&f)?;let effect=effects(&f)?;
            require(saved.state==InstallState::InstallFailed&&saved.error.as_deref()==Some("update_install_target_occupied")&&effect["exchanges"]==0&&saved.restart_count==0
                &&f.old_at(&f.plan.target)&&blocker.0.try_wait().map_err(|_|"mac_fixture_process")?.is_none(),"mac_fixture_late_occupancy_mutated")?;
            f.unchanged()?;scenarios.push(json!({"name":current,"pass":true,"details":{"state":saved.state,"exchanges":0,"restart_count":0,"old_recovery_verified":true,
                "profile_hashes_unchanged":true,"owned_process_still_running":true,"helper_ready_arm_observed":true,"durable_result":true,"actual_effects":effect}}));
        }
        Ok(())
    })();
    let report=json!({"pass":work.is_ok(),"error":work.as_ref().err(),"current_case":current,"layer":"actual-native-filesystem","tracer":"mac-atomic-helper",
        "synthetic_app_bundle":true,"actual_leaf_gui":false,"installed_daily_app":false,"profile_sentinels_only":true,"executed":scenarios.len(),"scenarios":scenarios});
    write(&root.join("mac-result.json"),&serde_json::to_vec_pretty(&report).map_err(|_|"mac_fixture_report")?)?;
    work
}
