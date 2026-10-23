//! Windows installer supervisor. The worker and recovery material live outside
//! the installation; no user profile data is included in this transaction.
use std::{collections::BTreeMap,fs,io::{Read,Write},path::{Path,PathBuf}};
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};

pub type Inventory=BTreeMap<String,String>;
pub fn hash(bytes:&[u8])->String{format!("{:x}",Sha256::digest(bytes))}
pub fn file_hash(path:&Path)->Result<String,String>{
    let mut file=fs::File::open(path).map_err(|_|"update_install_read")?;
    let mut hash=Sha256::new();let mut bytes=[0u8;65536];
    loop{let n=file.read(&mut bytes).map_err(|_|"update_install_read")?;if n==0{break;}hash.update(&bytes[..n]);}
    Ok(format!("{:x}",hash.finalize()))
}
pub fn inventory(root:&Path)->Result<Inventory,String>{
    let mut pending=vec![root.to_path_buf()];let mut result=Inventory::new();let mut total=0u64;
    while let Some(dir)=pending.pop(){for entry in fs::read_dir(dir).map_err(|_|"update_install_read")?{
        let path=entry.map_err(|_|"update_install_read")?.path();let metadata=fs::symlink_metadata(&path).map_err(|_|"update_install_read")?;
        #[cfg(windows)] {use std::os::windows::fs::MetadataExt;if metadata.file_attributes()&0x400!=0{return Err("update_install_reparse_point".into());}}
        let name=path.strip_prefix(root).map_err(|_|"update_install_path")?.to_str().ok_or("update_install_path")?.replace('\\',"/");
        if name.split('/').any(|part|part.is_empty()||part==".."||part.contains(':'))||name.len()>4096||name.split('/').count()>32||result.len()>=20_000{return Err("update_install_inventory".into());}
        let value=if metadata.file_type().is_symlink(){return Err("update_install_reparse_point".into());}
            else if metadata.is_dir(){pending.push(path);"directory".into()}
            else if metadata.is_file(){total=total.checked_add(metadata.len()).filter(|v|*v<=2*1024*1024*1024).ok_or("update_install_capacity")?;file_hash(&path)?}
            else{return Err("update_install_inventory".into());};
        // Case aliases are rejected even in Unix fixtures.
        if result.keys().any(|key|key.eq_ignore_ascii_case(&name)){return Err("update_install_path_alias".into());}
        result.insert(name,value);
    }}Ok(result)
}
pub fn copy_tree(from:&Path,to:&Path,expected:&Inventory)->Result<(),String>{
    if inventory(from)?!=*expected||to.exists(){return Err("update_install_backup_changed".into());}
    fs::create_dir(to).map_err(|_|"update_install_backup")?;
    for(name,value)in expected{
        let path=to.join(name);
        if value=="directory"{fs::create_dir_all(path).map_err(|_|"update_install_backup")?;}
        else{if let Some(parent)=path.parent(){fs::create_dir_all(parent).map_err(|_|"update_install_backup")?;}
            fs::copy(from.join(name),&path).map_err(|_|"update_install_backup")?;
            fs::OpenOptions::new().write(true).open(path).and_then(|file|file.sync_all()).map_err(|_|"update_install_backup")?;
        }
    }
    if inventory(to)?!=*expected{return Err("update_install_backup_changed".into());}Ok(())
}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
pub struct RegistryValue{pub kind:u32,pub data:Vec<u8>}
// A tree snapshot includes every value under a Leaf-owned key. Extension keys
// are shared, so their exact two installer-owned values are captured separately.
pub type Registry=BTreeMap<String,Option<BTreeMap<String,RegistryValue>>>;
#[derive(Clone,Debug,Serialize,Deserialize)]
pub struct WindowsInstallPlan{
    pub transaction:String,pub target:PathBuf,pub staged:PathBuf,pub helper:PathBuf,
    pub backup:PathBuf,pub journal:PathBuf,pub gui_pid:u32,pub gui_executable:PathBuf,
    pub target_anchor:(u64,[u8;16]),pub installer_digest:String,pub package_digest:String,pub token:String,pub created_unix:u64,
    pub old_version:String,pub new_version:String,pub old:Inventory,pub new:Inventory,
    pub registry:Registry,
}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
#[serde(rename_all="snake_case")]
pub enum InstallState{Installing,Installed,InstallFailed,RolledBack,RollbackFailed}
#[derive(Clone,Debug,Serialize,Deserialize)]
pub struct InstallResult{pub transaction:String,pub state:InstallState,pub old_digest:String,pub new_digest:String,pub restart_count:u32,pub error:Option<String>}
pub fn persist(path:&Path,bytes:&[u8])->Result<(),String>{
    let mut file=tempfile::NamedTempFile::new_in(path.parent().ok_or("update_install_journal")?).map_err(|_|"update_install_journal")?;
    file.write_all(bytes).and_then(|_|file.as_file().sync_all()).map_err(|_|"update_install_journal")?;
    file.persist(path).map_err(|_|"update_install_journal")?;Ok(())
}
pub fn persist_result(plan:&WindowsInstallPlan,result:&InstallResult)->Result<(),String>{persist(&plan.journal,&serde_json::to_vec(result).map_err(|_|"update_install_journal")?)}
pub fn result(plan:&WindowsInstallPlan,state:InstallState,error:Option<String>)->InstallResult{
    InstallResult{transaction:plan.transaction.clone(),state,old_digest:hash(&serde_json::to_vec(&plan.old).unwrap()),new_digest:hash(&serde_json::to_vec(&plan.new).unwrap()),restart_count:0,error}
}
pub trait Platform{
    fn ready(&mut self,plan:&WindowsInstallPlan,allow_gui:bool)->Result<(),String>;
    fn wait_gui(&mut self,plan:&WindowsInstallPlan)->Result<(),String>;
    fn registry(&self)->Result<Registry,String>;
    fn restore_registry(&mut self,registry:&Registry)->Result<(),String>;
    fn installer(&mut self,plan:&WindowsInstallPlan)->Result<(),String>;
    fn verify_installed(&self,plan:&WindowsInstallPlan)->Result<(),String>;
    fn restart(&mut self,plan:&WindowsInstallPlan)->Result<(),String>;
}
pub fn check_ready(plan:&WindowsInstallPlan,platform:&mut dyn Platform)->Result<(),String>{
    let root=plan.journal.parent().ok_or("update_install_plan")?;
    if plan.target.canonicalize().ok().as_deref()!=Some(&plan.target)||plan.staged.canonicalize().ok().as_deref()!=Some(&plan.staged)
        ||plan.target.starts_with(root)||root.starts_with(&plan.target)||plan.backup!=root.join("Previous")||plan.staged!=root.join("Prepared")
        ||plan.helper!=root.join("leaf-update-helper.exe")||plan.gui_executable!=plan.target.join("leaf.exe")
        ||plan.transaction.is_empty()||plan.token.len()!=64||plan.package_digest.len()!=64
        ||semver::Version::parse(&plan.new_version).map_err(|_|"update_install_version")?<=semver::Version::parse(&plan.old_version).map_err(|_|"update_install_version")?
        ||inventory(&plan.target)?!=plan.old{return Err("update_install_plan".into());}
    let mut staged=inventory(&plan.staged)?;if staged.remove(".leaf-update-installer.exe").as_ref()!=Some(&plan.installer_digest){return Err("update_install_installer_changed".into());}
    if staged!=plan.new||file_hash(&plan.helper)?!=*plan.new.get("leaf-update-helper.exe").ok_or("update_install_helper_missing")?||platform.registry()?!=plan.registry{return Err("update_install_binding_changed".into());}
    platform.ready(plan,true)
}
/// Backups and their durable manifest precede *every* installer mutation. A
/// crash retains the Installing journal for next-launch recovery reporting.
pub fn install(plan:&WindowsInstallPlan,platform:&mut dyn Platform)->InstallResult{
    let mut output=result(plan,InstallState::InstallFailed,None);
    let before=(||{
        check_ready(plan,platform)?;platform.wait_gui(plan)?;platform.ready(plan,false)?;
        if platform.registry()?!=plan.registry{return Err("update_install_registry_changed".into());}
        copy_tree(&plan.target,&plan.backup,&plan.old)?;
        persist(&plan.journal.with_file_name("registry-backup.json"),&serde_json::to_vec(&plan.registry).map_err(|_|"update_install_backup")?)?;
        persist(&plan.journal.with_file_name("backup-ready"),hash(&serde_json::to_vec(plan).map_err(|_|"update_install_backup")?).as_bytes())?;
        persist_result(plan,&result(plan,InstallState::Installing,None))
    })();
    if let Err(code)=before{output.error=Some(code);let _=persist_result(plan,&output);return output;}
    let installed=platform.installer(plan).and_then(|()|{
        if inventory(&plan.target)?!=plan.new{return Err("update_install_payload_mismatch".into());}
        platform.verify_installed(plan)
    });
    if let Err(code)=installed{
        output.error=Some(code);
        let restored=(||{
            // Do not follow any link/reparse point created by a failed installer.
            let _=inventory(&plan.target)?;
            if inventory(&plan.backup)?!=plan.old{return Err("update_install_backup_changed".into());}
            fs::remove_dir_all(&plan.target).map_err(|_|"update_install_restore")?;
            copy_tree(&plan.backup,&plan.target,&plan.old)?;platform.restore_registry(&plan.registry)?;
            if inventory(&plan.target)?!=plan.old||platform.registry()?!=plan.registry{return Err("update_install_restore_mismatch".into());}Ok(())
        })();
        output.state=if restored.is_ok(){InstallState::RolledBack}else{InstallState::RollbackFailed};
        if let Err(code)=restored{output.error=Some(code);}
    }else{output.state=InstallState::Installed;}
    if persist_result(plan,&output).is_err(){return result(plan,InstallState::RollbackFailed,Some("update_install_journal".into()));}
    if matches!(output.state,InstallState::Installed|InstallState::RolledBack){
        let claim=plan.journal.with_extension("restart-claim");
        if fs::OpenOptions::new().write(true).create_new(true).open(claim).and_then(|file|file.sync_all()).is_ok(){
            match platform.restart(plan){Ok(())=>output.restart_count=1,Err(code)=>{output.error=Some(code);output.state=InstallState::InstallFailed;}}
            let _=persist_result(plan,&output);
        }
    }output
}

