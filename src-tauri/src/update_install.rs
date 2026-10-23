//! Independent Mac installation transaction. Production stays unavailable until
//! bundle verification, external-helper readiness and rollback proof are wired.
#[cfg(any(target_os="windows",test))]
#[path="update_install_windows.rs"]
pub mod windows;
#[cfg(target_os="macos")]
pub mod macos {
    use std::{collections::BTreeMap,path::{Path,PathBuf}};
    use serde::{Deserialize,Serialize};

    #[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
    pub struct BundleIdentity {
        pub identifier:String,pub version:String,pub arch:String,
        pub inventory:BTreeMap<String,String>,
    }
    #[derive(Clone,Debug,Serialize,Deserialize)]
    pub struct MacInstallPlan {
        pub transaction:String,pub target:PathBuf,pub staged:PathBuf,pub helper:PathBuf,
        pub journal:PathBuf,pub gui_pid:u32,pub gui_executable:PathBuf,pub target_anchor:(u64,u64),
        pub package_digest:String,pub token:String,pub created_unix:u64,pub old:BundleIdentity,pub new:BundleIdentity,
    }
    #[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
    #[serde(rename_all="snake_case")]
    pub enum InstallState {Installing,Installed,InstallFailed,RolledBack,RollbackFailed}
    #[derive(Clone,Debug,Serialize,Deserialize)]
    pub struct InstallResult {
        pub transaction:String,pub state:InstallState,pub old_location:PathBuf,pub new_location:PathBuf,
        pub restart_count:u32,pub old_bundle_digest:String,pub new_bundle_digest:String,pub error:Option<String>,
    }
    #[derive(Clone,Debug)]
    pub struct OwnedProcess {pub pid:u32,pub executable:PathBuf}
    pub trait Platform {
        fn verify_signature(&self,bundle:&Path)->Result<(),String>;
        fn preflight(&self,_plan:&MacInstallPlan)->Result<(),String>{Ok(())}
        fn processes(&self)->Result<Vec<OwnedProcess>,String>;
        fn wait_for_exit(&mut self,pid:u32)->Result<(),String>;
        fn exchange(&mut self,target:&Path,staged:&Path)->Result<(),String>;
        fn sync_exchange(&self,_target:&Path,_staged:&Path)->Result<(),String>{Ok(())}
        fn restart(&mut self,target:&Path)->Result<(),String>;
    }
    #[cfg_attr(feature="native-smoke",track_caller)]
    fn failure()->String{
        #[cfg(feature="native-smoke")] {
            static COUNT:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
            if COUNT.fetch_add(1,std::sync::atomic::Ordering::Relaxed)<32 {
                eprintln!("update_install_diagnostic_line={}",std::panic::Location::caller().line());
            }
        }
        "update_install_invalid".into()
    }
    pub(crate) fn hash(bytes:&[u8])->String{use sha2::{Digest,Sha256};format!("{:x}",Sha256::digest(bytes))}
    pub(crate) fn file_hash(path:&Path)->Result<String,String>{
        use std::io::Read;
        use sha2::{Digest,Sha256};
        let mut file=std::fs::File::open(path).map_err(|_|failure())?;let mut digest=Sha256::new();let mut bytes=[0u8;65536];let mut size=0u64;
        loop{let count=file.read(&mut bytes).map_err(|_|failure())?;if count==0{break;}size=size.checked_add(count as u64).filter(|size|*size<=2*1024*1024*1024).ok_or_else(failure)?;digest.update(&bytes[..count]);}
        Ok(format!("{:x}",digest.finalize()))
    }
    fn inventory(root:&Path)->Result<BTreeMap<String,String>,String>{
        use std::os::unix::fs::MetadataExt;
        let root=root.canonicalize().map_err(|_|failure())?;let device=std::fs::metadata(&root).map_err(|_|failure())?.dev();
        let mut output=BTreeMap::new();let mut pending=vec![root.clone()];let mut total=0u64;
        while let Some(directory)=pending.pop(){
            for entry in std::fs::read_dir(directory).map_err(|_|failure())?{
                let path=entry.map_err(|_|failure())?.path();let relative=path.strip_prefix(&root).map_err(|_|failure())?.to_str().ok_or_else(failure)?.to_owned();
                if relative.len()>4096||relative.contains('\\')||relative.split('/').count()>32||output.len()>=20_000{return Err(failure());}
                let metadata=std::fs::symlink_metadata(&path).map_err(|_|failure())?;
                if metadata.dev()!=device{return Err("update_install_cross_volume".into());}
                let value=if metadata.file_type().is_symlink(){
                    let target=std::fs::read_link(&path).map_err(|_|failure())?;
                    if target.is_absolute()||!path.canonicalize().map_err(|_|failure())?.starts_with(&root){return Err(failure());}
                    format!("link:{}",target.to_str().ok_or_else(failure)?)
                }else if metadata.is_dir(){pending.push(path.clone());"directory".into()}
                else if metadata.is_file(){
                    if metadata.nlink()!=1||metadata.mode()&0o022!=0{return Err(failure());}
                    total=total.checked_add(metadata.len()).filter(|size|*size<=2*1024*1024*1024).ok_or_else(failure)?;
                    file_hash(&path)?
                }else{return Err(failure());};
                if output.insert(relative,value).is_some(){return Err(failure());}
            }
        }Ok(output)
    }
    fn bundle_metadata(root:&Path)->Result<(String,String,String),String>{
        let path=root.join("Contents/Info.plist");
        if std::fs::metadata(&path).map_err(|_|failure())?.len()>1024*1024{return Err(failure());}
        let value=plist::Value::from_file(path).map_err(|_|failure())?;let dict=value.as_dictionary().ok_or_else(failure)?;
        let field=|name:&str|dict.get(name).and_then(plist::Value::as_string).map(str::to_owned).ok_or_else(failure);
        if field("CFBundleExecutable")?!="leaf"{return Err(failure());}
        let identifier=field("CFBundleIdentifier")?;let version=field("CFBundleShortVersionString")?;
        use std::io::Read;
        let mut head=[0u8;4096];let count=std::fs::File::open(root.join("Contents/MacOS/leaf")).map_err(|_|failure())?.read(&mut head).map_err(|_|failure())?;
        let cpu=if count>=32&&head[..4]==[0xcf,0xfa,0xed,0xfe]{u32::from_le_bytes(head[4..8].try_into().unwrap())}
            else if count>=8&&head[..4]==[0xca,0xfe,0xba,0xbe]{if cfg!(target_arch="aarch64"){0x0100000c}else{0x01000007}}else{return Err(failure());};
        let arch=match cpu{0x0100000c=>"aarch64",0x01000007=>"x86_64",_=>return Err(failure())};
        Ok((identifier,version,arch.into()))
    }
    fn check_executable(path:&Path,arch:&str,version:&str,role:&str)->Result<(),String>{
        use std::io::Read;
        use std::os::unix::fs::MetadataExt;
        let metadata=std::fs::metadata(path).map_err(|_|failure())?;if metadata.mode()&0o111==0||metadata.len()>512*1024*1024{return Err(failure());}
        let mut file=std::fs::File::open(path).map_err(|_|failure())?;let mut head=vec![0u8;4096];let count=file.read(&mut head).map_err(|_|failure())?;head.truncate(count);
        let cpu=match arch{"aarch64"=>0x0100000cu32,"x86_64"=>0x01000007u32,_=>return Err(failure())};
        let valid=if head.len()>=32&&head[..4]==[0xcf,0xfa,0xed,0xfe]{
            u32::from_le_bytes(head[4..8].try_into().unwrap())==cpu&&u32::from_le_bytes(head[12..16].try_into().unwrap())==2
        }else if head.len()>=8&&head[..4]==[0xca,0xfe,0xba,0xbe]{
            let count=u32::from_be_bytes(head[4..8].try_into().unwrap()) as usize;
            count>0&&count<=64&&head.len()>=8+count*20&&(0..count).any(|index|u32::from_be_bytes(head[8+index*20..12+index*20].try_into().unwrap())==cpu)
        }else{false};
        if !valid{return Err("update_install_architecture".into());}
        // Decode at runtime so this verifier does not embed an incomplete identity in its own executable.
        let mut marker:Vec<u8>=std::hint::black_box([233,224,228,227,250,240,245,225,228,241,224,250,231,236,235,228,247,252,250,236,225,224,235,241,236,241,252,250,243,148,165]).into_iter().map(|byte|byte^165).collect();
        for field in ["Leaf","studio.leaf.editor",version,role] {marker.extend_from_slice(field.as_bytes());marker.push(0);}
        // Inventory and the outer package signature bind all bytes. The marker
        // additionally prevents a same-architecture executable of another role.
        let mut carry=Vec::new();let mut chunk=[0u8;65536];let mut found=head.windows(marker.len()).any(|bytes|bytes==marker);
        if marker.len()>1{carry.extend_from_slice(&head[head.len().saturating_sub(marker.len()-1)..]);}
        while !found{let count=file.read(&mut chunk).map_err(|_|failure())?;if count==0{break;}carry.extend_from_slice(&chunk[..count]);found=carry.windows(marker.len()).any(|bytes|bytes==marker);let keep=marker.len().saturating_sub(1);if carry.len()>keep{carry.drain(..carry.len()-keep);}}
        if !found{return Err("update_install_binary_identity".into());}Ok(())
    }
    pub fn capture_identity(root:&Path)->Result<BundleIdentity,String>{
        let(identifier,version,arch)=bundle_metadata(root)?;
        Ok(BundleIdentity{identifier,version,arch,inventory:inventory(root)?})
    }
    pub fn validate_bundle(root:&Path,expected:&BundleIdentity,platform:&dyn Platform)->Result<(),String>{
        let actual=capture_identity(root)?;
        if &actual!=expected||expected.identifier!="studio.leaf.editor"{return Err("update_install_bundle_identity".into());}
        for role in ["leaf","leaf-mcp-adapter","leaf-update-helper"]{check_executable(&root.join("Contents/MacOS").join(role),&expected.arch,&expected.version,role)?;}
        platform.verify_signature(root)?;Ok(())
    }
    fn occupied(plan:&MacInstallPlan,platform:&dyn Platform,allow_gui:bool)->Result<(),String>{
        let target=plan.target.canonicalize().map_err(|_|failure())?;
        for process in platform.processes()?{
            if allow_gui&&process.pid==plan.gui_pid{continue;}
            if process.executable.canonicalize().unwrap_or(process.executable).starts_with(&target){return Err("update_install_target_occupied".into());}
        }Ok(())
    }
    pub fn check_ready(plan:&MacInstallPlan,platform:&dyn Platform)->Result<(),String>{
        use std::os::unix::fs::MetadataExt;
        let target=plan.target.canonicalize().map_err(|_|failure())?;let staged=plan.staged.canonicalize().map_err(|_|failure())?;let helper=plan.helper.canonicalize().map_err(|_|failure())?;
        let target_metadata=std::fs::symlink_metadata(&plan.target).map_err(|_|failure())?;
        let staged_metadata=std::fs::symlink_metadata(&plan.staged).map_err(|_|failure())?;
        if plan.transaction.is_empty()||plan.transaction.len()>128||target!=plan.target||staged!=plan.staged||helper!=plan.helper
            ||target_metadata.file_type().is_symlink()||staged_metadata.file_type().is_symlink()
            ||(target_metadata.dev(),target_metadata.ino())!=plan.target_anchor
            ||target_metadata.dev()!=staged_metadata.dev()||target.starts_with(&staged)||staged.starts_with(&target)
            ||helper.starts_with(&target)||helper.starts_with(&staged){return Err(failure());}
        if plan.old.identifier!=plan.new.identifier||semver::Version::parse(&plan.new.version).map_err(|_|failure())?<=semver::Version::parse(&plan.old.version).map_err(|_|failure())?{return Err(failure());}
        validate_bundle(&target,&plan.old,platform)?;validate_bundle(&staged,&plan.new,platform)?;
        let expected=plan.new.inventory.get("Contents/MacOS/leaf-update-helper").ok_or_else(failure)?;
        if &file_hash(&helper)?!=expected{return Err("update_install_helper_changed".into());}
        platform.verify_signature(&helper)?;platform.preflight(plan)?;occupied(plan,platform,true)
    }
    fn persist_result(plan:&MacInstallPlan,result:&InstallResult)->Result<(),String>{
        use std::io::Write;
        let parent=plan.journal.parent().ok_or_else(failure)?;
        let mut file=tempfile::NamedTempFile::new_in(parent).map_err(|_|"update_install_journal")?;
        file.write_all(&serde_json::to_vec(result).map_err(|_|failure())?).map_err(|_|"update_install_journal")?;
        file.as_file().sync_all().map_err(|_|"update_install_journal")?;
        file.persist(&plan.journal).map_err(|_|"update_install_journal")?;
        std::fs::File::open(parent).and_then(|file|file.sync_all()).map_err(|_|"update_install_journal")?;Ok(())
    }
    pub(crate) fn abort_result(plan:&MacInstallPlan,code:&str)->InstallResult{
        let result=InstallResult{transaction:plan.transaction.clone(),state:InstallState::InstallFailed,old_location:plan.target.clone(),new_location:plan.staged.clone(),
            restart_count:0,old_bundle_digest:hash(&serde_json::to_vec(&plan.old).expect("string-only identity serializes")),
            new_bundle_digest:hash(&serde_json::to_vec(&plan.new).expect("string-only identity serializes")),error:Some(code.into())};
        let _=persist_result(plan,&result);result
    }
    pub fn install(plan:&MacInstallPlan,platform:&mut dyn Platform)->InstallResult {
        let mut result=InstallResult{transaction:plan.transaction.clone(),state:InstallState::InstallFailed,
            old_location:plan.target.clone(),new_location:plan.staged.clone(),restart_count:0,
            old_bundle_digest:hash(&serde_json::to_vec(&plan.old).expect("string-only identity serializes")),new_bundle_digest:hash(&serde_json::to_vec(&plan.new).expect("string-only identity serializes")),error:None};
        // The atomic create owns the entire transaction, not only restart.
        // A losing/replayed helper must never exchange or rewrite its owner's journal.
        use std::os::unix::fs::OpenOptionsExt;
        let owner=std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(plan.journal.with_extension("install-claim"));
        let Ok(owner)=owner else{result.error=Some("update_install_already_claimed".into());return result;};
        if owner.sync_all().is_err(){result.error=Some("update_install_claim_failed".into());return result;}
        let ready=check_ready(plan,platform).and_then(|_|platform.wait_for_exit(plan.gui_pid)).and_then(|_|check_ready(plan,platform)).and_then(|_|occupied(plan,platform,false));
        if let Err(code)=ready{result.error=Some(code);let _=persist_result(plan,&result);return result;}
        result.state=InstallState::Installing;
        if let Err(code)=persist_result(plan,&result){result.state=InstallState::InstallFailed;result.error=Some(code);return result;}
        if let Err(code)=platform.exchange(&plan.target,&plan.staged){result.state=InstallState::InstallFailed;result.error=Some(code);let _=persist_result(plan,&result);return result;}
        result.old_location=plan.staged.clone();result.new_location=plan.target.clone();
        if let Err(code)=platform.sync_exchange(&plan.target,&plan.staged).and_then(|_|validate_bundle(&plan.target,&plan.new,platform)){
            result.error=Some(code);
            match platform.exchange(&plan.target,&plan.staged){
                Ok(())=>{result.old_location=plan.target.clone();result.new_location=plan.staged.clone();result.state=if platform.sync_exchange(&plan.target,&plan.staged).and_then(|_|validate_bundle(&plan.target,&plan.old,platform)).is_ok(){InstallState::RolledBack}else{InstallState::RollbackFailed};}
                Err(code)=>{result.state=InstallState::RollbackFailed;result.error=Some(code);}
            }
            if let Err(code)=persist_result(plan,&result){result.error=Some(code);}return result;
        }
        // A durable exclusive claim makes replay incapable of launching twice.
        let claim=plan.journal.with_extension("restart-claim");
        let claim=std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(claim);
        if claim.and_then(|file|file.sync_all()).is_err(){result.state=InstallState::InstallFailed;result.error=Some("update_restart_claim_failed".into());let _=persist_result(plan,&result);return result;}
        match platform.restart(&plan.target){Ok(())=>{result.state=InstallState::Installed;result.restart_count=1;},Err(code)=>{result.state=InstallState::InstallFailed;result.error=Some(code);}}
        if let Err(code)=persist_result(plan,&result){result.error=Some(code);if result.state==InstallState::Installed{result.state=InstallState::InstallFailed;}}
        result
    }

    pub struct NativePlatform {
        pub gui_executable:PathBuf,pub plan_path:PathBuf,pub plan_digest:String,pub transaction:String,
    }
    #[link(name="proc")]
    extern "C" {
        fn proc_listallpids(buffer:*mut std::ffi::c_void,size:i32)->i32;
        fn proc_pidpath(pid:i32,buffer:*mut std::ffi::c_void,size:u32)->i32;
        fn proc_pidinfo(pid:i32,flavor:i32,arg:u64,buffer:*mut std::ffi::c_void,size:i32)->i32;
    }
    extern "C" {
        fn renameatx_np(from_fd:i32,from:*const std::ffi::c_char,to_fd:i32,to:*const std::ffi::c_char,flags:u32)->i32;
        fn geteuid()->u32;
        fn kill(pid:i32,signal:i32)->i32;
    }
    fn path_of_process(pid:u32)->Option<PathBuf>{
        let mut bytes=vec![0u8;4096];let count=unsafe{proc_pidpath(pid as i32,bytes.as_mut_ptr().cast(),bytes.len() as u32)};
        if count<=0{return None;}
        bytes.truncate(count as usize);if bytes.last()==Some(&0){bytes.pop();}
        use std::os::unix::ffi::OsStringExt;Some(PathBuf::from(std::ffi::OsString::from_vec(bytes)))
    }
    fn atomic_exchange(from:&Path,to:&Path)->Result<(),String>{
        use std::os::unix::ffi::OsStrExt;
        let from=std::ffi::CString::new(from.as_os_str().as_bytes()).map_err(|_|failure())?;
        let to=std::ffi::CString::new(to.as_os_str().as_bytes()).map_err(|_|failure())?;
        // Apple SDK sys/stdio.h: RENAME_SWAP=0x2, AT_FDCWD=-2.
        if unsafe{renameatx_np(-2,from.as_ptr(),-2,to.as_ptr(),0x2)}!=0{return Err("update_atomic_exchange_unavailable".into());}Ok(())
    }
    fn owned_private_root(root:&Path)->Result<(),String>{
        use std::os::unix::fs::MetadataExt;
        let metadata=std::fs::symlink_metadata(root).map_err(|_|failure())?;
        if !metadata.is_dir()||metadata.file_type().is_symlink()||metadata.uid()!=unsafe{geteuid()}||metadata.mode()&0o077!=0
            ||root.canonicalize().map_err(|_|failure())?!=root{return Err(failure());}Ok(())
    }
    pub(crate) fn available_bytes(path:&Path)->Result<u64,String>{
        let output=std::process::Command::new("/bin/df").args(["-Pk"]).arg(path).env("LC_ALL","C").output().map_err(|_|"update_install_capacity")?;
        if !output.status.success(){return Err("update_install_capacity".into());}
        let output=String::from_utf8(output.stdout).map_err(|_|"update_install_capacity")?;
        let blocks=output.lines().last().and_then(|line|line.split_whitespace().nth(3)).and_then(|value|value.parse::<u64>().ok()).ok_or("update_install_capacity")?;
        blocks.checked_mul(1024).ok_or_else(||"update_install_capacity".into())
    }
    #[derive(Clone,Debug,PartialEq,Eq)]
    #[repr(C)]
    struct ProcessUuid {uuid:[u8;16],unique:u64,parent:u64,version:i32,parent_version:i32,reserved2:u64,reserved3:u64}
    fn kernel_lookup_error(failed:bool,errno:Option<i32>)->String{
        (if failed&&errno==Some(3){"update_install_process_gone"}else{"update_install_process_query"}).into()
    }
    fn kernel_uuid(pid:u32)->Result<ProcessUuid,String>{
        let mut value=ProcessUuid{uuid:[0;16],unique:0,parent:0,version:0,parent_version:0,reserved2:0,reserved3:0};
        let size=std::mem::size_of::<ProcessUuid>();
        // Apple proc_info_private.h fixes this API layout at 56 bytes, flavor17.
        let returned=unsafe{proc_pidinfo(pid as i32,17,0,(&mut value as *mut ProcessUuid).cast(),size as i32)};
        let errno=std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        if size!=56||returned!=size as i32{process_uuid_diagnostic(pid,"uuid_read_size",Some(returned),Some(errno),None);return Err(kernel_lookup_error(size==56&&returned<=0,Some(errno)));}
        if value.unique==0{process_uuid_diagnostic(pid,"zero_unique",Some(returned),None,Some(value.version==0));return Err("update_install_process_query".into());}
        // XNU assigns this signed counter via OSIncrementAtomic(nextpidversion).
        // Its value (including zero) is an identity component, not an absent-value sentinel.
        Ok(value)
    }
    fn different_image(before:&ProcessUuid,after:&ProcessUuid,targets:&std::collections::BTreeSet<[u8;16]>)->bool{
        before==after&&before.uuid!=[0;16]&&before.unique!=0&&!targets.is_empty()&&!targets.contains(&before.uuid)
    }
    fn image_uuids(bytes:&[u8])->Result<std::collections::BTreeSet<[u8;16]>,String>{
        fn thin(bytes:&[u8])->Result<[u8;16],String>{
            if bytes.len()<32||bytes[..4]!=[0xcf,0xfa,0xed,0xfe]{return Err("update_install_process_image".into());}
            let commands=u32::from_le_bytes(bytes[16..20].try_into().unwrap()) as usize;
            let size=u32::from_le_bytes(bytes[20..24].try_into().unwrap()) as usize;
            if commands==0||commands>4096||size>4*1024*1024{return Err("update_install_process_image".into());}
            let end=32usize.checked_add(size).filter(|end|*end<=bytes.len()).ok_or("update_install_process_image")?;
            let mut cursor=32usize;let mut uuid=None;
            for _ in 0..commands{
                if cursor.checked_add(8).is_none_or(|next|next>end){return Err("update_install_process_image".into());}
                let command=u32::from_le_bytes(bytes[cursor..cursor+4].try_into().unwrap());
                let size=u32::from_le_bytes(bytes[cursor+4..cursor+8].try_into().unwrap()) as usize;
                let next=cursor.checked_add(size).filter(|next|size>=8&&*next<=end).ok_or("update_install_process_image")?;
                if command==0x1b{
                    if size!=24||uuid.is_some(){return Err("update_install_process_image".into());}
                    let value:[u8;16]=bytes[cursor+8..next].try_into().unwrap();
                    if value==[0;16]{return Err("update_install_process_image".into());}uuid=Some(value);
                }
                cursor=next;
            }
            if cursor!=end{return Err("update_install_process_image".into());}uuid.ok_or_else(||"update_install_process_image".into())
        }
        let mut output=std::collections::BTreeSet::new();
        if bytes.len()>=8&&(bytes[..4]==[0xca,0xfe,0xba,0xbe]||bytes[..4]==[0xca,0xfe,0xba,0xbf]){
            let wide=bytes[3]==0xbf;let count=u32::from_be_bytes(bytes[4..8].try_into().unwrap()) as usize;let entry=if wide{32}else{20};
            let header=8+count*entry;if count==0||count>64||header>bytes.len(){return Err("update_install_process_image".into());}
            let mut ranges=Vec::new();
            for index in 0..count{
                let start=8+index*entry;
                let(offset,size)=if wide{(u64::from_be_bytes(bytes[start+8..start+16].try_into().unwrap()),u64::from_be_bytes(bytes[start+16..start+24].try_into().unwrap()))}
                    else{(u32::from_be_bytes(bytes[start+8..start+12].try_into().unwrap()) as u64,u32::from_be_bytes(bytes[start+12..start+16].try_into().unwrap()) as u64)};
                let end=offset.checked_add(size).filter(|end|*end<=bytes.len() as u64&&offset>=header as u64&&size>=32).ok_or("update_install_process_image")?;
                if ranges.iter().any(|(from,to)|offset<*to&&end>*from){return Err("update_install_process_image".into());}
                ranges.push((offset,end));output.insert(thin(&bytes[offset as usize..end as usize])?);
            }
        }else{output.insert(thin(bytes)?);}
        Ok(output)
    }
    fn kernel_cdhash(pid:u32)->Result<[u8;20],String>{
        unsafe extern "C"{fn csops(pid:i32,operations:u32,address:*mut std::ffi::c_void,size:usize)->i32;}
        let mut value=[0u8;20];
        let result=unsafe{csops(pid as i32,5,value.as_mut_ptr().cast(),value.len())};
        if result!=0||value==[0;20]{
            let errno=std::io::Error::last_os_error().raw_os_error();
            process_uuid_diagnostic(pid,if result!=0{"cdhash_read_failed"}else{"zero_cdhash"},Some(result),errno,None);
            return Err(kernel_lookup_error(result==-1,errno));
        }Ok(value)
    }
    fn different_signed_image(before:&ProcessUuid,after:&ProcessUuid,first:[u8;20],last:[u8;20],targets:&std::collections::BTreeSet<[u8;20]>)->bool{
        before==after&&before.unique!=0&&first==last&&first!=[0;20]&&!targets.is_empty()&&!targets.contains(&first)
    }
    fn signature_failure(code:&str,details:serde_json::Value)->String{
        static COUNT:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
        if COUNT.fetch_add(1,std::sync::atomic::Ordering::Relaxed)<32{eprintln!("update_signature_diagnostic={}",serde_json::json!({"code":code,"details":details}));}
        "update_install_process_image".into()
    }
    fn image_cdhashes(bytes:&[u8])->Result<std::collections::BTreeSet<[u8;20]>,String>{
        use sha2::{Digest,Sha256,Sha384};
        fn number(bytes:&[u8],offset:usize)->Result<u32,String>{
            Ok(u32::from_be_bytes(bytes.get(offset..offset+4).ok_or_else(||signature_failure("number_bounds",serde_json::json!({"length":bytes.len(),"offset":offset})))?.try_into().unwrap()))
        }
        fn directory(bytes:&[u8])->Result<[u8;20],String>{
            if bytes.len()<44||number(bytes,0)?!=0xfade0c02||number(bytes,4)? as usize!=bytes.len(){return Err(signature_failure("directory_header",serde_json::json!({"length":bytes.len()})));}
            let digest=match(bytes[37],bytes[36]){
                (1,20)=>{
                    #[link(name="System")] unsafe extern "C"{fn CC_SHA1(bytes:*const std::ffi::c_void,length:u32,digest:*mut u8)->*mut u8;}
                    let mut value=[0u8;20];if bytes.len()>u32::MAX as usize||unsafe{CC_SHA1(bytes.as_ptr().cast(),bytes.len() as u32,value.as_mut_ptr())}.is_null(){return Err(signature_failure("sha1_unavailable",serde_json::json!({})));}return Ok(value);
                },
                (2,32)|(3,20)=>Sha256::digest(bytes).to_vec(),(4,48)=>Sha384::digest(bytes).to_vec(),
                _=>return Err(signature_failure("unsupported_hash",serde_json::json!({"hash_type":bytes[37],"hash_size":bytes[36]}))),
            };
            let mut value=[0u8;20];value.copy_from_slice(&digest[..20]);Ok(value)
        }
        fn thin(bytes:&[u8],output:&mut std::collections::BTreeSet<[u8;20]>)->Result<(),String>{
            let commands=u32::from_le_bytes(bytes[16..20].try_into().unwrap()) as usize;
            let mut cursor=32usize;let mut signature=None;
            for _ in 0..commands{
                let command=u32::from_le_bytes(bytes[cursor..cursor+4].try_into().unwrap());
                let size=u32::from_le_bytes(bytes[cursor+4..cursor+8].try_into().unwrap()) as usize;
                if command==0x1d{
                    if size!=16||signature.is_some(){return Err(signature_failure("signature_command",serde_json::json!({"command_size":size,"duplicate":signature.is_some()})));}
                    let offset=u32::from_le_bytes(bytes[cursor+8..cursor+12].try_into().unwrap()) as usize;
                    let length=u32::from_le_bytes(bytes[cursor+12..cursor+16].try_into().unwrap()) as usize;
                    signature=Some(bytes.get(offset..offset.checked_add(length).ok_or_else(||signature_failure("signature_overflow",serde_json::json!({})))?).ok_or_else(||signature_failure("signature_bounds",serde_json::json!({"offset":offset,"size":length,"file_size":bytes.len()})))?);
                }cursor+=size;
            }
            let signature=signature.ok_or_else(||signature_failure("missing_signature_command",serde_json::json!({})))?;
            let used=number(signature,4)? as usize;
            let magic=number(signature,0)?;
            if used<8||used>signature.len(){return Err(signature_failure("signature_used_bounds",serde_json::json!({"used":used,"allocated":signature.len()})));}
            // Kernel blob validation uses the embedded length, not the entire
            // LC_CODE_SIGNATURE allocation. Re-signing may retain nonzero tail
            // bytes; the independently authenticated full file still binds them.
            let signature=&signature[..used];
            if magic==0xfade0c02{output.insert(directory(signature)?);return Ok(());}
            if magic!=0xfade0cc0||used<12{return Err(signature_failure("superblob_header",serde_json::json!({"magic":magic,"used":used})));}
            let count=number(signature,8)? as usize;
            let table=12usize.checked_add(count.checked_mul(8).ok_or_else(||signature_failure("slot_count_overflow",serde_json::json!({"count":count})))?).filter(|end|count>0&&count<=64&&*end<=signature.len()).ok_or_else(||signature_failure("slot_table_bounds",serde_json::json!({"count":count,"used":used})))?;
            let mut slots=std::collections::BTreeSet::new();let mut ranges=Vec::new();let mut primary=false;let mut found=0;
            for index in 0..count{
                let slot=number(signature,12+index*8)?;let offset=number(signature,16+index*8)? as usize;
                if !slots.insert(slot)||offset<table{return Err(signature_failure("slot_index",serde_json::json!({"slot":slot,"offset":offset,"table":table})));}
                let length=number(signature,offset+4)? as usize;
                let end=offset.checked_add(length).filter(|end|length>=8&&*end<=signature.len()).ok_or_else(||signature_failure("slot_blob_bounds",serde_json::json!({"slot":slot,"length":length,"offset":offset,"used":used})))?;
                if ranges.iter().any(|(start,stop)|offset<*stop&&end>*start){return Err(signature_failure("slot_overlap",serde_json::json!({"slot":slot})));}ranges.push((offset,end));
                let magic=number(signature,offset)?;
                if slot==0||(0x1000..0x1005).contains(&slot){
                    if slot==0{primary=true;}output.insert(directory(&signature[offset..end])?);found+=1;
                }else if magic==0xfade0c02{return Err(signature_failure("unsupported_directory_slot",serde_json::json!({"slot":slot})));}
            }
            if !primary||found==0{return Err(signature_failure("missing_primary_directory",serde_json::json!({"primary":primary,"directories":found})));}Ok(())
        }
        // Validate every slice/load-command boundary and require the complete
        // authenticated Mach-O inventory before reading embedded signatures.
        image_uuids(bytes).map_err(|_|signature_failure("macho_uuid_or_slice_bounds",serde_json::json!({})))?;
        let mut output=std::collections::BTreeSet::new();
        if bytes[..4]==[0xca,0xfe,0xba,0xbe]||bytes[..4]==[0xca,0xfe,0xba,0xbf]{
            let wide=bytes[3]==0xbf;let entry=if wide{32}else{20};let count=number(bytes,4)? as usize;
            for index in 0..count{
                let start=8+index*entry;
                let(offset,size)=if wide{(u64::from_be_bytes(bytes[start+8..start+16].try_into().unwrap()) as usize,u64::from_be_bytes(bytes[start+16..start+24].try_into().unwrap()) as usize)}
                    else{(number(bytes,start+8)? as usize,number(bytes,start+12)? as usize)};
                thin(&bytes[offset..offset+size],&mut output)?;
            }
        }else{thin(bytes,&mut output)?;}if output.is_empty()||output.contains(&[0;20]){return Err(signature_failure("empty_directory_identity",serde_json::json!({})));}Ok(output)
    }
    fn process_uuid_diagnostic(pid:u32,code:&str,returned:Option<i32>,errno:Option<i32>,idversion_zero:Option<bool>){
        static COUNT:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
        if COUNT.fetch_add(1,std::sync::atomic::Ordering::Relaxed)<32{
            eprintln!("update_process_uuid_diagnostic={}",serde_json::json!({"pid":pid,"code":code,"returned_size":returned,"errno":errno,"idversion_zero":idversion_zero}));
        }
    }
    fn process_diagnostic(pid:u32,path_errno:i32,status:Option<u32>,code:&str){
        static COUNT:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
        if COUNT.fetch_add(1,std::sync::atomic::Ordering::Relaxed)<32{
            eprintln!("update_process_diagnostic={}",serde_json::json!({"pid":pid,"path_errno":path_errno,"status":status,"code":code}));
        }
    }
    impl NativePlatform {
        fn authenticated_images(&self)->Result<Vec<Vec<u8>>,String>{
            use std::os::unix::fs::MetadataExt;
            let plan=read_plan(&self.plan_path,&self.plan_digest)?;
            if plan.transaction!=self.transaction||plan.gui_executable!=self.gui_executable||self.gui_executable!=plan.target.join("Contents/MacOS/leaf"){return Err("update_install_process_image".into());}
            let anchor=std::fs::metadata(&plan.target).map_err(|_|"update_install_process_image")?;
            if(anchor.dev(),anchor.ino())!=plan.target_anchor{return Err("update_install_process_image".into());}
            let mut images=Vec::new();
            for(path,expected)in &plan.old.inventory{
                if expected=="directory"||expected.starts_with("link:"){continue;}
                let path=plan.target.join(path);let metadata=std::fs::symlink_metadata(&path).map_err(|_|"update_install_process_image")?;
                if metadata.mode()&0o111==0{continue;}
                if !metadata.is_file()||metadata.file_type().is_symlink()||metadata.len()>512*1024*1024{return Err("update_install_process_image".into());}
                let bytes=std::fs::read(&path).map_err(|_|"update_install_process_image")?;
                if hash(&bytes)!=*expected{return Err("update_install_process_image".into());}
                images.push(bytes);
            }
            if images.is_empty(){return Err("update_install_process_image".into());}Ok(images)
        }
        fn authenticated_uuids(&self)->Result<std::collections::BTreeSet<[u8;16]>,String>{
            let mut output=std::collections::BTreeSet::new();for bytes in self.authenticated_images()?{output.extend(image_uuids(&bytes)?);}Ok(output)
        }
        pub(crate) fn prove_unrelated_signed_process(&self,pid:u32)->Result<(),String>{
            let before=kernel_uuid(pid)?;let first=kernel_cdhash(pid)?;
            let mut targets=std::collections::BTreeSet::new();
            for bytes in self.authenticated_images()?{targets.extend(image_cdhashes(&bytes).map_err(|error|{process_uuid_diagnostic(pid,"target_cdhash_incomplete",None,None,None);error})?);}
            let last=kernel_cdhash(pid)?;let after=kernel_uuid(pid)?;
            if different_signed_image(&before,&after,first,last,&targets){Ok(())}else{
                let matched=before==after&&first==last&&first!=[0;20]&&targets.contains(&first);
                process_uuid_diagnostic(pid,if matched{"matched_target_cdhash"}else{"signed_identity_changed"},None,None,Some(before.version==0));
                Err(if matched{"update_install_target_occupied"}else{"update_install_process_query"}.into())
            }
        }
        pub(crate) fn prove_unrelated_process(&self,pid:u32)->Result<(),String>{
            let before=kernel_uuid(pid)?;
            if before.uuid==[0;16]{return self.prove_unrelated_signed_process(pid);}
            let targets=self.authenticated_uuids().map_err(|error|{process_uuid_diagnostic(pid,"target_inventory_unavailable",None,None,Some(before.version==0));error})?;
            let after=kernel_uuid(pid)?;
            if different_image(&before,&after,&targets){Ok(())}else{
                let code=if before!=after{"identity_changed"}else if targets.is_empty(){"target_uuid_empty"}else if targets.contains(&before.uuid){"matched_target"}else{"identity_incomplete"};
                process_uuid_diagnostic(pid,code,None,None,Some(before.version==0));
                Err(if before==after&&targets.contains(&before.uuid){"update_install_target_occupied"}else{"update_install_process_query"}.into())
            }
        }
    }
    impl Platform for NativePlatform {
        fn verify_signature(&self,path:&Path)->Result<(),String>{
            let status=std::process::Command::new("/usr/bin/codesign").args(["--verify","--deep","--strict","--all-architectures"]).arg(path)
                .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().map_err(|_|"update_platform_signature")?;
            if status.success(){Ok(())}else{Err("update_platform_signature".into())}
        }
        fn preflight(&self,plan:&MacInstallPlan)->Result<(),String>{
            use std::os::unix::fs::MetadataExt;
            let root=plan.journal.parent().ok_or_else(failure)?;owned_private_root(root)?;
            if plan.helper.parent()!=Some(root)||plan.staged.parent()!=Some(root)||plan.target.starts_with(root){return Err(failure());}
            let target=std::fs::metadata(&plan.target).map_err(|_|failure())?;let parent=std::fs::metadata(plan.target.parent().ok_or_else(failure)?).map_err(|_|failure())?;
            if target.uid()!=unsafe{geteuid()}||parent.mode()&0o200==0||target.mode()&0o022!=0{return Err("update_install_target_not_owned".into());}
            let helper=std::fs::symlink_metadata(&plan.helper).map_err(|_|failure())?;
            if !helper.is_file()||helper.file_type().is_symlink()||helper.nlink()!=1||helper.uid()!=unsafe{geteuid()}||helper.mode()&0o022!=0{return Err("update_install_helper_changed".into());}
            let mut expanded=0u64;for (path,value)in &plan.new.inventory{if value!="directory"&&!value.starts_with("link:"){expanded=expanded.checked_add(std::fs::metadata(plan.staged.join(path)).map_err(|_|failure())?.len()).ok_or_else(failure)?;}}
            if available_bytes(root)?<expanded.saturating_add(16*1024*1024){return Err("update_install_insufficient_space".into());}
            let probe=tempfile::Builder::new().prefix(".swap-probe-").tempdir_in(root).map_err(|_|failure())?;
            let left=probe.path().join("left");let right=probe.path().join("right");
            std::fs::create_dir(&left).map_err(|_|failure())?;std::fs::create_dir(&right).map_err(|_|failure())?;atomic_exchange(&left,&right)?;Ok(())
        }
        fn processes(&self)->Result<Vec<OwnedProcess>,String>{
            let required=unsafe{proc_listallpids(std::ptr::null_mut(),0)};
            if required<0||required>65_000{return Err("update_install_process_query".into());}
            let mut pids=vec![0i32;required as usize+512];let count=unsafe{proc_listallpids(pids.as_mut_ptr().cast(),(pids.len()*4) as i32)};
            if count<0||count as usize>=pids.len(){return Err("update_install_process_query".into());}
            let mut processes=Vec::new();
            for pid in pids.into_iter().take(count as usize).filter(|pid|*pid>0){
                if let Some(executable)=path_of_process(pid as u32){processes.push(OwnedProcess{pid:pid as u32,executable});}
                else{
                    let path_errno=std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
                    let mut info=[0u32;16];
                    let count=unsafe{proc_pidinfo(pid,13,1,info.as_mut_ptr().cast(),64)};
                    let errno=std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
                    if count==0&&errno==3{process_diagnostic(pid as u32,path_errno,None,"kernel_gone");continue;}
                    if count!=64||info[0]!=pid as u32{process_diagnostic(pid as u32,path_errno,None,"short_identity_unavailable");return Err("update_install_process_query".into());}
                    if info[3]==5{process_diagnostic(pid as u32,path_errno,Some(info[3]),"kernel_zombie");continue;}
                    match self.prove_unrelated_process(pid as u32){
                        Ok(())=>process_diagnostic(pid as u32,path_errno,Some(info[3]),"different_authenticated_image"),
                        Err(code)if code=="update_install_process_gone"=>process_diagnostic(pid as u32,path_errno,Some(info[3]),"kernel_gone_during_image_lookup"),
                        Err(code)=>return Err(code),
                    }
                }
            }Ok(processes)
        }
        fn wait_for_exit(&mut self,pid:u32)->Result<(),String>{
            let deadline=std::time::Instant::now()+std::time::Duration::from_secs(30);
            loop{
                if unsafe{kill(pid as i32,0)}!=0&&std::io::Error::last_os_error().raw_os_error()==Some(3){return Ok(());}
                if path_of_process(pid).is_some_and(|path|path!=self.gui_executable){return Ok(());}
                if std::time::Instant::now()>=deadline{return Err("update_gui_exit_timeout".into());}
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }
        fn exchange(&mut self,target:&Path,staged:&Path)->Result<(),String>{atomic_exchange(target,staged)}
        fn sync_exchange(&self,target:&Path,staged:&Path)->Result<(),String>{
            for directory in [target.parent(),staged.parent()].into_iter().flatten(){std::fs::File::open(directory).and_then(|file|file.sync_all()).map_err(|_|"update_install_sync")?;}Ok(())
        }
        fn restart(&mut self,target:&Path)->Result<(),String>{
            std::process::Command::new(target.join("Contents/MacOS/leaf"))
                .args(["--leaf-update-reconcile"]).arg(&self.plan_path).arg(&self.plan_digest).arg(&self.transaction)
                .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
                .spawn().map_err(|_|"update_restart_failed")?;Ok(())
        }
    }
    #[derive(Serialize,Deserialize)]
    #[serde(deny_unknown_fields)]
    pub(crate) struct ChannelMessage {pub kind:String,pub transaction:String,pub plan_digest:String,pub token:String}
    pub(crate) fn channel_message(kind:&str,plan:&MacInstallPlan,digest:&str)->ChannelMessage{
        ChannelMessage{kind:kind.into(),transaction:plan.transaction.clone(),plan_digest:digest.into(),token:plan.token.clone()}
    }
    pub(crate) fn valid_message(message:&ChannelMessage,kind:&str,plan:&MacInstallPlan,digest:&str)->bool{
        message.kind==kind&&message.transaction==plan.transaction&&message.plan_digest==digest&&message.token==plan.token
    }
    pub(crate) fn read_plan(path:&Path,digest:&str)->Result<MacInstallPlan,String>{
        use std::os::unix::fs::MetadataExt;
        let root=path.parent().ok_or_else(failure)?;owned_private_root(root)?;
        let metadata=std::fs::symlink_metadata(path).map_err(|_|failure())?;
        if path.canonicalize().map_err(|_|failure())?!=path||!metadata.is_file()||metadata.file_type().is_symlink()||metadata.nlink()!=1
            ||metadata.uid()!=unsafe{geteuid()}||metadata.mode()&0o077!=0||metadata.len()>32*1024*1024{return Err(failure());}
        let bytes=std::fs::read(path).map_err(|_|failure())?;if hash(&bytes)!=digest{return Err("update_install_plan_changed".into());}
        let plan:MacInstallPlan=serde_json::from_slice(&bytes).map_err(|_|failure())?;
        let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|failure())?.as_secs();
        if plan.created_unix>now||now-plan.created_unix>120||plan.token.len()!=64||!plan.token.bytes().all(|byte|byte.is_ascii_hexdigit())
            ||plan.package_digest.len()!=64||!plan.package_digest.bytes().all(|byte|byte.is_ascii_hexdigit())||plan.journal.parent()!=Some(root){return Err(failure());}
        Ok(plan)
    }
    pub fn helper_main()->Result<(),String>{
        let args=std::env::args().skip(1).collect::<Vec<_>>();
        if args.len()!=3||args[0]!="--install-plan"{return Err("update_helper_arguments".into());}
        let path=PathBuf::from(&args[1]);let digest=&args[2];let plan=read_plan(&path,digest)?;
        let mut platform=NativePlatform{gui_executable:plan.gui_executable.clone(),plan_path:path.clone(),plan_digest:digest.clone(),transaction:plan.transaction.clone()};
        let result=run_helper_protocol(&path,digest,&plan,&mut platform)?;
        if matches!(result.state,InstallState::Installed|InstallState::RolledBack){Ok(())}else{Err(result.error.unwrap_or_else(failure))}
    }
    pub(crate) fn run_helper_protocol(path:&Path,digest:&str,plan:&MacInstallPlan,platform:&mut dyn Platform)->Result<InstallResult,String>{
        use std::io::{BufRead,Read,Write};
        check_ready(plan,platform)?;
        let send=|kind:&str|->Result<(),String>{let mut out=std::io::stdout().lock();serde_json::to_writer(&mut out,&channel_message(kind,&plan,digest)).map_err(|_|failure())?;out.write_all(b"\n").and_then(|_|out.flush()).map_err(|_|"update_helper_channel".into())};
        let (sender,receiver)=std::sync::mpsc::sync_channel(2);
        std::thread::spawn(move||{let mut input=std::io::BufReader::new(std::io::stdin());for _ in 0..2{
            let mut line=String::new();let read=(&mut input).take(8193).read_line(&mut line);
            let message=if read.is_ok()&&line.len()<=8192&&line.ends_with('\n'){serde_json::from_str::<ChannelMessage>(&line).ok()}else{None};
            let valid=message.is_some();let _=sender.send(message);if !valid{break;}
        }});
        send("ready")?;
        let receive=|kind:&str|->Result<(),String>{
            let message=receiver.recv_timeout(std::time::Duration::from_secs(30)).map_err(|_|"update_helper_authority_timeout")?.ok_or("update_helper_channel")?;
            if !valid_message(&message,kind,&plan,digest){return Err("update_helper_authority".into());}Ok(())
        };
        receive("arm")?;send("armed")?;
        // Neither readiness, arm nor a GUI disappearance is installation authority.
        // Only native's actual UpdateCommit RunEvent::Exit can send this token.
        if let Err(code)=receive("commit"){abort_result(&plan,&code);return Err(code);}
        if read_plan(path,digest)?.transaction!=plan.transaction{return Err(failure());}
        Ok(install(plan,platform))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{fs,cell::Cell};
        use sha2::{Digest,Sha256};

        struct Fixture {
            _root:tempfile::TempDir,plan:MacInstallPlan,
        }
        fn digest(bytes:&[u8])->String{format!("{:x}",Sha256::digest(bytes))}
        fn bundle(root:&Path,version:&str)->BundleIdentity {
            fs::create_dir_all(root.join("Contents/MacOS")).unwrap();
            fs::create_dir_all(root.join("Contents/Resources")).unwrap();
            let mut executable=vec![0xcf,0xfa,0xed,0xfe,0x0c,0,0,1];executable.resize(64,0);executable[12..16].copy_from_slice(&2u32.to_le_bytes());
            let mut inventory=BTreeMap::from([("Contents".into(),"directory".into()),("Contents/MacOS".into(),"directory".into()),("Contents/Resources".into(),"directory".into())]);
            let plist=format!(r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>studio.leaf.editor</string><key>CFBundleShortVersionString</key><string>{version}</string><key>CFBundleVersion</key><string>{version}</string><key>CFBundleExecutable</key><string>leaf</string></dict></plist>"#);
            for (name,mut bytes) in [
                ("Contents/Info.plist",plist.into_bytes()),
                ("Contents/MacOS/leaf",executable.clone()),
                ("Contents/MacOS/leaf-mcp-adapter",executable.clone()),
                ("Contents/MacOS/leaf-update-helper",executable),
                ("Contents/Resources/data.txt",format!("synthetic resources {version}").into_bytes()),
            ]{
                if name.starts_with("Contents/MacOS/"){bytes.extend_from_slice(format!("LEAF_UPDATE_BINARY_IDENTITY_V1\0Leaf\0studio.leaf.editor\0{version}\0{}\0",name.rsplit('/').next().unwrap()).as_bytes());}
                fs::write(root.join(name),&bytes).unwrap();inventory.insert(name.into(),digest(&bytes));
                #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;if name.starts_with("Contents/MacOS/"){fs::set_permissions(root.join(name),fs::Permissions::from_mode(0o755)).unwrap();}}
            }
            BundleIdentity{identifier:"studio.leaf.editor".into(),version:version.into(),arch:"aarch64".into(),inventory}
        }
        fn fixture()->Fixture {
            let root=tempfile::tempdir().unwrap();let canonical=root.path().canonicalize().unwrap();let target=canonical.join("Leaf.app");let staged=canonical.join("Prepared.app");
            let old=bundle(&target,"1.0.0");let new=bundle(&staged,"2.0.0");
            let helper=canonical.join("external-helper");fs::copy(staged.join("Contents/MacOS/leaf-update-helper"),&helper).unwrap();
            let journal=canonical.join("result.json");
            use std::os::unix::fs::MetadataExt;
            let metadata=fs::metadata(&target).unwrap();let target_anchor=(metadata.dev(),metadata.ino());
            let gui_executable=target.join("Contents/MacOS/leaf");let created_unix=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
            Fixture{_root:root,plan:MacInstallPlan{transaction:"synthetic-install-1".into(),target,staged,helper,journal,gui_pid:12345,gui_executable,target_anchor,
                package_digest:"0".repeat(64),token:"a".repeat(64),created_unix,old,new}}
        }
        #[derive(Default)]
        struct FixturePlatform {
            signature_bad:bool,occupied:Vec<OwnedProcess>,events:Vec<&'static str>,
            signature_calls:Cell<u32>,exchanges:u32,post_check_bad:bool,swap_back_bad:bool,restarts:u32,
        }
        impl Platform for FixturePlatform {
            fn verify_signature(&self,_:&Path)->Result<(),String>{
                self.signature_calls.set(self.signature_calls.get()+1);
                if self.signature_bad||self.post_check_bad&&self.exchanges==1{Err("fixture_signature_rejected".into())}else{Ok(())}
            }
            fn processes(&self)->Result<Vec<OwnedProcess>,String>{Ok(self.occupied.clone())}
            fn wait_for_exit(&mut self,_:u32)->Result<(),String>{self.events.push("gui_exited");Ok(())}
            fn exchange(&mut self,target:&Path,staged:&Path)->Result<(),String>{
                self.exchanges+=1;self.events.push("exchange");
                if self.swap_back_bad&&self.exchanges==2{return Err("fixture_swap_back_failed".into());}
                // Algorithm fixture only. Task2 must independently prove the
                // native atomic RENAME_SWAP adapter with real platform calls.
                let temporary=target.with_extension("exchange-fixture");
                fs::rename(target,&temporary).map_err(|e|e.to_string())?;
                fs::rename(staged,target).map_err(|e|e.to_string())?;
                fs::rename(temporary,staged).map_err(|e|e.to_string())?;Ok(())
            }
            fn restart(&mut self,_:&Path)->Result<(),String>{self.events.push("restart");self.restarts+=1;Ok(())}
        }
        #[test]
        fn kernel_uuid_exclusion_requires_stable_complete_nonmatching_identity(){
            assert_eq!(kernel_lookup_error(true,Some(3)),"update_install_process_gone");
            for(failed,errno)in [(false,Some(3)),(true,Some(1)),(true,None),(false,None)]{
                assert_eq!(kernel_lookup_error(failed,errno),"update_install_process_query","success/partial reads with stale ESRCH and unknown/denied reads never mean gone");
            }
            let before=ProcessUuid{uuid:[7;16],unique:42,parent:1,version:3,parent_version:1,reserved2:0,reserved3:0};
            let targets=std::collections::BTreeSet::from([[9;16]]);
            assert!(different_image(&before,&before,&targets));
            let zero_version=ProcessUuid{version:0,..before.clone()};
            assert!(different_image(&zero_version,&zero_version,&targets),"a stable counter value zero does not erase a complete kernel identity");
            let matching=std::collections::BTreeSet::from([[7;16]]);assert!(!different_image(&before,&before,&matching));
            assert!(!different_image(&before,&before,&std::collections::BTreeSet::new()));
            for changed in [ProcessUuid{uuid:[0;16],..before.clone()},ProcessUuid{unique:0,..before.clone()},ProcessUuid{version:0,..before.clone()},ProcessUuid{unique:43,..before.clone()},ProcessUuid{version:4,..before.clone()},ProcessUuid{uuid:[8;16],..before.clone()}]{
                assert!(!different_image(&before,&changed,&targets),"unknown, reused or exec-changed identity cannot prove exclusion");
            }
        }
        #[test]
        fn signed_image_exclusion_requires_stable_kernel_text_identity(){
            let before=ProcessUuid{uuid:[0;16],unique:42,parent:1,version:0,parent_version:1,reserved2:0,reserved3:0};
            let targets=std::collections::BTreeSet::from([[9;20]]);
            assert!(different_signed_image(&before,&before,[7;20],[7;20],&targets),"zero UUID needs independent nonzero kernel text cdhash proof");
            assert!(!different_signed_image(&before,&before,[9;20],[9;20],&targets));
            assert!(!different_signed_image(&before,&before,[0;20],[0;20],&targets));
            assert!(!different_signed_image(&before,&before,[7;20],[8;20],&targets));
            assert!(!different_signed_image(&before,&ProcessUuid{unique:43,..before.clone()},[7;20],[7;20],&targets));
            assert!(!different_signed_image(&before,&ProcessUuid{version:1,..before.clone()},[7;20],[7;20],&targets));
            assert!(!different_signed_image(&before,&before,[7;20],[7;20],&std::collections::BTreeSet::new()));
        }
        #[test]
        fn code_directory_parser_covers_primary_alternates_all_slices_and_hash_algorithms(){
            fn thin(types:&[(u8,u8)])->Vec<u8>{
                let mut bytes=vec![0u8;72];bytes[..4].copy_from_slice(&[0xcf,0xfa,0xed,0xfe]);
                bytes[16..20].copy_from_slice(&2u32.to_le_bytes());bytes[20..24].copy_from_slice(&40u32.to_le_bytes());
                bytes[32..36].copy_from_slice(&0x1bu32.to_le_bytes());bytes[36..40].copy_from_slice(&24u32.to_le_bytes());bytes[40..56].fill(1);
                bytes[56..60].copy_from_slice(&0x1du32.to_le_bytes());bytes[60..64].copy_from_slice(&16u32.to_le_bytes());bytes[64..68].copy_from_slice(&72u32.to_le_bytes());
                let header=12+types.len()*8;let used=header+types.len()*44;
                let mut blob=vec![0u8;used+8];blob[..4].copy_from_slice(&0xfade0cc0u32.to_be_bytes());blob[4..8].copy_from_slice(&(used as u32).to_be_bytes());blob[8..12].copy_from_slice(&(types.len() as u32).to_be_bytes());
                for(index,(kind,size))in types.iter().enumerate(){
                    let slot=if index==0{0}else{0x1000+index as u32-1};let offset=header+index*44;
                    blob[12+index*8..16+index*8].copy_from_slice(&slot.to_be_bytes());blob[16+index*8..20+index*8].copy_from_slice(&(offset as u32).to_be_bytes());
                    blob[offset..offset+4].copy_from_slice(&0xfade0c02u32.to_be_bytes());blob[offset+4..offset+8].copy_from_slice(&44u32.to_be_bytes());
                    blob[offset+8..offset+12].copy_from_slice(&0x20001u32.to_be_bytes());blob[offset+36]=*size;blob[offset+37]=*kind;
                }
                bytes[68..72].copy_from_slice(&(blob.len() as u32).to_le_bytes());bytes.extend(blob);bytes
            }
            fn fat(a:&[u8],b:&[u8])->Vec<u8>{
                let mut bytes=vec![0u8;48];bytes[..4].copy_from_slice(&[0xca,0xfe,0xba,0xbe]);bytes[4..8].copy_from_slice(&2u32.to_be_bytes());
                bytes[16..20].copy_from_slice(&48u32.to_be_bytes());bytes[20..24].copy_from_slice(&(a.len() as u32).to_be_bytes());
                bytes[36..40].copy_from_slice(&(48u32+a.len() as u32).to_be_bytes());bytes[40..44].copy_from_slice(&(b.len() as u32).to_be_bytes());bytes.extend(a);bytes.extend(b);bytes
            }
            let bytes=thin(&[(1,20),(2,32),(3,20),(4,48)]);
            let expected=["a121ad43cb2eee138c8245c05e9784c41bb76cf7","4883482e52e0218258850512f1d05b5c85db64da","93be49d3f37a2e33f601ac97501f4890578ff211","863ca62c4515a8ce5232b20ea269f00d69753416"].into_iter()
                .map(|hex|{let mut value=[0u8;20];for(index,byte)in value.iter_mut().enumerate(){*byte=u8::from_str_radix(&hex[index*2..index*2+2],16).unwrap();}value}).collect::<std::collections::BTreeSet<_>>();
            assert_eq!(image_cdhashes(&bytes).unwrap(),expected);assert_eq!(image_cdhashes(&fat(&bytes,&bytes)).unwrap(),expected);
            assert!(image_cdhashes(&thin(&[(2,32),(99,32)])).is_err(),"unknown alternate must not be omitted");
            assert!(image_cdhashes(&fat(&bytes,&thin(&[]))).is_err(),"every slice must contain a primary signature");
            let mut padding=bytes.clone();*padding.last_mut().unwrap()=1;
            assert_eq!(image_cdhashes(&padding).unwrap(),expected,"authenticated allocation tail bytes are outside the embedded signature length");
            let mut raw=bytes[..72].to_vec();let mut directory=vec![0u8;44];
            directory[..4].copy_from_slice(&0xfade0c02u32.to_be_bytes());directory[4..8].copy_from_slice(&44u32.to_be_bytes());directory[8..12].copy_from_slice(&0x20001u32.to_be_bytes());directory[36]=32;directory[37]=2;
            raw[68..72].copy_from_slice(&52u32.to_le_bytes());raw.extend(directory);raw.extend([9u8;8]);
            let raw_hashes=image_cdhashes(&raw).unwrap();assert_eq!(raw_hashes.len(),1);assert!(raw_hashes.is_subset(&expected),"kernel also accepts a raw primary CodeDirectory");
            assert!(image_cdhashes(&bytes[..bytes.len()-9]).is_err(),"truncated signature is refused");
        }
        #[test]
        fn macho_uuid_parser_requires_all_authenticated_slices_and_nonzero_uuid(){
            fn thin(uuid:[u8;16])->Vec<u8>{
                let mut bytes=vec![0u8;56];bytes[..4].copy_from_slice(&[0xcf,0xfa,0xed,0xfe]);
                bytes[16..20].copy_from_slice(&1u32.to_le_bytes());bytes[20..24].copy_from_slice(&24u32.to_le_bytes());
                bytes[32..36].copy_from_slice(&0x1bu32.to_le_bytes());bytes[36..40].copy_from_slice(&24u32.to_le_bytes());bytes[40..56].copy_from_slice(&uuid);bytes
            }
            let a=thin([1;16]);let b=thin([2;16]);assert_eq!(image_uuids(&a).unwrap(),std::collections::BTreeSet::from([[1;16]]));
            let mut fat=vec![0u8;48];fat[..4].copy_from_slice(&[0xca,0xfe,0xba,0xbe]);fat[4..8].copy_from_slice(&2u32.to_be_bytes());
            fat[16..20].copy_from_slice(&48u32.to_be_bytes());fat[20..24].copy_from_slice(&56u32.to_be_bytes());
            fat[36..40].copy_from_slice(&104u32.to_be_bytes());fat[40..44].copy_from_slice(&56u32.to_be_bytes());fat.extend_from_slice(&a);fat.extend_from_slice(&b);
            assert_eq!(image_uuids(&fat).unwrap(),std::collections::BTreeSet::from([[1;16],[2;16]]));
            assert!(image_uuids(&thin([0;16])).is_err());assert!(image_uuids(&a[..55]).is_err());
            fat[104+40..104+56].fill(0);assert!(image_uuids(&fat).is_err(),"one unknown universal slice invalidates the entire exclusion proof");
        }
        #[test]
        fn complete_bundle_identity_rejects_wrong_metadata_signature_and_inventory() {
            let f=fixture();let platform=FixturePlatform::default();
            assert!(validate_bundle(&f.plan.staged,&f.plan.new,&platform).is_ok(),"a complete authenticated expected bundle must validate before readiness");
            for field in ["identifier","version","arch"]{
                let mut wrong=f.plan.new.clone();match field{"identifier"=>wrong.identifier="invalid.example".into(),"version"=>wrong.version="3.0.0".into(),_=>wrong.arch="x86_64".into()};
                assert!(validate_bundle(&f.plan.staged,&wrong,&platform).is_err(),"wrong {field}");
            }
            assert!(validate_bundle(&f.plan.staged,&f.plan.new,&FixturePlatform{signature_bad:true,..Default::default()}).is_err());
            for name in ["Contents/MacOS/leaf-update-helper","Contents/MacOS/leaf-mcp-adapter","Contents/Resources/data.txt"]{
                let path=f.plan.staged.join(name);let before=fs::read(&path).unwrap();fs::write(&path,b"tampered").unwrap();
                assert!(validate_bundle(&f.plan.staged,&f.plan.new,&platform).is_err(),"changed {name}");fs::write(path,before).unwrap();
            }
        }
        #[test]
        fn helper_ready_requires_external_verified_helper_and_unoccupied_target() {
            let f=fixture();let platform=FixturePlatform::default();
            assert!(check_ready(&f.plan,&platform).is_ok(),"a verified external helper and valid unoccupied sibling bundle must become ready");
            let mut inside=f.plan.clone();inside.helper=inside.target.join("Contents/MacOS/leaf-update-helper");
            assert!(check_ready(&inside,&platform).is_err());
            let occupied=FixturePlatform{occupied:vec![OwnedProcess{pid:99999,executable:f.plan.target.join("Contents/MacOS/leaf-mcp-adapter")}],..Default::default()};
            assert!(check_ready(&f.plan,&occupied).is_err());
            let mut changed=f.plan.clone();changed.new.version="3.0.0".into();assert!(check_ready(&changed,&platform).is_err());
        }
        #[test]
        fn root_symlink_and_replaced_target_anchor_are_rejected_before_exchange() {
            let f=fixture();let platform=FixturePlatform::default();let alias=f.plan.target.with_file_name("Alias.app");
            std::os::unix::fs::symlink(&f.plan.target,&alias).unwrap();
            let mut plan=f.plan.clone();plan.target=alias;assert!(check_ready(&plan,&platform).is_err());
            let moved=f.plan.target.with_file_name("retained-old.app");fs::rename(&f.plan.target,&moved).unwrap();bundle(&f.plan.target,"1.0.0");
            assert!(check_ready(&f.plan,&platform).is_err(),"identical bytes at a replaced native target are not the captured target");
        }
        #[test]
        fn replay_install_cannot_exchange_or_overwrite_owner_journal() {
            let f=fixture();let mut platform=FixturePlatform::default();
            fs::write(f.plan.journal.with_extension("install-claim"),b"existing owner").unwrap();fs::write(&f.plan.journal,b"owner journal").unwrap();
            let result=install(&f.plan,&mut platform);
            assert_eq!(result.error.as_deref(),Some("update_install_already_claimed"));assert_eq!(platform.exchanges,0);assert!(platform.events.is_empty());
            assert_eq!(fs::read(&f.plan.journal).unwrap(),b"owner journal");
        }
        #[test]
        fn post_exchange_failure_swaps_back_and_retains_complete_old_bundle() {
            let f=fixture();let mut platform=FixturePlatform{post_check_bad:true,..Default::default()};
            let old=fs::read(f.plan.target.join("Contents/Resources/data.txt")).unwrap();
            let new=fs::read(f.plan.staged.join("Contents/Resources/data.txt")).unwrap();
            let result=install(&f.plan,&mut platform);
            assert_eq!(result.state,InstallState::RolledBack,"post-swap validation failure must complete a truthful rollback");
            assert_eq!(fs::read(f.plan.target.join("Contents/Resources/data.txt")).unwrap(),old);
            assert_eq!(fs::read(f.plan.staged.join("Contents/Resources/data.txt")).unwrap(),new);
            assert_eq!(platform.events,vec!["gui_exited","exchange","exchange"]);assert_eq!(platform.restarts,0);
            let persisted:InstallResult=serde_json::from_slice(&fs::read(&f.plan.journal).unwrap()).unwrap();assert_eq!(persisted.state,InstallState::RolledBack);
        }
        #[test]
        fn failed_swap_back_retains_old_recovery_location_without_restart_or_success() {
            let f=fixture();let mut platform=FixturePlatform{post_check_bad:true,swap_back_bad:true,..Default::default()};
            let result=install(&f.plan,&mut platform);
            assert_eq!(result.state,InstallState::RollbackFailed,"failed swap-back must remain distinct from rollback success");
            assert_eq!(result.old_location,f.plan.staged);
            assert_eq!(fs::read(result.old_location.join("Contents/Resources/data.txt")).unwrap(),b"synthetic resources 1.0.0");
            assert_eq!(result.restart_count,0);assert_eq!(platform.restarts,0);
            let persisted:InstallResult=serde_json::from_slice(&fs::read(&f.plan.journal).unwrap()).unwrap();assert_eq!(persisted.state,InstallState::RollbackFailed);
        }
    }
}
