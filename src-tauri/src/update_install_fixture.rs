//! Isolated native Mac fault adapter; never compiled into production installers.
use crate::update_install::macos::{MacInstallPlan,NativePlatform,OwnedProcess,Platform};
use std::{cell::Cell,path::Path};

#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub(crate) enum Fault { None,BeforeExchange,Exchange,PostCheck,SwapBack }
pub(crate) struct FaultPlatform {
    pub(crate) native:NativePlatform,pub(crate) fault:Fault,
    pub(crate) attempts:usize,pub(crate) exchanges:Cell<usize>,pub(crate) restarts:usize,
    pub(crate) observer:Option<(MacInstallPlan,String)>,
}
impl FaultPlatform {
    pub(crate) fn new(native:NativePlatform,fault:Fault)->Self{Self{native,fault,attempts:0,exchanges:Cell::new(0),restarts:0,observer:None}}
}
impl Platform for FaultPlatform {
    fn verify_signature(&self,path:&Path)->Result<(),String>{self.native.verify_signature(path)}
    fn preflight(&self,plan:&MacInstallPlan)->Result<(),String>{self.native.preflight(plan)}
    fn processes(&self)->Result<Vec<OwnedProcess>,String>{self.native.processes()}
    fn wait_for_exit(&mut self,pid:u32)->Result<(),String>{
        if let Some((plan,digest))=&self.observer{
            use std::io::Write;
            let mut out=std::io::stdout().lock();
            serde_json::to_writer(&mut out,&crate::update_install::macos::channel_message("waiting_gui",plan,digest)).map_err(|_|"update_fixture_channel")?;
            out.write_all(b"\n").and_then(|_|out.flush()).map_err(|_|"update_fixture_channel")?;
        }
        self.native.wait_for_exit(pid)
    }
    fn exchange(&mut self,target:&Path,staged:&Path)->Result<(),String>{
        self.attempts+=1;
        if (self.fault==Fault::BeforeExchange&&self.attempts==1)||(self.fault==Fault::SwapBack&&self.attempts==2){return Err("update_fixture_exchange_blocked".into());}
        if self.fault==Fault::Exchange&&self.attempts==1{
            // Exercise a real failed kernel exchange; never substitute per-file writes.
            self.native.exchange(target,&staged.join("missing-exchange-target"))?;
            return Err("update_fixture_exchange_unexpected".into());
        }
        self.native.exchange(target,staged)?;self.exchanges.set(self.exchanges.get()+1);Ok(())
    }
    fn sync_exchange(&self,target:&Path,staged:&Path)->Result<(),String>{
        self.native.sync_exchange(target,staged)?;
        if matches!(self.fault,Fault::PostCheck|Fault::SwapBack)&&self.exchanges.get()==1{return Err("update_fixture_post_check".into());}Ok(())
    }
    fn restart(&mut self,target:&Path)->Result<(),String>{self.native.restart(target)?;self.restarts+=1;Ok(())}
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(fault:Fault)->(tempfile::TempDir,std::path::PathBuf,std::path::PathBuf,FaultPlatform){
        let root=tempfile::tempdir().unwrap();let root_path=root.path().canonicalize().unwrap();
        let target=root_path.join("Target.app");let staged=root_path.join("Prepared.app");
        std::fs::create_dir(&target).unwrap();std::fs::create_dir(&staged).unwrap();
        std::fs::write(target.join("identity"),b"old").unwrap();std::fs::write(staged.join("identity"),b"new").unwrap();
        let platform=FaultPlatform::new(NativePlatform{gui_executable:target.join("Contents/MacOS/leaf"),
            plan_path:root_path.join("plan.json"),plan_digest:"0".repeat(64),transaction:"synthetic-native-fault".into()},fault);
        (root,target,staged,platform)
    }
    #[test]
    fn native_fault_before_exchange_retains_old_bytes(){
        let(_root,target,staged,mut platform)=fixture(Fault::BeforeExchange);
        assert!(platform.exchange(&target,&staged).is_err(),"the before-exchange fault must stop native mutation");
        assert_eq!(std::fs::read(target.join("identity")).unwrap(),b"old");assert_eq!(platform.exchanges.get(),0);
    }
    #[test]
    fn native_fault_exchange_retains_old_bytes(){
        let(_root,target,staged,mut platform)=fixture(Fault::Exchange);
        assert!(platform.exchange(&target,&staged).is_err(),"the exchange fault must fail without per-file fallback");
        assert_eq!(std::fs::read(target.join("identity")).unwrap(),b"old");assert_eq!(platform.exchanges.get(),0);
    }
    #[test]
    fn native_fault_post_check_allows_real_atomic_swap_back(){
        let(_root,target,staged,mut platform)=fixture(Fault::PostCheck);
        platform.exchange(&target,&staged).unwrap();assert_eq!(std::fs::read(target.join("identity")).unwrap(),b"new");
        assert!(platform.sync_exchange(&target,&staged).is_err(),"the post-exchange fault must trigger rollback");
        platform.exchange(&target,&staged).unwrap();platform.sync_exchange(&target,&staged).unwrap();
        assert_eq!(std::fs::read(target.join("identity")).unwrap(),b"old");assert_eq!(platform.exchanges.get(),2);
    }
    #[test]
    fn native_fault_swap_back_preserves_old_recovery_bytes(){
        let(_root,target,staged,mut platform)=fixture(Fault::SwapBack);
        platform.exchange(&target,&staged).unwrap();
        assert!(platform.sync_exchange(&target,&staged).is_err(),"the failed-swap-back case must first enter rollback");
        assert!(platform.exchange(&target,&staged).is_err());
        assert_eq!(std::fs::read(staged.join("identity")).unwrap(),b"old");assert_eq!(platform.exchanges.get(),1);
    }
}

