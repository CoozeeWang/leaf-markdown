//! One GUI-owned connector tree. Readiness is local evidence, never host proof.
use std::{path::PathBuf,process::{Child,Command,Stdio},time::{Duration,Instant}};
use serde::Serialize;

pub struct TunnelLaunchSpec {
    pub executable:PathBuf,
    pub profile:PathBuf,
    pub generation:u64,
    pub health_file:Option<PathBuf>,
    #[cfg(feature="native-smoke")] pub synthetic:bool,
}
#[derive(Clone,Default,Serialize)]
pub struct TunnelRuntimeStatus {
    pub generation:u64,pub epoch:u64,pub saved_config:bool,pub runtime_present:bool,
    pub process:bool,pub local_ready:bool,pub host_verified:bool,pub last_error:Option<String>,
}
#[derive(Default)]
pub struct TunnelManager { child:Option<OwnedProcess>,status:TunnelRuntimeStatus,health_file:Option<PathBuf>,started:Option<Instant>,failure_pending:bool }
#[cfg(not(windows))] type OwnedProcess=Child;
#[cfg(windows)] type OwnedProcess=windows_tree::OwnedJob;
impl TunnelManager {
    pub fn status(&mut self)->TunnelRuntimeStatus {
        if self.child.as_mut().is_some_and(|c|c.try_wait().ok().flatten().is_some()) {
            let _=self.stop();self.status.last_error=Some("tunnel_exited".into());self.failure_pending=true;
        }
        if self.status.process&&!self.status.local_ready {
            if self.health_file.as_ref().is_some_and(|p|local_ready_probe(p)){self.status.local_ready=true;}
            else if self.health_file.is_some()&&self.started.is_some_and(|s|s.elapsed()>Duration::from_secs(90)) {
                let _=self.stop();self.status.last_error=Some("tunnel_start_timeout".into());self.failure_pending=true;
            }
        }self.status.clone()
    }
    pub fn configured(&mut self,saved:bool,present:bool){self.status.saved_config=saved;self.status.runtime_present=present;}
    // Status callers cannot consume failure notification. Only the native
    // supervisor, serialized with start/stop/configuration, retires access.
    pub fn supervise(&mut self)->bool {
        self.status();
        if !self.status.process&&self.child.is_some(){let _=self.stop();}
        std::mem::take(&mut self.failure_pending)
    }
    #[cfg(feature="native-smoke")]
    pub(crate) fn expire_start_for_test(&mut self){self.started=Some(Instant::now()-Duration::from_secs(91));}
    pub fn start(&mut self,spec:&TunnelLaunchSpec,key:&str)->Result<TunnelRuntimeStatus,String> {
        self.status();
        if self.failure_pending{return Err("tunnel_runtime_failed".into());}
        if self.status.process&&self.status.generation==spec.generation{return Ok(self.status.clone());}
        self.stop()?;
        if key.is_empty(){return Err("runtime_key_required".into());}
        let mut command=Command::new(&spec.executable);
        command.args(["run","--profile-file"]).arg(&spec.profile).env_clear();
        for name in ["HOME","PATH","SYSTEMROOT","WINDIR","TEMP","TMP","LANG"] {if let Some(v)=std::env::var_os(name){command.env(name,v);}}
        command.env("CONTROL_PLANE_API_KEY",key).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(feature="native-smoke")]
        if spec.synthetic {command.env("LEAF_MCP_TEST_PROCESS_ROLE","chatgpt-tunnel-fixture").stderr(Stdio::inherit());if let Some(root)=std::env::var_os("LEAF_MCP_TEST_DIR"){command.env("LEAF_MCP_TEST_DIR",root);}}
        #[cfg(unix)] {use std::os::unix::process::CommandExt;command.process_group(0);}
        #[cfg(not(windows))] {self.child=Some(command.spawn().map_err(|_|"tunnel_spawn_failed")?);}
        #[cfg(windows)] {self.child=Some(windows_tree::OwnedJob::spawn(&command)?);}
        self.health_file=spec.health_file.clone();self.started=Some(Instant::now());
        self.status.generation=spec.generation;self.status.epoch+=1;self.status.process=true;
        self.status.runtime_present=true;self.status.local_ready=false;self.status.host_verified=false;self.status.last_error=None;
        self.failure_pending=false;
        Ok(self.status.clone())
    }
    pub fn local_ready(&mut self,generation:u64,epoch:u64)->bool {
        if self.status().process&&self.status.generation==generation&&self.status.epoch==epoch {self.status.local_ready=true;true}else{false}
    }
    pub fn stop(&mut self)->Result<(),String> {
        self.status.epoch+=1;self.status.process=false;self.status.local_ready=false;self.status.host_verified=false;
        if let Some(child)=self.child.as_mut(){
            #[cfg(unix)] {
                let group=format!("-{}",child.id());
                let _=Command::new("/bin/kill").args(["-KILL","--",&group]).stdout(Stdio::null()).stderr(Stdio::null()).status();
                let _=child.wait();
                let start=Instant::now();
                while Command::new("/bin/kill").args(["-0","--",&group]).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s|s.success()) {
                    if start.elapsed()>Duration::from_secs(3){return Err("tunnel_stop_timeout".into());}
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            #[cfg(windows)] {child.stop()?;}
            #[cfg(not(any(unix,windows)))] {let _=child.kill();let _=child.wait();}
        }
        // Retain the owned process group/Job handles if termination failed.
        self.child=None;Ok(())
    }
}
impl Drop for TunnelManager {fn drop(&mut self){let _=self.stop();}}