#[cfg(target_os="windows")]
#[path="update_install_windows_native.rs"]
pub mod native;
#[cfg(target_os="windows")]
pub use native::helper_main;

#[cfg(test)]
mod tests{
    use super::*;
    struct Mock{registry:Registry,fault:Option<&'static str>,restarts:u32,block:bool,restore_bad:bool}
    impl Platform for Mock{
        fn ready(&mut self,_:&WindowsInstallPlan,_:bool)->Result<(),String>{if self.block{Err("occupied".into())}else{Ok(())}}
        fn wait_gui(&mut self,_:&WindowsInstallPlan)->Result<(),String>{Ok(())}
        fn registry(&self)->Result<Registry,String>{Ok(self.registry.clone())}
        fn restore_registry(&mut self,registry:&Registry)->Result<(),String>{if self.restore_bad{return Err("restore_denied".into());}self.registry=registry.clone();Ok(())}
        fn installer(&mut self,p:&WindowsInstallPlan)->Result<(),String>{
            assert_eq!(inventory(&p.backup)?,p.old);assert!(p.journal.with_file_name("backup-ready").exists());
            fs::remove_file(p.target.join("leaf.exe")).unwrap();if self.fault==Some("after_delete"){return Err("fault".into());}
            fs::copy(p.staged.join("leaf.exe"),p.target.join("leaf.exe")).unwrap();if self.fault==Some("first_replace"){return Err("fault".into());}
            fs::copy(p.staged.join("leaf-update-helper.exe"),p.target.join("leaf-update-helper.exe")).unwrap();if self.fault==Some("helper_replace"){return Err("fault".into());}
            self.registry.clear();if self.fault==Some("registry_delete"){return Err("fault".into());}
            self.registry.insert("new".into(),None);if self.fault==Some("registry_write"){return Err("fault".into());}
            if self.fault==Some("before_completion"){return Err("fault".into());}Ok(())
        }
        fn verify_installed(&self,_:&WindowsInstallPlan)->Result<(),String>{Ok(())}
        fn restart(&mut self,_:&WindowsInstallPlan)->Result<(),String>{self.restarts+=1;Ok(())}
    }
    fn fixture()->(tempfile::TempDir,WindowsInstallPlan,Mock){
        let dir=tempfile::tempdir().unwrap();let root=dir.path().canonicalize().unwrap();let target=root.join("Leaf");let tx=root.join(".leaf-update-test");fs::create_dir(&target).unwrap();fs::create_dir(&tx).unwrap();let staged=tx.join("Prepared");fs::create_dir(&staged).unwrap();
        for name in ["leaf.exe","leaf-update-helper.exe"]{fs::write(target.join(name),format!("old {name}")).unwrap();fs::write(staged.join(name),format!("new {name}")).unwrap();}
        let old=inventory(&target).unwrap();let new=inventory(&staged).unwrap();fs::write(staged.join(".leaf-update-installer.exe"),b"installer").unwrap();let helper=tx.join("leaf-update-helper.exe");fs::copy(staged.join("leaf-update-helper.exe"),&helper).unwrap();
        let registry=Registry::from([("owned".into(),Some(BTreeMap::from([("version".into(),RegistryValue{kind:1,data:b"old".to_vec()})])))]);
        let p=WindowsInstallPlan{transaction:"synthetic".into(),target:target.clone(),staged,helper,backup:tx.join("Previous"),journal:tx.join("result.json"),gui_pid:1,gui_executable:target.join("leaf.exe"),target_anchor:(0,[0;16]),installer_digest:hash(b"installer"),package_digest:"0".repeat(64),token:"a".repeat(64),created_unix:0,old_version:"1.0.0-beta.4".into(),new_version:"1.0.1".into(),old,new,registry:registry.clone()};
        (dir,p,Mock{registry,fault:None,restarts:0,block:false,restore_bad:false})
    }
    #[test]fn whole_payload_and_registry_recover_at_every_mutation(){for fault in ["after_delete","first_replace","helper_replace","registry_delete","registry_write","before_completion"]{
        let(_root,p,mut platform)=fixture();platform.fault=Some(fault);let result=install(&p,&mut platform);assert_eq!(result.state,InstallState::RolledBack,"{fault}");assert_eq!(inventory(&p.target).unwrap(),p.old);assert_eq!(platform.registry,p.registry);assert_eq!(platform.restarts,1);
    }}
    #[test]fn success_and_restore_failure_have_distinct_truthful_results(){
        let(_root,p,mut platform)=fixture();assert_eq!(install(&p,&mut platform).state,InstallState::Installed);assert_eq!(platform.restarts,1);assert_eq!(inventory(&p.target).unwrap(),p.new);
        let(_root,p,mut platform)=fixture();platform.fault=Some("registry_write");platform.restore_bad=true;assert_eq!(install(&p,&mut platform).state,InstallState::RollbackFailed);assert_eq!(platform.restarts,0);assert_eq!(inventory(&p.backup).unwrap(),p.old);
    }
    #[test]fn occupied_or_changed_payload_blocks_before_backup_and_mutation(){let(_root,p,mut platform)=fixture();platform.block=true;assert_eq!(install(&p,&mut platform).state,InstallState::InstallFailed);assert!(!p.backup.exists());assert_eq!(inventory(&p.target).unwrap(),p.old);platform.block=false;fs::write(p.staged.join("leaf.exe"),b"tampered").unwrap();assert!(check_ready(&p,&mut platform).is_err());}
    #[test]fn reparse_or_case_alias_payload_is_rejected(){let(_root,p,mut platform)=fixture();fs::write(p.staged.join("LEAF.EXE"),b"alias").unwrap();assert!(check_ready(&p,&mut platform).is_err());}
}