#[cfg(feature="native-smoke")]
fn temporary_plan(plan:&MacInstallPlan)->Result<std::path::PathBuf,String>{
    use std::os::unix::fs::MetadataExt;
    let proposed=std::path::PathBuf::from(std::env::var_os("LEAF_UPDATE_PACKAGE_TEST_ROOT").ok_or("mac_fixture_root")?);
    let root=proposed.canonicalize().map_err(|_|"mac_fixture_root")?;
    let temp=std::env::temp_dir().canonicalize().map_err(|_|"mac_fixture_root")?;
    let metadata=std::fs::symlink_metadata(&proposed).map_err(|_|"mac_fixture_root")?;
    let owner=tempfile::tempfile().and_then(|file|file.metadata()).map_err(|_|"mac_fixture_root")?;
    if proposed!=root||!root.starts_with(&temp)||root==temp||metadata.file_type().is_symlink()||metadata.mode()&0o077!=0||metadata.uid()!=owner.uid()
        ||!root.file_name().is_some_and(|name|name.to_string_lossy().starts_with("leaf-update-test-")){return Err("mac_fixture_root".into());}
    let directory=plan.target.parent().ok_or("mac_fixture_target")?;
    if directory.parent()!=Some(root.join("cases").as_path())||plan.target!=directory.join("Target.app")
        ||plan.journal!=directory.join(".leaf-update-fixture/result.json")||plan.staged!=directory.join(".leaf-update-fixture/Prepared.app")
        ||plan.helper!=directory.join(".leaf-update-fixture/leaf-update-helper")||plan.gui_executable!=plan.target.join("Contents/MacOS/leaf")
        ||plan.target.canonicalize().ok().as_ref()!=Some(&plan.target)||plan.staged.canonicalize().ok().as_ref()!=Some(&plan.staged)
        ||plan.helper.canonicalize().ok().as_ref()!=Some(&plan.helper){return Err("mac_fixture_target".into());}
    Ok(directory.join(".leaf-update-fixture"))
}
#[cfg(feature="native-smoke")]
pub(crate) fn helper_main()->Result<(),String>{
    use std::io::Write;
    let args=std::env::args().skip(1).collect::<Vec<_>>();
    if args.len()!=4||args[0]!="--mac-update-fixture-helper"{return Err("mac_fixture_arguments".into());}
    let path=std::path::PathBuf::from(&args[1]);let digest=&args[2];
    let plan=crate::update_install::macos::read_plan(&path,digest)?;let root=temporary_plan(&plan)?;
    if path!=root.join("plan.json"){return Err("mac_fixture_plan".into());}
    let fault=match args[3].as_str(){"none"=>Fault::None,"before"=>Fault::BeforeExchange,"exchange"=>Fault::Exchange,"post"=>Fault::PostCheck,"rollback"=>Fault::SwapBack,_=>return Err("mac_fixture_fault".into())};
    let native=NativePlatform{gui_executable:plan.gui_executable.clone(),plan_path:path.clone(),plan_digest:digest.clone(),transaction:plan.transaction.clone()};
    let mut platform=FaultPlatform::new(native,fault);platform.observer=Some((plan.clone(),digest.clone()));
    let result=crate::update_install::macos::run_helper_protocol(&path,digest,&plan,&mut platform);
    // Exclusive evidence cannot overwrite a prior owner during a replay.
    use std::os::unix::fs::OpenOptionsExt;
    let mut evidence=std::fs::OpenOptions::new().create_new(true).write(true).mode(0o600).open(root.join("effects.json")).map_err(|_|"mac_fixture_effects")?;
    let value=serde_json::json!({"attempts":platform.attempts,"exchanges":platform.exchanges.get(),"restarts":platform.restarts});
    evidence.write_all(&serde_json::to_vec(&value).map_err(|_|"mac_fixture_effects")?).and_then(|_|evidence.sync_all()).map_err(|_|"mac_fixture_effects")?;
    let result=result?;
    if matches!(result.state,crate::update_install::macos::InstallState::Installed|crate::update_install::macos::InstallState::RolledBack){Ok(())}
    else{Err(result.error.unwrap_or_else(||"mac_fixture_failed".into()))}
}


