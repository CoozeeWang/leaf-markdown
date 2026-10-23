//! currentUser-only Windows implementation. All executable paths are absolute;
//! the signed package, not a renderer argument, chooses installer bytes.
use super::*;
use std::{ffi::OsStr,os::windows::{ffi::OsStrExt,io::AsRawHandle,process::CommandExt},process::{Command,Stdio},time::Duration};
use windows_sys::Win32::{Foundation::{CloseHandle,ERROR_FILE_NOT_FOUND,ERROR_NO_MORE_ITEMS,ERROR_SUCCESS},System::{Registry::*,Threading::*}};
fn wide(value:impl AsRef<OsStr>)->Vec<u16>{value.as_ref().encode_wide().chain(Some(0)).collect()}
fn system(name:&str)->PathBuf{PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(||"C:\\Windows".into())).join("System32").join(name)}
fn with_user<T>(f:impl FnOnce(*mut std::ffi::c_void)->Result<T,String>)->Result<T,String>{
    use windows_sys::Win32::Security::*;
    let mut token=std::ptr::null_mut();if unsafe{OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&mut token)}==0{return Err("update_install_owner".into());}
    let mut length=0;unsafe{GetTokenInformation(token,TokenUser,std::ptr::null_mut(),0,&mut length);}
    let mut words=vec![0usize;(length as usize+std::mem::size_of::<usize>()-1)/std::mem::size_of::<usize>()];
    let ok=unsafe{GetTokenInformation(token,TokenUser,words.as_mut_ptr().cast(),length,&mut length)};unsafe{CloseHandle(token);}
    if ok==0{return Err("update_install_owner".into());}let user=unsafe{&*(words.as_ptr() as *const TOKEN_USER)};f(user.User.Sid)
}
/// Drop inherited grants before putting authority, executable code or recovery
/// material in the transaction. The helper independently checks every ACE.
pub fn protect_root(root:&Path)->Result<(),String>{
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    with_user(|sid|{let mut value=std::ptr::null_mut();if unsafe{ConvertSidToStringSidW(sid,&mut value)}==0{return Err("update_install_owner".into());}
        let mut length=0;while length<184&&unsafe{*value.add(length)}!=0{length+=1;}let text=String::from_utf16(unsafe{std::slice::from_raw_parts(value,length)}).map_err(|_|"update_install_owner")?;unsafe{windows_sys::Win32::Foundation::LocalFree(value.cast());}
        let status=Command::new(system("icacls.exe")).arg(root).args(["/inheritance:r","/grant:r"]).arg(format!("*{text}:(OI)(CI)F")).creation_flags(0x08000000).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_|"update_install_permissions")?;
        if !status.success(){return Err("update_install_permissions".into());}
        // Elevated test runners may default directory ownership to the local
        // Administrators group. Bind this fresh directory to the actual user.
        let status=Command::new(system("icacls.exe")).arg(root).arg("/setowner").arg(format!("*{text}")).creation_flags(0x08000000).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_|"update_install_permissions")?;
        if !status.success(){return Err("update_install_permissions".into());}Ok(())})?;
    private_root(root)
}
pub fn private_root(root:&Path)->Result<(),String>{
    use windows_sys::Win32::Security::{*,Authorization::*};
    use std::os::windows::fs::MetadataExt;
    let meta=fs::symlink_metadata(root).map_err(|_|"update_install_permissions")?;
    if !meta.is_dir()||meta.file_attributes()&0x400!=0||root.canonicalize().ok().as_deref()!=Some(root){return Err("update_install_permissions".into());}
    with_user(|sid|{let mut owner=std::ptr::null_mut();let mut dacl=std::ptr::null_mut();let mut descriptor=std::ptr::null_mut();
        let code=unsafe{GetNamedSecurityInfoW(wide(root).as_ptr(),SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&mut owner,std::ptr::null_mut(),&mut dacl,std::ptr::null_mut(),&mut descriptor)};
        if code!=ERROR_SUCCESS{return Err("update_install_permissions".into());}
        let check=(||{if owner.is_null()||dacl.is_null()||unsafe{EqualSid(owner,sid)}==0{return Err("update_install_permissions".into());}
            let mut size:ACL_SIZE_INFORMATION=unsafe{std::mem::zeroed()};if unsafe{GetAclInformation(dacl,(&mut size as *mut ACL_SIZE_INFORMATION).cast(),std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,AclSizeInformation)}==0||size.AceCount==0{return Err("update_install_permissions".into());}
            for index in 0..size.AceCount{let mut ace=std::ptr::null_mut();if unsafe{GetAce(dacl,index,&mut ace)}==0{return Err("update_install_permissions".into());}
                let header=unsafe{&*(ace as *const ACE_HEADER)};
                if header.AceType!=0{return Err("update_install_permissions".into());}
                let allowed=unsafe{&*(ace as *const ACCESS_ALLOWED_ACE)};let granted=(&allowed.SidStart as *const u32).cast_mut().cast();
                if unsafe{EqualSid(granted,sid)}==0{return Err("update_install_permissions".into());}
            }Ok(())})();unsafe{windows_sys::Win32::Foundation::LocalFree(descriptor);}check})
}
pub fn available_bytes(path:&Path)->Result<u64,String>{
    #[link(name="kernel32")]unsafe extern "system"{fn GetDiskFreeSpaceExW(path:*const u16,available:*mut u64,total:*mut u64,free:*mut u64)->i32;}
    let mut available=0;if unsafe{GetDiskFreeSpaceExW(wide(path).as_ptr(),&mut available,std::ptr::null_mut(),std::ptr::null_mut())}==0{return Err("update_install_capacity".into());}Ok(available)
}
pub fn command_path(path:&Path)->String{path.to_string_lossy().strip_prefix("\\\\?\\").unwrap_or(&path.to_string_lossy()).to_owned()}
pub fn anchor(path:&Path)->Result<(u64,[u8;16]),String>{
    #[repr(C)]struct FileId{volume:u64,id:[u8;16]}
    #[link(name="kernel32")]unsafe extern "system"{fn GetFileInformationByHandleEx(handle:*mut std::ffi::c_void,class:i32,info:*mut std::ffi::c_void,size:u32)->i32;}
    use std::os::windows::fs::OpenOptionsExt;
    let file=fs::OpenOptions::new().read(true).custom_flags(0x02000000|0x00200000).open(path).map_err(|_|"update_install_target_identity")?;
    let mut id=FileId{volume:0,id:[0;16]};if unsafe{GetFileInformationByHandleEx(file.as_raw_handle(),18,(&mut id as *mut FileId).cast(),std::mem::size_of::<FileId>() as u32)}==0{return Err("update_install_target_identity".into());}Ok((id.volume,id.id))
}
pub fn single_link(path:&Path)->Result<(),String>{
    #[repr(C)]struct Information{attributes:u32,created:[u32;2],accessed:[u32;2],written:[u32;2],volume:u32,size_high:u32,size_low:u32,links:u32,index_high:u32,index_low:u32}
    #[link(name="kernel32")]unsafe extern "system"{fn GetFileInformationByHandle(handle:*mut std::ffi::c_void,info:*mut Information)->i32;}
    let file=fs::File::open(path).map_err(|_|"update_install_read")?;let mut information:Information=unsafe{std::mem::zeroed()};
    if unsafe{GetFileInformationByHandle(file.as_raw_handle(),&mut information)}==0||information.links!=1{return Err("update_install_hardlink".into());}Ok(())
}
const TREES:&[&str]=&["Software\\leaf\\Leaf","Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Leaf","Software\\Classes\\Markdown document","Software\\Classes\\Directory\\shell\\Leaf.NewMarkdown","Software\\Classes\\Directory\\Background\\shell\\Leaf.NewMarkdown"];
const EXTENSIONS:&[&str]=&["Software\\Classes\\.md","Software\\Classes\\.markdown","Software\\Classes\\.mdown"];
struct Key(HKEY);impl Drop for Key{fn drop(&mut self){unsafe{RegCloseKey(self.0);}}}
fn open(path:&str)->Result<Option<Key>,String>{let mut key=std::ptr::null_mut();let code=unsafe{RegOpenKeyExW(HKEY_CURRENT_USER,wide(path).as_ptr(),0,KEY_READ|KEY_WOW64_64KEY,&mut key)};match code{ERROR_SUCCESS=>Ok(Some(Key(key))),ERROR_FILE_NOT_FOUND=>Ok(None),_=>Err("update_install_registry_read".into())}}
fn values(key:HKEY)->Result<BTreeMap<String,RegistryValue>,String>{
    let mut output=BTreeMap::new();for index in 0..4096{
        let mut name=vec![0u16;16384];let mut name_len=name.len() as u32;let mut data=vec![0u8;1024*1024];let mut size=data.len() as u32;let mut kind=0;
        let code=unsafe{RegEnumValueW(key,index,name.as_mut_ptr(),&mut name_len,std::ptr::null(),&mut kind,data.as_mut_ptr(),&mut size)};
        if code==ERROR_NO_MORE_ITEMS{return Ok(output);}if code!=ERROR_SUCCESS{return Err("update_install_registry_read".into());}
        data.truncate(size as usize);output.insert(String::from_utf16(&name[..name_len as usize]).map_err(|_|"update_install_registry_read")?,RegistryValue{kind,data});
    }Err("update_install_registry_limit".into())
}
pub fn registry()->Result<Registry,String>{
    let mut result=Registry::new();for scope in TREES{let mut pending=vec![scope.to_string()];while let Some(path)=pending.pop(){
        if result.len()>4096{return Err("update_install_registry_limit".into());}let Some(key)=open(&path)?else{result.insert(path,None);continue;};
        result.insert(path.clone(),Some(values(key.0)?));
        for index in 0..4096{let mut name=vec![0u16;16384];let mut size=name.len() as u32;let code=unsafe{RegEnumKeyExW(key.0,index,name.as_mut_ptr(),&mut size,std::ptr::null(),std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut())};
            if code==ERROR_NO_MORE_ITEMS{break;}if code!=ERROR_SUCCESS{return Err("update_install_registry_read".into());}pending.push(format!("{path}\\{}",String::from_utf16(&name[..size as usize]).map_err(|_|"update_install_registry_read")?));
        }
    }}
    for path in EXTENSIONS{let mut selected=BTreeMap::new();if let Some(key)=open(path)?{for(name,value)in values(key.0)?{if name.is_empty()||name=="Markdown document_backup"{selected.insert(name,value);}}}result.insert(path.to_string(),Some(selected));}
    Ok(result)
}
fn create(path:&str)->Result<Key,String>{let mut key=std::ptr::null_mut();if unsafe{RegCreateKeyExW(HKEY_CURRENT_USER,wide(path).as_ptr(),0,std::ptr::null(),0,KEY_WRITE|KEY_WOW64_64KEY,std::ptr::null(),&mut key,std::ptr::null_mut())}!=ERROR_SUCCESS{return Err("update_install_registry_restore".into());}Ok(Key(key))}
fn restore_extensions(snapshot:&Registry)->Result<(),String>{
    // Updating Leaf must not make it the user's default editor or overwrite
    // NSIS's saved previous association. Only these exact two values are ours.
    for path in EXTENSIONS{let entries=snapshot.get(*path).and_then(Option::as_ref).ok_or("update_install_registry_scope")?;let key=create(path)?;
        for name in ["","Markdown document_backup"]{let code=unsafe{RegDeleteValueW(key.0,wide(name).as_ptr())};if code!=ERROR_SUCCESS&&code!=ERROR_FILE_NOT_FOUND{return Err("update_install_registry_restore".into());}}
        for(name,value)in entries{if !name.is_empty()&&name!="Markdown document_backup"{return Err("update_install_registry_scope".into());}
            if unsafe{RegSetValueExW(key.0,wide(name).as_ptr(),0,value.kind,value.data.as_ptr(),value.data.len() as u32)}!=ERROR_SUCCESS{return Err("update_install_registry_restore".into());}}
        if unsafe{RegFlushKey(key.0)}!=ERROR_SUCCESS{return Err("update_install_registry_restore".into());}
    }Ok(())
}
fn restore(registry:&Registry)->Result<(),String>{
    // Scope is fixed by code, never accepted from the persisted plan.
    for path in TREES{let code=unsafe{RegDeleteTreeW(HKEY_CURRENT_USER,wide(path).as_ptr())};if code!=ERROR_SUCCESS&&code!=ERROR_FILE_NOT_FOUND{return Err("update_install_registry_restore".into());}}
    for(path,entries)in registry{
        let tree=TREES.iter().any(|root|path==root||path.starts_with(&format!("{root}\\")));let shared=EXTENSIONS.contains(&path.as_str());
        if !tree&&!shared{return Err("update_install_registry_scope".into());}
        if let Some(entries)=entries{let key=create(path)?;
            if shared{for name in ["","Markdown document_backup"]{let code=unsafe{RegDeleteValueW(key.0,wide(name).as_ptr())};if code!=ERROR_SUCCESS&&code!=ERROR_FILE_NOT_FOUND{return Err("update_install_registry_restore".into());}}}
            for(name,value)in entries{if shared&&!name.is_empty()&&name!="Markdown document_backup"{return Err("update_install_registry_scope".into());}
                if unsafe{RegSetValueExW(key.0,wide(name).as_ptr(),0,value.kind,value.data.as_ptr(),value.data.len() as u32)}!=ERROR_SUCCESS{return Err("update_install_registry_restore".into());}}
            if unsafe{RegFlushKey(key.0)}!=ERROR_SUCCESS{return Err("update_install_registry_restore".into());}
        }
    }Ok(())
}
fn string_value(snapshot:&Registry,path:&str,name:&str)->Option<String>{let value=snapshot.get(path)?.as_ref()?.get(name)?;if value.kind!=REG_SZ||value.data.len()%2!=0{return None;}let words=value.data.chunks_exact(2).map(|p|u16::from_le_bytes([p[0],p[1]])).take_while(|v|*v!=0).collect::<Vec<_>>();String::from_utf16(&words).ok()}
pub fn installed_version(target:&Path,snapshot:&Registry)->Result<String,String>{
    let registered=string_value(snapshot,TREES[0],"").ok_or("update_install_scope")?;
    if fs::canonicalize(registered).ok().as_deref()!=Some(target){return Err("update_install_scope".into());}
    let command=string_value(snapshot,"Software\\Classes\\Markdown document\\shell\\open\\command","").ok_or("update_install_registry_owner")?;
    if !command.eq_ignore_ascii_case(&format!("\"{}\" \"%1\"",command_path(&target.join("leaf.exe")))){return Err("update_install_registry_owner".into());}
    string_value(snapshot,TREES[1],"DisplayVersion").ok_or("update_install_version".into())
}
pub fn verify_binary(path:&Path,version:&str,role:&str)->Result<(),String>{
    let bytes=fs::read(path).map_err(|_|"update_install_binary_identity")?;
    if bytes.len()<256||bytes.len()>512*1024*1024||&bytes[..2]!=b"MZ"{return Err("update_install_binary_identity".into());}
    let offset=u32::from_le_bytes(bytes[60..64].try_into().unwrap()) as usize;
    if offset+24>bytes.len()||&bytes[offset..offset+4]!=b"PE\0\0"||u16::from_le_bytes(bytes[offset+4..offset+6].try_into().unwrap())!=0x8664{return Err("update_install_architecture".into());}
    // Build identity is deliberately assembled at runtime.
    let prefix=String::from_utf8([76,69,65,70,95,85,80,68,65,84,69,95,66,73,78,65,82,89,95,73,68,69,78,84,73,84,89,95,86,49].to_vec()).unwrap();
    let marker=format!("{prefix}\0Leaf\0studio.leaf.editor\0{version}\0{role}\0");
    if !bytes.windows(marker.len()).any(|part|part==marker.as_bytes()){return Err("update_install_binary_identity".into());}Ok(())
}
fn process_path(handle:*mut std::ffi::c_void)->Option<PathBuf>{let mut bytes=vec![0u16;32768];let mut size=bytes.len() as u32;if unsafe{QueryFullProcessImageNameW(handle,0,bytes.as_mut_ptr(),&mut size)}==0{return None;}fs::canonicalize(String::from_utf16(&bytes[..size as usize]).ok()?).ok()}
fn occupancy(plan:&WindowsInstallPlan,allow_gui:bool)->Result<(),String>{
    use windows_sys::Win32::System::ProcessStatus::K32EnumProcesses;
    let mut pids=vec![0u32;65536];let mut count=0;if unsafe{K32EnumProcesses(pids.as_mut_ptr(),(pids.len()*4) as u32,&mut count)}==0||count as usize>=pids.len()*4{return Err("update_install_process_query".into());}
    for pid in pids.into_iter().take(count as usize/4).filter(|pid|*pid!=0){let handle=unsafe{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|0x00100000,0,pid)};if handle.is_null(){continue;}
        let executable=process_path(handle);unsafe{CloseHandle(handle);}
        if let Some(executable)=executable{if executable.starts_with(&plan.target){
            if allow_gui&&pid==plan.gui_pid&&executable==plan.gui_executable{continue;}
            if executable==plan.target.join("leaf-mcp-adapter.exe"){
                let handle=unsafe{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|PROCESS_TERMINATE|0x00100000,0,pid)};
                if handle.is_null(){return Err("update_install_adapter_occupied".into());}
                let valid=process_path(handle).as_ref()==Some(&executable);
                let stopped=valid&&unsafe{TerminateProcess(handle,0)}!=0&&unsafe{WaitForSingleObject(handle,5000)}==0;unsafe{CloseHandle(handle);}
                if !stopped{return Err("update_install_adapter_occupied".into());}
            }else{return Err("update_install_target_occupied".into());}
        }}
    }
    use std::os::windows::fs::OpenOptionsExt;
    for(name,kind)in &plan.old{if kind=="directory"||allow_gui&&name=="leaf.exe"{continue;}
        fs::OpenOptions::new().read(true).write(true).share_mode(0).open(plan.target.join(name)).map_err(|_|"update_install_target_occupied")?;
    }Ok(())
}
pub struct NativePlatform{pub plan_path:PathBuf,pub digest:String}
impl Platform for NativePlatform{
    fn ready(&mut self,plan:&WindowsInstallPlan,allow_gui:bool)->Result<(),String>{
        private_root(plan.journal.parent().ok_or("update_install_plan")?)?;
        if anchor(&plan.target)?!=plan.target_anchor||anchor(&plan.target)?.0!=anchor(plan.journal.parent().ok_or("update_install_plan")?)?.0{return Err("update_install_target_identity".into());}
        for name in ["APPDATA","LOCALAPPDATA"]{if let Some(path)=std::env::var_os(name){if let Ok(path)=fs::canonicalize(path){
            let data=path.join("studio.leaf.editor");
            if path.starts_with(&plan.target)||plan.target==path||plan.target.starts_with(&data)||data.starts_with(&plan.target){return Err("update_install_scope".into());}
        }}}
        if installed_version(&plan.target,&plan.registry)?!=plan.old_version{return Err("update_install_version".into());}
        for role in ["leaf","leaf-mcp-adapter","leaf-update-helper"]{verify_binary(&plan.target.join(format!("{role}.exe")),&plan.old_version,role)?;verify_binary(&plan.staged.join(format!("{role}.exe")),&plan.new_version,role)?;}
        verify_binary(&plan.helper,&plan.new_version,"leaf-update-helper")?;
        let needed=plan.old.iter().filter(|(_,kind)|kind.as_str()!="directory").try_fold(16*1024*1024u64,|size,(path,_)|size.checked_add(fs::metadata(plan.target.join(path)).map_err(|_|"update_install_capacity")?.len()).ok_or("update_install_capacity"))?;
        if available_bytes(plan.journal.parent().ok_or("update_install_plan")?)?<needed{return Err("update_install_insufficient_space".into());}
        let probe=tempfile::NamedTempFile::new_in(&plan.target).map_err(|_|"update_install_target_not_writable")?;drop(probe);
        occupancy(plan,allow_gui)
    }
    fn wait_gui(&mut self,plan:&WindowsInstallPlan)->Result<(),String>{let handle=unsafe{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|0x00100000,0,plan.gui_pid)};if handle.is_null(){return Ok(());}let same=process_path(handle).as_ref()==Some(&plan.gui_executable);let done=!same||unsafe{WaitForSingleObject(handle,30000)}==0;unsafe{CloseHandle(handle);}if done{Ok(())}else{Err("update_gui_exit_timeout".into())}}
    fn registry(&self)->Result<Registry,String>{registry()}
    fn restore_registry(&mut self,registry:&Registry)->Result<(),String>{restore(registry)}
    fn installer(&mut self,plan:&WindowsInstallPlan)->Result<(),String>{
        let installer=plan.staged.join(".leaf-update-installer.exe");
        let mut child=Command::new(installer).args(["/S","/NS","/UPDATE"]).arg(format!("/LEAFTRANSACTION={}",command_path(plan.journal.parent().ok_or("update_install_plan")?)))
            .arg(format!("/D={}",command_path(&plan.target))).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_|"update_install_start")?;
        let deadline=std::time::Instant::now()+Duration::from_secs(120);
        let status=loop{if let Some(status)=child.try_wait().map_err(|_|"update_install_process_failed")?{break status;}
            if std::time::Instant::now()>=deadline{let _=child.kill();let _=child.wait();return Err("update_install_timeout".into());}
            std::thread::sleep(Duration::from_millis(25));
        };
        if !status.success(){return Err("update_install_process_failed".into());}
        if fs::read(plan.journal.with_file_name("installer-complete")).map_err(|_|"update_install_incomplete")?!=plan.transaction.as_bytes(){return Err("update_install_incomplete".into());}
        restore_extensions(&plan.registry)
    }
    fn verify_installed(&self,plan:&WindowsInstallPlan)->Result<(),String>{let current=registry()?;if installed_version(&plan.target,&current)?!=plan.new_version{return Err("update_install_version".into());}if EXTENSIONS.iter().any(|path|current.get(*path)!=plan.registry.get(*path)){return Err("update_install_association_changed".into());}for role in ["leaf","leaf-mcp-adapter","leaf-update-helper"]{verify_binary(&plan.target.join(format!("{role}.exe")),&plan.new_version,role)?;}Ok(())}
    fn restart(&mut self,plan:&WindowsInstallPlan)->Result<(),String>{Command::new(plan.target.join("leaf.exe")).arg("--leaf-update-reconcile").arg(&self.plan_path).arg(&self.digest).arg(&plan.transaction).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_|"update_restart_failed")?;Ok(())}
}
#[derive(Serialize,Deserialize)]#[serde(deny_unknown_fields)]
pub struct ChannelMessage{pub kind:String,pub transaction:String,pub plan_digest:String,pub token:String}
pub fn channel_message(kind:&str,plan:&WindowsInstallPlan,digest:&str)->ChannelMessage{ChannelMessage{kind:kind.into(),transaction:plan.transaction.clone(),plan_digest:digest.into(),token:plan.token.clone()}}
pub fn valid_message(message:&ChannelMessage,kind:&str,plan:&WindowsInstallPlan,digest:&str)->bool{message.kind==kind&&message.transaction==plan.transaction&&message.plan_digest==digest&&message.token==plan.token}
pub fn read_plan(path:&Path,digest:&str,live:bool)->Result<WindowsInstallPlan,String>{
    let root=path.parent().ok_or("update_install_plan")?;let metadata=fs::symlink_metadata(path).map_err(|_|"update_install_plan")?;
    private_root(root)?;
    if metadata.len()>32*1024*1024||metadata.file_type().is_symlink()||path.canonicalize().ok().as_deref()!=Some(path)||!root.file_name().is_some_and(|name|name.to_string_lossy().starts_with(".leaf-update-")){return Err("update_install_plan".into());}
    let bytes=fs::read(path).map_err(|_|"update_install_plan")?;if hash(&bytes)!=digest{return Err("update_install_plan_changed".into());}
    let plan:WindowsInstallPlan=serde_json::from_slice(&bytes).map_err(|_|"update_install_plan")?;
    let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|"update_install_clock")?.as_secs();
    if plan.journal!=root.join("result.json")||plan.helper!=root.join("leaf-update-helper.exe")||plan.staged!=root.join("Prepared")||plan.backup!=root.join("Previous")||plan.target.parent()!=root.parent()||plan.gui_executable!=plan.target.join("leaf.exe")||plan.token.len()!=64||plan.package_digest.len()!=64||live&&(plan.created_unix>now||now-plan.created_unix>120){return Err("update_install_plan".into());}Ok(plan)
}
pub fn helper_main()->Result<(),String>{
    use std::io::{BufRead,BufReader};
    let args=std::env::args().skip(1).collect::<Vec<_>>();if args.len()!=3||args[0]!="--install-plan"{return Err("update_helper_arguments".into());}
    let path=PathBuf::from(&args[1]);let digest=&args[2];let plan=read_plan(&path,digest,true)?;let mut platform=NativePlatform{plan_path:path.clone(),digest:digest.clone()};check_ready(&plan,&mut platform)?;
    let send=|kind:&str|->Result<(),String>{let mut out=std::io::stdout().lock();serde_json::to_writer(&mut out,&channel_message(kind,&plan,digest)).map_err(|_|"update_helper_channel")?;out.write_all(b"\n").and_then(|_|out.flush()).map_err(|_|"update_helper_channel".into())};
    let(sender,receiver)=std::sync::mpsc::sync_channel(2);std::thread::spawn(move||{let mut input=BufReader::new(std::io::stdin());for _ in 0..2{let mut line=String::new();let read=(&mut input).take(8193).read_line(&mut line);let message=if read.is_ok()&&line.len()<=8192&&line.ends_with('\n'){serde_json::from_str::<ChannelMessage>(&line).ok()}else{None};let valid=message.is_some();let _=sender.send(message);if !valid{break;}}});
    let receive=|kind:&str|->Result<(),String>{let message=receiver.recv_timeout(Duration::from_secs(30)).map_err(|_|"update_helper_authority_timeout")?.ok_or("update_helper_channel")?;if valid_message(&message,kind,&plan,digest){Ok(())}else{Err("update_helper_authority".into())}};
    send("ready")?;receive("arm")?;send("armed")?;receive("commit")?;
    read_plan(&path,digest,true)?;
    let marker=hash(format!("{}:{}:{}",plan.transaction,digest,plan.token).as_bytes());
    if fs::read(plan.journal.with_file_name("commit-authorized")).map_err(|_|"update_helper_authority")?!=marker.as_bytes(){return Err("update_helper_authority".into());}
    fs::OpenOptions::new().create_new(true).write(true).open(plan.journal.with_extension("install-claim")).and_then(|file|file.sync_all()).map_err(|_|"update_helper_replayed")?;
    let result=install(&plan,&mut platform);if matches!(result.state,InstallState::Installed|InstallState::RolledBack){Ok(())}else{Err(result.error.unwrap_or_else(||"update_install_failed".into()))}
}