fn local_ready_probe(path:&std::path::Path)->bool {
    use std::io::{Read,Write};
    let Ok(url)=std::fs::read_to_string(path) else{return false;};
    let Some(port)=url.trim().strip_prefix("http://127.0.0.1:").and_then(|p|p.parse::<u16>().ok()).filter(|p|*p>0) else{return false;};
    let Ok(mut stream)=std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127,0,0,1],port)),Duration::from_millis(200)) else{return false;};
    let _=stream.set_read_timeout(Some(Duration::from_millis(200)));let _=stream.set_write_timeout(Some(Duration::from_millis(200)));
    if stream.write_all(b"GET /readyz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").is_err(){return false;}
    let mut bytes=[0;128];let n=stream.read(&mut bytes).unwrap_or(0);bytes[..n].starts_with(b"HTTP/1.1 200 ")||bytes[..n].starts_with(b"HTTP/1.0 200 ")
}

// The selected binary is checked against the supported CLI contract. These
// checks establish compatibility, not publisher-signature authenticity.
pub fn validate_input(id:&str,executable:&std::path::Path)->Result<(),String>{
    let segment=|s:&str,len:usize|s.len()==len&&s.bytes().all(|c|c.is_ascii_lowercase()||c.is_ascii_digit());
    if !id.strip_prefix("tunnel_").is_some_and(|s|segment(s,32)||s.split_once('_').is_some_and(|(namespace,value)|segment(namespace,4)&&segment(value,32))){return Err("invalid_tunnel_id".into());}
    if !executable.is_absolute()||!executable.is_file()||!matches!(executable.file_name().and_then(|s|s.to_str()),Some("tunnel-client"|"tunnel-client.exe")){return Err("invalid_tunnel_executable".into());}
    #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;if std::fs::metadata(executable).map_err(|_|"invalid_tunnel_executable")?.permissions().mode()&0o111==0{return Err("invalid_tunnel_executable".into());}}
    Ok(())
}
fn bounded_cli(executable:&std::path::Path,args:&[String],key:Option<&str>,capture:bool)->Result<String,String>{
    use std::io::{Read,Seek};
    let mut output=tempfile::tempfile().map_err(|_|"tunnel_cli_failed")?;
    let mut command=Command::new(executable);command.args(args).env_clear().stdin(Stdio::null()).stderr(Stdio::null());
    for name in ["HOME","PATH","SYSTEMROOT","WINDIR","TEMP","TMP","LANG"] {if let Some(v)=std::env::var_os(name){command.env(name,v);}}
    if let Some(key)=key{command.env("CONTROL_PLANE_API_KEY",key);}
    #[cfg(feature="native-smoke")]
    if is_synthetic_executable(executable){command.env("LEAF_MCP_TEST_PROCESS_ROLE","chatgpt-tunnel-fixture").env("LEAF_MCP_TEST_DIR",std::env::var_os("LEAF_MCP_TEST_DIR").unwrap());}
    command.stdout(if capture{Stdio::from(output.try_clone().map_err(|_|"tunnel_cli_failed")?)}else{Stdio::null()});
    #[cfg(unix)] {use std::os::unix::process::CommandExt;command.process_group(0);}
    #[cfg(not(windows))] let mut child=command.spawn().map_err(|_|"tunnel_cli_failed")?;
    #[cfg(windows)] let mut child=windows_tree::OwnedJob::spawn_with_output(&command,capture.then_some(&output))?;
    let start=Instant::now();
    let result=loop {
        if let Some(status)=child.try_wait().map_err(|_|"tunnel_cli_failed")?{break if status.success(){Ok(())}else{Err("tunnel_cli_rejected")};}
        if start.elapsed()>Duration::from_secs(15){break Err("tunnel_cli_timeout");}
        std::thread::sleep(Duration::from_millis(25));
    };
    #[cfg(unix)] {let _=Command::new("/bin/kill").args(["-KILL","--",&format!("-{}",child.id())]).stdout(Stdio::null()).stderr(Stdio::null()).status();let _=child.wait();}
    #[cfg(windows)] {child.stop()?;}
    result?;
    output.rewind().map_err(|_|"tunnel_cli_failed")?;let mut bytes=Vec::new();output.take(16385).read_to_end(&mut bytes).map_err(|_|"tunnel_cli_failed")?;
    if bytes.len()>16384{return Err("tunnel_cli_contract_changed".into());}String::from_utf8(bytes).map_err(|_|"tunnel_cli_contract_changed".into())
}
pub fn prepare_profile(id:&str,executable:&std::path::Path,directory:&std::path::Path,descriptor:&std::path::Path,key:&str)->Result<super::mcp::ai_credentials::TunnelProfile,String>{
    validate_input(id,executable)?;
    let version=bounded_cli(executable,&["--version".into()],None,true)?;
    if !version.trim().bytes().next().is_some_and(|b|b.is_ascii_digit()){return Err("tunnel_cli_contract_changed".into());}
    for(args,required)in [(vec!["help","quickstart"],vec!["sample_mcp_stdio_local","CONTROL_PLANE_API_KEY"]),(vec!["init","--help"],vec!["--profile-dir","--mcp-command","--control-plane-api-key-ref"]),(vec!["doctor","--help"],vec!["--profile-file"])] {
        let help=bounded_cli(executable,&args.iter().map(|v|v.to_string()).collect::<Vec<_>>(),None,true)?;
        if required.iter().any(|r|!help.contains(r)){return Err("tunnel_cli_contract_changed".into());}
    }
    let helper=std::env::current_exe().map_err(|_|"helper_not_installed")?.parent().unwrap().join(if cfg!(windows){"leaf-mcp-adapter.exe"}else{"leaf-mcp-adapter"});
    if !helper.is_file(){return Err("helper_not_installed".into());}
    std::fs::create_dir_all(directory).map_err(|_|"tunnel_profile_write")?;
    #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(directory,std::fs::Permissions::from_mode(0o700)).map_err(|_|"tunnel_profile_write")?;}
    let staging=tempfile::tempdir_in(directory).map_err(|_|"tunnel_profile_write")?;
    let quote=|p:&std::path::Path|->String{if cfg!(windows){windows_quote(&p.to_string_lossy())}else{format!("'{}'",p.to_string_lossy().replace('\'',"'\\''"))}};
    let fixed_command=format!("{} --descriptor {}",quote(&helper),quote(descriptor));
    let args=vec!["init".into(),"--sample".into(),"sample_mcp_stdio_local".into(),"--profile".into(),"leaf".into(),"--profile-dir".into(),staging.path().to_string_lossy().into_owned(),"--tunnel-id".into(),id.into(),"--mcp-command".into(),fixed_command.clone(),"--control-plane-api-key-ref".into(),"env:CONTROL_PLANE_API_KEY".into(),"--health-listen-addr".into(),"127.0.0.1:0".into()];
    bounded_cli(executable,&args,None,false)?;
    let path=staging.path().join("leaf.yaml");let generated=std::fs::read_to_string(&path).map_err(|_|"tunnel_cli_contract_changed")?;
    if !generated.contains("config_version: 1")||!generated.contains("commands:")||!generated.contains("channel: main")||!generated.contains(&serde_json::to_string(&fixed_command).unwrap())||!generated.contains("env:CONTROL_PLANE_API_KEY")||!generated.contains(id){return Err("tunnel_cli_contract_changed".into());}
    // Use the verified schema with a fixed command; no user-provided command,
    // secret scalar or inherited runtime configuration is accepted.
    let name=super::mcp::ai_credentials::random_token()?;let profile=directory.join(format!("{name}.yaml"));let health=directory.join(format!("{name}.health"));
    let scalar=|s:&str|serde_json::to_string(s).unwrap();
    let text=format!("config_version: 1\ncontrol_plane:\n  base_url: \"https://api.openai.com\"\n  tunnel_id: {}\n  api_key: \"env:CONTROL_PLANE_API_KEY\"\nhealth:\n  listen_addr: \"127.0.0.1:0\"\n  url_file: {}\nadmin_ui:\n  open_browser: false\nlog:\n  level: warn\n  format: json\nmcp:\n  commands:\n    - channel: main\n      command: {}\n",scalar(id),scalar(&health.to_string_lossy()),scalar(&fixed_command));
    std::fs::write(&path,&text).map_err(|_|"tunnel_profile_write")?;
    #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o600)).map_err(|_|"tunnel_profile_write")?;}
    bounded_cli(executable,&["doctor".into(),"--profile-file".into(),path.to_string_lossy().into_owned(),"--explain".into()],Some(key),false)?;
    std::fs::File::open(&path).and_then(|file|file.sync_all()).map_err(|_|"tunnel_profile_write")?;
    std::fs::rename(&path,&profile).map_err(|_|"tunnel_profile_write")?;
    #[cfg(unix)] std::fs::File::open(directory).and_then(|file|file.sync_all()).map_err(|_|"tunnel_profile_write")?;
    use sha2::{Digest,Sha256};
    Ok(super::mcp::ai_credentials::TunnelProfile{tunnel_id:id.into(),executable:executable.to_path_buf(),profile,health_file:health,generation:0,digest:format!("{:x}",Sha256::digest(text.as_bytes()))})
}
pub fn validate_saved(config:&super::mcp::ai_credentials::TunnelProfile,descriptor:&std::path::Path)->Result<(),String>{
    use sha2::{Digest,Sha256};
    validate_input(&config.tunnel_id,&config.executable)?;
    let bytes=std::fs::read(&config.profile).map_err(|_|"tunnel_profile_unavailable")?;
    if format!("{:x}",Sha256::digest(&bytes))!=config.digest{return Err("tunnel_profile_changed".into());}
    let helper=std::env::current_exe().map_err(|_|"helper_not_installed")?.parent().unwrap().join(if cfg!(windows){"leaf-mcp-adapter.exe"}else{"leaf-mcp-adapter"});
    let text=String::from_utf8(bytes).map_err(|_|"tunnel_profile_changed")?;
    // Both paths are inside the hash-bound, fixed-command profile.
    if !helper.is_file()||!text.contains(&helper.to_string_lossy().replace('\\',"\\\\"))||!text.contains(&descriptor.to_string_lossy().replace('\\',"\\\\")){return Err("tunnel_profile_reconfigure_required".into());}Ok(())
}
fn windows_quote(value:&str)->String {let mut out=String::from("\"");let mut slashes=0;for c in value.chars(){if c=='\\'{slashes+=1;continue;}if c=='"'{out.push_str(&"\\".repeat(slashes*2+1));out.push('"');}else{out.push_str(&"\\".repeat(slashes));out.push(c);}slashes=0;}out.push_str(&"\\".repeat(slashes*2));out.push('"');out}