#[cfg(feature="native-smoke")]
pub(crate) fn preservation_helper_main()->Result<(),String>{
    use std::{io::Write,os::unix::fs::{MetadataExt,OpenOptionsExt}};
    let args=std::env::args().skip(1).collect::<Vec<_>>();
    if args.len()!=4||args[0]!="--mac-update-preservation-helper"{return Err("preservation_helper_arguments".into());}
    let proposed=std::path::PathBuf::from(std::env::var_os("LEAF_UPDATE_PRESERVATION_ROOT").ok_or("preservation_root")?);
    let root=proposed.canonicalize().map_err(|_|"preservation_root")?;
    let temp=std::env::temp_dir().canonicalize().map_err(|_|"preservation_root")?;
    let metadata=std::fs::symlink_metadata(&proposed).map_err(|_|"preservation_root")?;
    let owner=tempfile::tempfile().and_then(|file|file.metadata()).map_err(|_|"preservation_root")?;
    if proposed!=root||!root.starts_with(&temp)||root==temp||!metadata.is_dir()||metadata.file_type().is_symlink()
        ||metadata.uid()!=owner.uid()||metadata.mode()&0o077!=0
        ||!root.file_name().is_some_and(|name|name.to_string_lossy().starts_with("leaf-update-test-")){return Err("preservation_root".into());}
    let path=std::path::PathBuf::from(&args[1]);let digest=&args[2];let plan=crate::update_install::macos::read_plan(&path,digest)?;
    let operation=path.parent().ok_or("preservation_plan")?;
    if plan.target!=root.join("installed/Leaf.app")||operation.parent()!=Some(root.join("installed").as_path())
        ||!operation.file_name().is_some_and(|name|name.to_string_lossy().starts_with(".leaf-update-"))
        ||path!=operation.join("plan.json")||plan.staged!=operation.join("Prepared.app")||plan.helper!=operation.join("leaf-update-helper")
        ||plan.journal!=operation.join("result.json")||plan.gui_executable!=plan.target.join("Contents/MacOS/leaf")
        ||plan.target.canonicalize().ok().as_ref()!=Some(&plan.target)||plan.staged.canonicalize().ok().as_ref()!=Some(&plan.staged)
        ||plan.helper.canonicalize().ok().as_ref()!=Some(&plan.helper){return Err("preservation_plan".into());}
    let fault=match args[3].as_str(){"success"=>Fault::None,"rollback"=>Fault::PostCheck,_=>return Err("preservation_scenario".into())};
    let native=NativePlatform{gui_executable:plan.gui_executable.clone(),plan_path:path.clone(),plan_digest:digest.clone(),transaction:plan.transaction.clone()};
    let mut platform=FaultPlatform::new(native,fault);
    let outcome=crate::update_install::macos::run_helper_protocol(&path,digest,&plan,&mut platform);
    let mut evidence=std::fs::OpenOptions::new().create_new(true).write(true).mode(0o600).open(operation.join("preservation-effects.json")).map_err(|_|"preservation_effects")?;
    evidence.write_all(&serde_json::to_vec(&serde_json::json!({"attempts":platform.attempts,"exchanges":platform.exchanges.get(),"restarts":platform.restarts})).map_err(|_|"preservation_effects")?)
        .and_then(|_|evidence.sync_all()).map_err(|_|"preservation_effects")?;
    let result=outcome?;
    if matches!(result.state,crate::update_install::macos::InstallState::Installed|crate::update_install::macos::InstallState::RolledBack){Ok(())}else{Err("preservation_install_failed".into())}
}