/// Destructive fixture entry point exists only in native-smoke binaries and
/// refuses any machine/root except an explicitly disposable Actions runner.
#[cfg(feature="native-smoke")]
pub fn fixture_main()->Result<(),String>{
    let args=std::env::args().skip(2).collect::<Vec<_>>();if args.len()!=4||std::env::var("GITHUB_ACTIONS").as_deref()!=Ok("true"){return Err("fixture_arguments".into());}
    let runner=fs::canonicalize(std::env::var_os("RUNNER_TEMP").ok_or("fixture_runner")?).map_err(|_|"fixture_runner")?;
    let target=fs::canonicalize(&args[0]).map_err(|_|"fixture_target")?;let source=fs::canonicalize(&args[1]).map_err(|_|"fixture_source")?;
    if !target.starts_with(&runner)||!source.starts_with(&runner)||!target.parent().is_some_and(|p|p.file_name().is_some_and(|n|n.to_string_lossy().starts_with("Leaf update fixture"))){return Err("fixture_scope".into());}
    let root=tempfile::Builder::new().prefix(".leaf-update-").tempdir_in(target.parent().ok_or("fixture_scope")?).map_err(|_|"fixture_root")?;let root_path=root.path().canonicalize().map_err(|_|"fixture_root")?;protect_root(&root_path)?;
    let staged=root_path.join("Prepared");let mut new=inventory(&source)?;copy_tree(&source,&staged,&new)?;let installer_digest=new.remove(".leaf-update-installer.exe").ok_or("fixture_installer")?;
    let helper=root_path.join("leaf-update-helper.exe");fs::copy(staged.join("leaf-update-helper.exe"),&helper).map_err(|_|"fixture_helper")?;
    let registry=registry()?;let old_version=installed_version(&target,&registry)?;
    let plan=WindowsInstallPlan{transaction:format!("fixture-{}",args[3]),target:target.clone(),staged,helper,backup:root_path.join("Previous"),journal:root_path.join("result.json"),gui_pid:std::process::id(),gui_executable:target.join("leaf.exe"),target_anchor:anchor(&target)?,installer_digest,package_digest:"0".repeat(64),token:"a".repeat(64),created_unix:std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|"fixture_clock")?.as_secs(),old_version,new_version:args[2].clone(),old:inventory(&target)?,new,registry};
    let path=root_path.join("plan.json");let bytes=serde_json::to_vec(&plan).map_err(|_|"fixture_plan")?;let digest=hash(&bytes);persist(&path,&bytes)?;persist(&root_path.join("transaction-id"),plan.transaction.as_bytes())?;persist(&root_path.join("commit-authorized"),hash(format!("{}:{}:{}",plan.transaction,digest,plan.token).as_bytes()).as_bytes())?;
    struct Fixture{native:NativePlatform,scenario:String,restarts:u32}
    impl Platform for Fixture{
        fn ready(&mut self,p:&WindowsInstallPlan,allow:bool)->Result<(),String>{self.native.ready(p,allow)}
        fn wait_gui(&mut self,_:&WindowsInstallPlan)->Result<(),String>{Ok(())}
        fn registry(&self)->Result<Registry,String>{self.native.registry()}
        fn restore_registry(&mut self,r:&Registry)->Result<(),String>{if self.scenario=="restore_failure"{Err("fixture_restore_failure".into())}else{self.native.restore_registry(r)}}
        fn installer(&mut self,p:&WindowsInstallPlan)->Result<(),String>{self.native.installer(p)}
        fn verify_installed(&self,p:&WindowsInstallPlan)->Result<(),String>{self.native.verify_installed(p)}
        fn restart(&mut self,p:&WindowsInstallPlan)->Result<(),String>{
            let version=if inventory(&p.target)?==p.new{&p.new_version}else{&p.old_version};
            verify_binary(&p.target.join("leaf.exe"),version,"leaf")?;
            let output=Command::new(p.target.join("leaf.exe")).arg("--leaf-build-identity").stdin(Stdio::null()).stderr(Stdio::null()).output().map_err(|_|"fixture_restart")?;
            if !output.status.success()||!String::from_utf8_lossy(&output.stdout).starts_with(version){return Err("fixture_restart_identity".into());}self.restarts+=1;Ok(())
        }
    }
    let mut platform=Fixture{native:NativePlatform{plan_path:path,digest},scenario:args[3].clone(),restarts:0};
    let output=install(&plan,&mut platform);
    if output.restart_count!=platform.restarts{return Err("fixture_restart_count".into());}
    let current=self::registry()?;
    let evidence=serde_json::json!({"result":output,"fault_hit":fs::read_to_string(root_path.join("fault-hit")).ok(),"old_matches":inventory(&plan.target).ok().as_ref()==Some(&plan.old),"new_matches":inventory(&plan.target).ok().as_ref()==Some(&plan.new),"registry_restored":current==plan.registry,"shared_values_preserved":EXTENSIONS.iter().all(|path|current.get(*path)==plan.registry.get(*path)),"backup_matches":inventory(&plan.backup).ok().as_ref()==Some(&plan.old),"root":root_path});
    // Keep only on fixture failure/recovery failure; PowerShell owns this entire
    // disposable parent and removes it after checking retained recovery hashes.
    let _=root.keep();println!("{}",evidence);Ok(())
}