#[cfg(feature="native-smoke")]
pub fn is_synthetic_executable(path:&std::path::Path)->bool {
    let Some(root)=std::env::var_os("LEAF_MCP_TEST_DIR") else{return false;};
    if path!=PathBuf::from(root).join("connector-fixture/tunnel-client"){return false;}
    let Ok(current)=std::env::current_exe().and_then(std::fs::read) else{return false;};
    std::fs::read(path).is_ok_and(|bytes|bytes==current)
}

#[cfg(windows)]
mod windows_tree {
    use super::*;
    use windows_sys::Win32::{Foundation::{HANDLE,CloseHandle,WAIT_OBJECT_0},System::{JobObjects::*,Threading::*}};
    pub struct OwnedJob {job:HANDLE,process:HANDLE}
    // Exclusive ownership is held behind the manager mutex; HANDLE does not
    // encode thread affinity. Closing it kills all assigned descendants.
    unsafe impl Send for OwnedJob {}
    impl OwnedJob {
        pub fn spawn(command:&Command)->Result<Self,String>{Self::spawn_with_output(command,None)}
        pub fn spawn_with_output(command:&Command,output:Option<&std::fs::File>)->Result<Self,String>{unsafe{
            let job=CreateJobObjectW(std::ptr::null(),std::ptr::null());if job.is_null(){return Err("tunnel_job_failed".into());}
            let mut owned=Self{job,process:std::ptr::null_mut()};
            let mut limits:JOBOBJECT_EXTENDED_LIMIT_INFORMATION=std::mem::zeroed();limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(job,JobObjectExtendedLimitInformation,(&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),std::mem::size_of_val(&limits) as u32)==0{return Err("tunnel_job_failed".into());}
            let wide=|v:&std::ffi::OsStr|{use std::os::windows::ffi::OsStrExt;v.encode_wide().chain(Some(0)).collect::<Vec<_>>()};
            let executable=wide(command.get_program());let mut line=wide(std::ffi::OsStr::new(&std::iter::once(command.get_program()).chain(command.get_args()).map(|v|windows_quote(&v.to_string_lossy())).collect::<Vec<_>>().join(" ")));
            let mut env=Vec::<u16>::new();for(k,v)in command.get_envs().filter_map(|(k,v)|v.map(|v|(k,v))){env.extend(wide(std::ffi::OsStr::new(&format!("{}={}",k.to_string_lossy(),v.to_string_lossy()))));}env.push(0);
            let mut startup:STARTUPINFOW=std::mem::zeroed();startup.cb=std::mem::size_of_val(&startup) as u32;let mut info:PROCESS_INFORMATION=std::mem::zeroed();
            let stdout=output.map(|file|{use std::os::windows::io::AsRawHandle;file.as_raw_handle() as HANDLE});
            if let Some(handle)=stdout {if windows_sys::Win32::Foundation::SetHandleInformation(handle,windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT,windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT)==0{return Err("tunnel_cli_failed".into());}startup.dwFlags=STARTF_USESTDHANDLES;startup.hStdOutput=handle;}
            let created=CreateProcessW(executable.as_ptr(),line.as_mut_ptr(),std::ptr::null(),std::ptr::null(),i32::from(stdout.is_some()),CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW,env.as_ptr().cast(),std::ptr::null(),&startup,&mut info);
            if let Some(handle)=stdout {windows_sys::Win32::Foundation::SetHandleInformation(handle,windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT,0);}
            if created==0{return Err("tunnel_spawn_failed".into());}
            owned.process=info.hProcess;
            if AssignProcessToJobObject(job,info.hProcess)==0 {TerminateProcess(info.hProcess,1);CloseHandle(info.hThread);return Err("tunnel_job_assign_failed".into());}
            if ResumeThread(info.hThread)==u32::MAX{CloseHandle(info.hThread);return Err("tunnel_job_resume_failed".into());}CloseHandle(info.hThread);Ok(owned)
        }}
        pub fn try_wait(&mut self)->std::io::Result<Option<std::process::ExitStatus>>{unsafe{
            if WaitForSingleObject(self.process,0)!=WAIT_OBJECT_0{return Ok(None);}
            let mut code=0;if GetExitCodeProcess(self.process,&mut code)==0{return Err(std::io::Error::last_os_error());}use std::os::windows::process::ExitStatusExt;Ok(Some(std::process::ExitStatus::from_raw(code)))
        }}
        pub fn stop(&mut self)->Result<(),String>{unsafe{
            if TerminateJobObject(self.job,1)==0{return Err("tunnel_job_stop_failed".into());}
            let start=Instant::now();loop {
                let mut info:JOBOBJECT_BASIC_ACCOUNTING_INFORMATION=std::mem::zeroed();
                if QueryInformationJobObject(self.job,JobObjectBasicAccountingInformation,(&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),std::mem::size_of_val(&info) as u32,std::ptr::null_mut())==0{return Err("tunnel_job_query_failed".into());}
                if info.ActiveProcesses==0{return Ok(());}if start.elapsed()>Duration::from_secs(3){return Err("tunnel_stop_timeout".into());}std::thread::sleep(Duration::from_millis(20));
            }
        }}
    }
    impl Drop for OwnedJob {fn drop(&mut self){unsafe{if !self.job.is_null(){CloseHandle(self.job);}if !self.process.is_null(){CloseHandle(self.process);}}}}
}

#[cfg(feature="native-smoke")]
pub fn synthetic_fixture_main()->i32 {
    // This executable branch precedes Tauri and is absent from production builds.
    let result=(||->Result<(),String>{
        let args=std::env::args().collect::<Vec<_>>();
        let value=|flag:&str|args.iter().position(|a|a==flag).and_then(|i|args.get(i+1)).cloned().ok_or_else(||"fixture_arguments".to_string());
        if args.get(1).is_some_and(|s|s=="--version"){println!("0.0.16 synthetic fixture; not official binary");return Ok(());}
        if args.get(1).is_some_and(|s|s=="help")||args.iter().any(|s|s=="--help"){println!("sample_mcp_stdio_local CONTROL_PLANE_API_KEY --profile-dir --mcp-command --control-plane-api-key-ref --profile-file");return Ok(());}
        if args.get(1).is_some_and(|s|s=="init") {
            if value("--sample")?!="sample_mcp_stdio_local"||value("--control-plane-api-key-ref")?!="env:CONTROL_PLANE_API_KEY"{return Err("fixture_init_contract".into());}
            let directory=PathBuf::from(value("--profile-dir")?);std::fs::create_dir_all(&directory).map_err(|_|"fixture_init")?;
            let text=format!("config_version: 1\ncontrol_plane:\n  tunnel_id: {}\n  api_key: \"env:CONTROL_PLANE_API_KEY\"\nmcp:\n  commands:\n    - channel: main\n      command: {}\n",serde_json::to_string(&value("--tunnel-id")?).unwrap(),serde_json::to_string(&value("--mcp-command")?).unwrap());
            std::fs::write(directory.join(format!("{}.yaml",value("--profile")?)),text).map_err(|_|"fixture_init")?;return Ok(());
        }
        let profile=args.iter().position(|v|v=="--profile"||v=="--profile-file").and_then(|i|args.get(i+1)).ok_or("fixture_profile")?;
        let bytes=std::fs::read(profile).map_err(|_|"fixture_profile")?;let mut health_file=None;
        let profile:serde_json::Value=if profile.ends_with(".json"){serde_json::from_slice(&bytes).map_err(|_|"fixture_profile")?}else{
            let text=String::from_utf8(bytes).map_err(|_|"fixture_profile")?;
            if !text.contains("env:CONTROL_PLANE_API_KEY")||!text.contains("commands:"){return Err("fixture_profile_contract".into());}
            if args.get(1).is_some_and(|s|s=="doctor") {
                if std::env::var("CONTROL_PLANE_API_KEY").ok().as_deref()!=Some("synthetic-tunnel-key-sentinel"){return Err("fixture_environment".into());}return Ok(());
            }
            let root=PathBuf::from(std::env::var_os("LEAF_MCP_TEST_DIR").ok_or("fixture_directory")?);
            health_file=text.lines().find_map(|line|line.trim().strip_prefix("url_file: ")).and_then(|v|serde_json::from_str::<String>(v).ok());
            let input:serde_json::Value=serde_json::from_slice(&std::fs::read(root.join("fixture-input.json")).map_err(|_|"fixture_input")?).map_err(|_|"fixture_input")?;
            if !text.contains(&input["helper"].as_str().ok_or("fixture_helper")?.replace('\\',"\\\\")){return Err("fixture_helper_contract".into());}input
        };
        if std::env::var("CONTROL_PLANE_API_KEY").ok().as_deref()!=Some("synthetic-tunnel-key-sentinel"){return Err("fixture_environment".into());}
        let runtime=tokio::runtime::Runtime::new().map_err(|_|"fixture_runtime")?;
        runtime.block_on(async {
            use rmcp::ServiceExt;
            if profile["mode"]=="hang-start"{
                let descendant=Command::new(if cfg!(windows){"timeout.exe"}else{"/bin/sleep"}).arg("30").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_|"fixture_descendant")?;
                std::fs::write(profile["evidence"].as_str().ok_or("fixture_evidence")?,serde_json::to_vec(&serde_json::json!({"connector_pid":std::process::id(),"descendant_pid":descendant.id(),"host_verified":false})).unwrap()).map_err(|_|"fixture_evidence")?;
                std::future::pending::<()>().await;
            }
            let helper=if let Some(path)=profile["helper"].as_str(){PathBuf::from(path)}else{std::env::current_exe().map_err(|_|"fixture_executable")?.parent().unwrap().join(if cfg!(windows){"leaf-mcp-adapter.exe"}else{"leaf-mcp-adapter"})};
            let mut command=tokio::process::Command::new(helper);
            if let Some(trace)=profile["adapter_env"].as_str(){command.env("LEAF_MCP_TEST_ADAPTER_ENV_TRACE",trace);}
            if let Some(trace)=profile["adapter_trace"].as_str(){command.env("LEAF_MCP_TEST_TRACE",trace);}
            command.args(["--descriptor",profile["descriptor"].as_str().ok_or("fixture_descriptor")?]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).kill_on_drop(true);
            let mut child=command.spawn().map_err(|_|"fixture_adapter")?;
            let client=().serve((child.stdout.take().unwrap(),child.stdin.take().unwrap())).await.map_err(|_|"fixture_stdio")?;
            let response=client.call_tool(serde_json::from_value(serde_json::json!({"name":"read_document","arguments":profile["binding"]})).unwrap()).await.map_err(|_|"fixture_read")?;
            let result=serde_json::to_value(response).map_err(|_|"fixture_result")?;
            if result["isError"]==true||result["structuredContent"]["content"]!="Synthetic live Tunnel buffer" {return Err("fixture_live_buffer".into());}
            let descendant=Command::new(if cfg!(windows){"timeout.exe"}else{"/bin/sleep"}).arg("30").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_|"fixture_descendant")?;
            let proof=serde_json::json!({"adapter_stdio":true,"live_buffer":true,"host_verified":false,"connector_pid":std::process::id(),"helper_pid":child.id(),"descendant_pid":descendant.id()});
            std::fs::write(profile["evidence"].as_str().ok_or("fixture_evidence")?,serde_json::to_vec(&proof).unwrap()).map_err(|_|"fixture_evidence")?;
            if profile["mode"]=="crash-root"{std::process::exit(7);}
            if let Some(file)=health_file {
                let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|_|"fixture_health")?;
                std::fs::write(file,format!("http://127.0.0.1:{}",listener.local_addr().unwrap().port())).map_err(|_|"fixture_health")?;
                tokio::spawn(async move{use tokio::io::{AsyncReadExt,AsyncWriteExt};while let Ok((mut stream,_))=listener.accept().await {let mut request=[0;1024];let _=stream.read(&mut request).await;let _=stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK").await;}});
            }
            // Keep the real adapter connected so its authenticated heartbeat remains independent.
            if profile["mode"]=="crash-on-command" {
                let signal=PathBuf::from(std::env::var_os("LEAF_MCP_TEST_DIR").ok_or("fixture_directory")?).join("fixture-crash.signal");
                while !signal.exists(){tokio::time::sleep(Duration::from_millis(25)).await;}
                std::process::exit(7);
            }
            std::future::pending::<()>().await;Ok(())
        })
    })();
    if let Err(category)=result {eprintln!("Leaf synthetic tunnel: {category}");1}else{0}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tunnel_id_and_windows_argument_boundaries(){
        assert_eq!(windows_quote("C:\\Public Example\\tunnel-client.exe"),"\"C:\\Public Example\\tunnel-client.exe\"");
        assert!(validate_input("",std::path::Path::new("/synthetic/tunnel-client")).is_err());
        assert!(validate_input(&format!("tunnel_{}","A".repeat(32)),std::path::Path::new("/synthetic/tunnel-client")).is_err());
        assert!(validate_input(&format!("tunnel_{}","a".repeat(32)),std::path::Path::new("relative/tunnel-client")).is_err());
    }
    #[cfg(unix)]
    fn fixture(directory:&std::path::Path,body:&str)->PathBuf{
        use std::os::unix::fs::PermissionsExt;
        let path=directory.join("synthetic-connector");std::fs::write(&path,format!("#!/bin/sh\n{body}\n")).unwrap();std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o700)).unwrap();path
    }
    #[cfg(unix)]
    fn spec(path:PathBuf)->TunnelLaunchSpec {TunnelLaunchSpec{executable:path,profile:"synthetic-profile".into(),generation:1,health_file:None,#[cfg(feature="native-smoke")]synthetic:false}}
    #[cfg(unix)]
    #[test]
    fn single_tree_idempotence_and_stale_readiness(){
        let directory=tempfile::tempdir().unwrap();let launch=spec(fixture(directory.path(),"sleep 30 & wait"));let mut manager=TunnelManager::default();
        let first=manager.start(&launch,"synthetic-unit-key").unwrap();let root=manager.child.as_ref().unwrap().id();
        let again=manager.start(&launch,"synthetic-unit-key").unwrap();assert_eq!(manager.child.as_ref().unwrap().id(),root);assert_eq!(first.epoch,again.epoch);
        assert!(manager.local_ready(1,first.epoch));assert!(!manager.status().host_verified);
        manager.stop().unwrap();assert!(!manager.local_ready(1,first.epoch));assert!(!manager.status().process);
        assert!(!Command::new("/bin/kill").args(["-0","--",&format!("-{root}")]).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap().success());
    }
    #[cfg(unix)]
    #[test]
    fn startup_timeout_and_parent_exit_kill_owned_descendants(){
        let directory=tempfile::tempdir().unwrap();let mut launch=spec(fixture(directory.path(),"sleep 30 & wait"));launch.health_file=Some(directory.path().join("missing-health"));
        let mut manager=TunnelManager::default();manager.start(&launch,"synthetic-unit-key").unwrap();manager.started=Some(Instant::now()-Duration::from_secs(91));
        assert_eq!(manager.status().last_error.as_deref(),Some("tunnel_start_timeout"));assert!(!manager.status().process);
        assert!(manager.start(&launch,"synthetic-unit-key").is_err(),"restart cannot consume a failure before native capability retirement");
        assert!(manager.supervise(),"a prior status observation cannot consume native failure invalidation");
        assert!(!manager.supervise(),"one failed generation invalidates once");
        launch.executable=fixture(directory.path(),"sleep 30 & exit 1");launch.health_file=None;manager.start(&launch,"synthetic-unit-key").unwrap();let root=manager.child.as_ref().unwrap().id();
        for _ in 0..100{if !manager.status().process{break;}std::thread::sleep(Duration::from_millis(10));}
        assert_eq!(manager.status().last_error.as_deref(),Some("tunnel_exited"));
        assert!(manager.supervise());assert!(!manager.supervise());
        assert!(!Command::new("/bin/kill").args(["-0","--",&format!("-{root}")]).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap().success());
    }
    #[test]
    fn windows_source_owns_job_before_running_and_never_reacquires_pid(){
        let source=include_str!("chatgpt_tunnel.rs");let implementation=source.split("mod windows_tree {").nth(1).unwrap().split("#[cfg(feature=\"native-smoke\")]").next().unwrap();
        assert!(implementation.contains("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE")&&implementation.contains("CREATE_SUSPENDED"));
        assert!(implementation.find("AssignProcessToJobObject(job,info.hProcess)").unwrap()<implementation.find("ResumeThread(info.hThread)").unwrap());
        assert!(implementation.contains("QueryInformationJobObject(self.job")&&implementation.contains("info.ActiveProcesses==0"));
        assert!(!implementation.contains("taskkill")&&!implementation.contains("OpenProcess("));
    }
}
