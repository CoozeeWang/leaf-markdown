//! One GUI-owned connector tree. Readiness is local evidence, never host proof.
use std::{path::PathBuf,process::{Child,Command,Stdio},time::{Duration,Instant}};
use serde::Serialize;

pub struct TunnelLaunchSpec {
    pub executable:PathBuf,
    pub proxy_url:String,
    pub profile:PathBuf,
    pub generation:u64,
    pub health_file:Option<PathBuf>,
    #[cfg(feature="native-smoke")] pub synthetic:bool,
}
#[derive(Clone,Default,Serialize)]
pub struct TunnelRuntimeStatus {
    pub generation:u64,pub epoch:u64,pub saved_config:bool,pub runtime_present:bool,
    pub process:bool,pub local_ready:bool,pub cloud_connected:bool,pub host_verified:bool,pub last_error:Option<String>,
    pub proxy_source:String,pub cloud_state:String,pub consecutive_failures:u64,pub http_status:u64,pub tunnel_instance:Option<String>,
}
#[derive(Default)]
pub struct TunnelManager { child:Option<OwnedProcess>,status:TunnelRuntimeStatus,health_file:Option<PathBuf>,started:Option<Instant>,last_probe:Option<Instant>,failure_pending:bool }
#[cfg(not(windows))] type OwnedProcess=Child;
#[cfg(windows)] type OwnedProcess=windows_tree::OwnedJob;
impl TunnelManager {
    pub fn status(&mut self)->TunnelRuntimeStatus {
        if self.child.as_mut().is_some_and(|c|c.try_wait().ok().flatten().is_some()) {
            let _=self.stop();self.status.last_error=Some("tunnel_exited".into());self.failure_pending=true;
        }
        if self.status.process&&self.last_probe.is_none_or(|at|at.elapsed()>Duration::from_secs(2)) {
            self.last_probe=Some(Instant::now());
            if let Some(path)=&self.health_file {
                self.status.local_ready=local_ready_probe(path);
                match health_request(path,"/health?details=true").and_then(|bytes|serde_json::from_slice::<serde_json::Value>(&bytes).ok()) {
                    Some(value) if value["schema_version"]==1=>self.status.observe_health(&value),
                    _=>{self.status.cloud_connected=false;self.status.cloud_state="unknown".into();self.status.last_error=Some("tunnel_health_unavailable".into());}
                }
                if !self.status.local_ready&&self.started.is_some_and(|s|s.elapsed()>Duration::from_secs(90)) {
                    let _=self.stop();self.status.last_error=Some("tunnel_start_timeout".into());self.failure_pending=true;
                }
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
        let route=super::tunnel_proxy::resolve(&spec.proxy_url).inspect_err(|error|{self.status.last_error=Some(error.clone());})?;
        let mut command=Command::new(&spec.executable);
        command.args(["run","--profile-file"]).arg(&spec.profile).env_clear();
        for name in ["HOME","PATH","SYSTEMROOT","WINDIR","TEMP","TMP","LANG"] {if let Some(v)=std::env::var_os(name){command.env(name,v);}}
        route.apply(&mut command);
        command.env("CONTROL_PLANE_API_KEY",key).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(feature="native-smoke")]
        if spec.synthetic {command.env("LEAF_MCP_TEST_PROCESS_ROLE","chatgpt-tunnel-fixture").stderr(Stdio::inherit());if let Some(root)=std::env::var_os("LEAF_MCP_TEST_DIR"){command.env("LEAF_MCP_TEST_DIR",root);}}
        #[cfg(unix)] {use std::os::unix::process::CommandExt;command.process_group(0);}
        #[cfg(not(windows))] {self.child=Some(command.spawn().map_err(|_|"tunnel_spawn_failed")?);}
        #[cfg(windows)] {
            // Controlled network tests can capture their synthetic child only.
            // Production never retains connector logs or credential-bearing output.
            #[cfg(test)] let log=std::env::var_os("LEAF_PROXY_TEST_LOG").map(std::fs::File::create).transpose().map_err(|_|"test_log_failed")?;
            #[cfg(not(test))] let log:Option<std::fs::File>=None;
            self.child=Some(windows_tree::OwnedJob::spawn_with_output(&command,log.as_ref())?);
        }
        self.health_file=spec.health_file.clone();self.started=Some(Instant::now());self.last_probe=None;
        self.status.proxy_source=route.source.into();self.status.cloud_state="starting".into();self.status.cloud_connected=false;self.status.consecutive_failures=0;self.status.http_status=0;self.status.tunnel_instance=None;
        self.status.generation=spec.generation;self.status.epoch+=1;self.status.process=true;
        self.status.runtime_present=true;self.status.local_ready=false;self.status.host_verified=false;self.status.last_error=None;
        self.failure_pending=false;
        Ok(self.status.clone())
    }
    pub fn local_ready(&mut self,generation:u64,epoch:u64)->bool {
        if self.status().process&&self.status.generation==generation&&self.status.epoch==epoch {self.status.local_ready=true;true}else{false}
    }
    pub fn stop(&mut self)->Result<(),String> {
        self.status.epoch+=1;self.status.cloud_connected=false;self.status.cloud_state="stopped".into();self.status.last_error=None;self.status.tunnel_instance=None;self.status.consecutive_failures=0;self.status.http_status=0;self.status.process=false;self.status.local_ready=false;self.status.host_verified=false;
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

// Probe HTTP/1.0 over a literal loopback socket: no proxy, redirects or
// inherited HTTP credentials. Bound time, allocation and accepted URL shape.
fn health_request(path:&std::path::Path,route:&str)->Option<Vec<u8>> {
    use std::io::{Read,Write};
    let url=std::fs::read_to_string(path).ok()?;
    let port=url.trim().strip_prefix("http://127.0.0.1:")?.parse::<u16>().ok().filter(|p|*p>0)?;
    let mut stream=std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127,0,0,1],port)),Duration::from_millis(200)).ok()?;
    stream.set_read_timeout(Some(Duration::from_millis(200))).ok()?;stream.set_write_timeout(Some(Duration::from_millis(200))).ok()?;
    stream.write_all(format!("GET {route} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n").as_bytes()).ok()?;
    let mut bytes=Vec::new();stream.take(131073).read_to_end(&mut bytes).ok()?;
    if bytes.len()>131072||!(bytes.starts_with(b"HTTP/1.1 200 ")||bytes.starts_with(b"HTTP/1.0 200 ")){return None;}
    let boundary=bytes.windows(4).position(|part|part==b"\r\n\r\n")?+4;Some(bytes[boundary..].to_vec())
}
fn local_ready_probe(path:&std::path::Path)->bool {health_request(path,"/readyz").is_some()}
impl TunnelRuntimeStatus {
    fn observe_health(&mut self,value:&serde_json::Value){
        let control=&value["components"]["control-plane"];let detail=&control["details"];
        self.consecutive_failures=detail["consecutive_failures"].as_u64().unwrap_or(0);
        self.http_status=detail["http_status"].as_u64().unwrap_or(0);
        self.cloud_state=match control["state"].as_str().unwrap_or(""){state @ ("starting"|"polling"|"idle"|"backoff"|"backpressured"|"stopped")=>state,_=>"unknown"}.into();
        self.tunnel_instance=value["runtime"]["instance_id"].as_str().filter(|s|s.len()<=64&&s.bytes().all(|b|b.is_ascii_hexdigit()||b==b'-')).map(str::to_owned);
        let stalled=detail["deadline_seconds"].as_f64().is_some_and(|deadline|deadline>0.0&&detail["current_poll_age_seconds"].as_f64().unwrap_or(0.0)>deadline+15.0);
        self.cloud_connected=control["status"]=="ok"&&detail["last_success"].is_string()&&self.consecutive_failures==0&&!stalled&&matches!(self.cloud_state.as_str(),"polling"|"idle"|"backpressured");
        self.last_error=if self.consecutive_failures>0||stalled {
            Some(match (self.http_status,detail["failure_category"].as_str().or(control["reason_code"].as_str()).unwrap_or("")){
                (401|403,_)=>"tunnel_cloud_auth",(_,"network_error"|"timeout"|"deadline_exceeded")=>"tunnel_network_proxy",_ if stalled=>"tunnel_network_proxy",_=>"tunnel_cloud_poll_failed"
            }.into())
        }else if self.cloud_state=="unknown"{Some("tunnel_health_unavailable".into())}else{None};
        let delivery=&value["components"]["response-delivery"];
        if self.last_error.is_none()&&delivery["status"]=="degraded"{self.cloud_connected=false;self.last_error=Some("tunnel_cloud_delivery_failed".into());}
    }
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
    let helper=std::env::current_exe().map_err(|_|"helper_not_installed")?.parent().unwrap().join(if cfg!(windows){"leaf-mcp-adapter.exe"}else{"leaf-mcp-adapter"});
    prepare_profile_with_helper(id,executable,directory,descriptor,key,&helper)
}
fn prepare_profile_with_helper(id:&str,executable:&std::path::Path,directory:&std::path::Path,descriptor:&std::path::Path,key:&str,helper:&std::path::Path)->Result<super::mcp::ai_credentials::TunnelProfile,String>{
    validate_input(id,executable)?;
    let version=bounded_cli(executable,&["--version".into()],None,true)?;
    if !version.trim().bytes().next().is_some_and(|b|b.is_ascii_digit()){return Err("tunnel_cli_contract_changed".into());}
    for(args,required)in [(vec!["help","quickstart"],vec!["sample_mcp_stdio_local","CONTROL_PLANE_API_KEY"]),(vec!["init","--help"],vec!["--profile-dir","--mcp-command","--control-plane-api-key-ref"]),(vec!["doctor","--help"],vec!["--profile-file"])] {
        let help=bounded_cli(executable,&args.iter().map(|v|v.to_string()).collect::<Vec<_>>(),None,true)?;
        if required.iter().any(|r|!help.contains(r)){return Err("tunnel_cli_contract_changed".into());}
    }
    if !helper.is_file(){return Err("helper_not_installed".into());}
    std::fs::create_dir_all(directory).map_err(|_|"tunnel_profile_write")?;
    #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(directory,std::fs::Permissions::from_mode(0o700)).map_err(|_|"tunnel_profile_write")?;}
    let staging=tempfile::tempdir_in(directory).map_err(|_|"tunnel_profile_write")?;
    let fixed_command=tunnel_command(helper,descriptor,cfg!(windows));
    let args=vec!["init".into(),"--sample".into(),"sample_mcp_stdio_local".into(),"--profile".into(),"leaf".into(),"--profile-dir".into(),staging.path().to_string_lossy().into_owned(),"--tunnel-id".into(),id.into(),"--mcp-command".into(),fixed_command.clone(),"--control-plane-api-key-ref".into(),"env:CONTROL_PLANE_API_KEY".into(),"--health-listen-addr".into(),"127.0.0.1:0".into()];
    bounded_cli(executable,&args,None,false).map_err(|e|cli_stage("init",e))?;
    let path=staging.path().join("leaf.yaml");let generated=std::fs::read_to_string(&path).map_err(|_|"tunnel_cli_contract_changed")?;
    if !generated.contains("config_version: 1")||!generated.contains("commands:")||!generated.contains("channel: main")||!generated.contains(&serde_json::to_string(&fixed_command).unwrap())||!generated.contains("env:CONTROL_PLANE_API_KEY")||!generated.contains(id){return Err("tunnel_cli_contract_changed".into());}
    // Use the verified schema with a fixed command; no user-provided command,
    // secret scalar or inherited runtime configuration is accepted.
    let name=super::mcp::ai_credentials::random_token()?;let profile=directory.join(format!("{name}.yaml"));let health=directory.join(format!("{name}.health"));
    let scalar=|s:&str|serde_json::to_string(s).unwrap();
    let text=format!("config_version: 1\ncontrol_plane:\n  base_url: \"https://api.openai.com\"\n  tunnel_id: {}\n  api_key: \"env:CONTROL_PLANE_API_KEY\"\nhealth:\n  listen_addr: \"127.0.0.1:0\"\n  url_file: {}\nadmin_ui:\n  open_browser: false\nlog:\n  level: warn\n  format: json\nmcp:\n  commands:\n    - channel: main\n      command: {}\n",scalar(id),scalar(&health.to_string_lossy()),scalar(&fixed_command));
    std::fs::write(&path,&text).map_err(|_|"tunnel_profile_write")?;
    #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o600)).map_err(|_|"tunnel_profile_write")?;}
    bounded_cli(executable,&["doctor".into(),"--profile-file".into(),path.to_string_lossy().into_owned(),"--explain".into()],Some(key),false).map_err(|e|cli_stage("doctor",e))?;
    // Windows FlushFileBuffers requires a writable handle. File::open is
    // read-only and makes an otherwise valid generated profile fail to save.
    std::fs::OpenOptions::new().write(true).open(&path).and_then(|file|file.sync_all()).map_err(|_|"tunnel_profile_write")?;
    std::fs::rename(&path,&profile).map_err(|_|"tunnel_profile_write")?;
    #[cfg(unix)] std::fs::File::open(directory).and_then(|file|file.sync_all()).map_err(|_|"tunnel_profile_write")?;
    use sha2::{Digest,Sha256};
    Ok(super::mcp::ai_credentials::TunnelProfile{proxy_url:String::new(),tunnel_id:id.into(),executable:executable.to_path_buf(),profile,health_file:health,generation:0,digest:format!("{:x}",Sha256::digest(text.as_bytes()))})
}
pub fn validate_saved(config:&super::mcp::ai_credentials::TunnelProfile,descriptor:&std::path::Path)->Result<(),String>{
    use sha2::{Digest,Sha256};
    validate_input(&config.tunnel_id,&config.executable)?;
    let bytes=std::fs::read(&config.profile).map_err(|_|"tunnel_profile_unavailable")?;
    if format!("{:x}",Sha256::digest(&bytes))!=config.digest{return Err("tunnel_profile_changed".into());}
    let helper=std::env::current_exe().map_err(|_|"helper_not_installed")?.parent().unwrap().join(if cfg!(windows){"leaf-mcp-adapter.exe"}else{"leaf-mcp-adapter"});
    let text=String::from_utf8(bytes).map_err(|_|"tunnel_profile_changed")?;
    // Both paths are inside the hash-bound, fixed-command profile.
    if !helper.is_file()||!profile_contains_command(&text,&helper,descriptor){return Err("tunnel_profile_reconfigure_required".into());}Ok(())
}
// tunnel-client uses a shell-style lexer even on Windows. This is a command
// string inside YAML, not a CreateProcessW argument vector. Win32 accepts /.
fn tunnel_command(helper:&std::path::Path,descriptor:&std::path::Path,windows:bool)->String {
    let quote=|p:&std::path::Path| if windows {format!("\"{}\"",p.to_string_lossy().replace('\\',"/"))}else{format!("'{}'",p.to_string_lossy().replace('\'',"'\\''"))};
    format!("{} --descriptor {}",quote(helper),quote(descriptor))
}
fn profile_contains_command(text:&str,helper:&std::path::Path,descriptor:&std::path::Path)->bool {
    let command=tunnel_command(helper,descriptor,cfg!(windows));
    text.contains(&format!("command: {}",serde_json::to_string(&command).unwrap()))
}
fn cli_stage(stage:&str,error:String)->String {
    match (stage,error.as_str()) {
        ("init","tunnel_cli_rejected")=>"tunnel_cli_init_rejected".into(),
        ("init","tunnel_cli_timeout")=>"tunnel_cli_init_timeout".into(),
        ("doctor","tunnel_cli_rejected")=>"tunnel_cli_doctor_rejected".into(),
        ("doctor","tunnel_cli_timeout")=>"tunnel_cli_doctor_timeout".into(),
        _=>error,
    }
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
            if let Some(handle)=stdout {if windows_sys::Win32::Foundation::SetHandleInformation(handle,windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT,windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT)==0{return Err("tunnel_cli_failed".into());}startup.dwFlags=STARTF_USESTDHANDLES;startup.hStdOutput=handle;
                #[cfg(test)] if std::env::var_os("LEAF_PROXY_TEST_LOG").is_some(){startup.hStdError=handle;}
            }
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
    fn component_health_distinguishes_local_cloud_failures_and_recovery(){
        use serde_json::json;
        let mut status=TunnelRuntimeStatus{process:true,local_ready:true,..Default::default()};
        let mut value=json!({"schema_version":1,"runtime":{"instance_id":"0123456789abcdef"},"components":{"control-plane":{"status":"unknown","state":"polling","details":{"consecutive_failures":0}}}});
        status.observe_health(&value);assert!(!status.cloud_connected,"a pending first poll is not a successful connection");
        value["components"]["control-plane"]=json!({"status":"degraded","state":"polling","details":{"consecutive_failures":3,"failure_category":"network_error","last_success":"2026-01-01T00:00:00Z"}});
        status.observe_health(&value);assert!(status.local_ready);assert!(!status.cloud_connected);assert_eq!(status.last_error.as_deref(),Some("tunnel_network_proxy"));
        value["components"]["control-plane"]["details"]["http_status"]=json!(401);status.observe_health(&value);assert_eq!(status.last_error.as_deref(),Some("tunnel_cloud_auth"));
        value["components"]["control-plane"]=json!({"status":"ok","state":"polling","details":{"consecutive_failures":0,"last_success":"2026-01-01T00:00:00Z","deadline_seconds":60,"current_poll_age_seconds":4}});
        status.observe_health(&value);assert!(status.cloud_connected);assert!(status.last_error.is_none());assert!(!status.host_verified);
        value["components"]["control-plane"]["details"]["current_poll_age_seconds"]=json!(90);status.observe_health(&value);assert!(!status.cloud_connected);assert_eq!(status.last_error.as_deref(),Some("tunnel_network_proxy"));
        value["components"]["control-plane"]["details"]["current_poll_age_seconds"]=json!(0);
        value["components"]["response-delivery"]=json!({"status":"degraded"});status.observe_health(&value);assert!(!status.cloud_connected);assert_eq!(status.last_error.as_deref(),Some("tunnel_cloud_delivery_failed"));
        value["components"]["response-delivery"]=json!({"status":"ok"});status.observe_health(&value);assert!(status.cloud_connected);assert!(status.last_error.is_none());
    }
    // This child process gives each environment-mode test an isolated proxy
    // environment without racing other Rust tests or editing OS settings.
    #[test]
    fn official_tunnel_client_proxy_child(){
        let Some(mode)=std::env::var("LEAF_PROXY_TEST_CHILD").ok() else{return;};
        let executable=PathBuf::from(std::env::var_os("LEAF_TEST_TUNNEL_CLIENT").unwrap());
        let directory=tempfile::tempdir().unwrap();
        let helper=directory.path().join(if cfg!(windows){"leaf-mcp-adapter.exe"}else{"leaf-mcp-adapter"});std::fs::copy(std::env::current_exe().unwrap(),&helper).unwrap();
        let config=prepare_profile_with_helper(&format!("tunnel_{}","0".repeat(32)),&executable,&directory.path().join("profiles"),&directory.path().join("descriptor.json"),"synthetic-not-a-key",&helper).unwrap();
        // The network probe needs a passive live stdio child, not another
        // invocation of this Rust test harness with --descriptor arguments.
        // The harness supplies its existing Node executable on Windows. Hold
        // stdin without shell/PATHEXT or interactive console-filter behavior.
        let passive=if cfg!(windows){format!("\"{}\" -e \"process.stdin.resume()\"",std::env::var("LEAF_TEST_NODE_PATH").expect("Windows vendor harness must supply its Node executable").replace('\\',"/"))}else{"/bin/cat".into()};
        let text=std::fs::read_to_string(&config.profile).unwrap();
        let text=text.lines().map(|line|if line.trim_start().starts_with("command: "){format!("      command: {}",serde_json::to_string(&passive).unwrap())}else{line.into()}).collect::<Vec<_>>().join("\n");
        std::fs::write(&config.profile,text+"\n").unwrap();
        let log=directory.path().join("synthetic-connector.log");
        #[cfg(windows)] std::env::set_var("LEAF_PROXY_TEST_LOG",&log);
        let spec=TunnelLaunchSpec{executable,profile:config.profile,generation:1,health_file:Some(config.health_file),proxy_url:if mode=="explicit"{std::env::var("LEAF_PROXY_TEST_URL").unwrap()}else{String::new()},#[cfg(feature="native-smoke")]synthetic:false};
        let mut manager=TunnelManager::default();manager.configured(true,true);manager.start(&spec,"synthetic-not-a-key").unwrap();
        let start=Instant::now();
        loop {
            let status=manager.status();
            if status.last_error.as_deref()==Some("tunnel_network_proxy") {
                assert!(status.process&&status.local_ready&&status.saved_config);assert!(!status.cloud_connected);assert!(status.consecutive_failures>0);assert_eq!(status.proxy_source,mode);break;
            }
            assert!(status.process,"official client must remain running: {}",std::fs::read_to_string(&log).unwrap_or_default());
            assert!(start.elapsed()<Duration::from_secs(25),"official polling health did not report the controlled proxy failure: {}",serde_json::to_string(&status).unwrap());
            std::thread::sleep(Duration::from_millis(100));
        }
        manager.stop().unwrap();
    }
    #[test]
    fn official_tunnel_client_routes_through_explicit_and_environment_proxy(){
        if std::env::var_os("LEAF_TEST_TUNNEL_CLIENT").is_none(){return;}
        use std::{io::{Read,Write},sync::{Arc,atomic::{AtomicBool,Ordering}}};
        for mode in ["explicit","environment"] {
            let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();
            let url=format!("http://127.0.0.1:{}",listener.local_addr().unwrap().port());
            let done=Arc::new(AtomicBool::new(false));let saw=Arc::new(AtomicBool::new(false));let stop=done.clone();let observed=saw.clone();
            let server=std::thread::spawn(move||{while !stop.load(Ordering::Relaxed){
                if let Ok((mut socket,_))=listener.accept(){
                    socket.set_read_timeout(Some(Duration::from_millis(500))).unwrap();let mut bytes=[0;8192];let size=socket.read(&mut bytes).unwrap_or(0);
                    let request=String::from_utf8_lossy(&bytes[..size]);
                    if request.starts_with("CONNECT api.openai.com:443 ")&&!request.contains("synthetic-not-a-key"){observed.store(true,Ordering::Relaxed);}
                    let _=socket.write_all(b"HTTP/1.1 502 Controlled proxy failure\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                }else{std::thread::sleep(Duration::from_millis(10));}
            }});
            let mut child=Command::new(std::env::current_exe().unwrap());
            child.args(["chatgpt_tunnel::tests::official_tunnel_client_proxy_child","--exact","--nocapture"]);
            for key in ["CONTROL_PLANE_HTTP_PROXY","TUNNEL_CLIENT_HTTP_PROXY","HTTPS_PROXY","https_proxy","HTTP_PROXY","http_proxy","NO_PROXY","no_proxy"]{child.env_remove(key);}
            child.env("LEAF_PROXY_TEST_CHILD",mode).env("LEAF_PROXY_TEST_URL",&url);
            if mode=="environment"{child.env("HTTPS_PROXY",&url);}
            let output=child.output().unwrap();done.store(true,Ordering::Relaxed);server.join().unwrap();
            assert!(output.status.success(),"{} {}",String::from_utf8_lossy(&output.stdout),String::from_utf8_lossy(&output.stderr));
            assert!(saw.load(Ordering::Relaxed),"vendor must actually CONNECT through the chosen proxy");
        }
    }
    #[test]
    fn tunnel_id_and_windows_argument_boundaries(){
        assert_eq!(windows_quote("C:\\Public Example\\tunnel-client.exe"),"\"C:\\Public Example\\tunnel-client.exe\"");
        assert!(validate_input("",std::path::Path::new("/synthetic/tunnel-client")).is_err());
        assert!(validate_input(&format!("tunnel_{}","A".repeat(32)),std::path::Path::new("/synthetic/tunnel-client")).is_err());
        assert!(validate_input(&format!("tunnel_{}","a".repeat(32)),std::path::Path::new("relative/tunnel-client")).is_err());
    }
    #[test]
    fn vendor_command_is_distinct_from_createprocess_arguments() {
        let command=tunnel_command(std::path::Path::new("C:\\Public Example\\中文's\\leaf-mcp-adapter.exe"),std::path::Path::new("C:\\Public Example\\中文's\\descriptor.json"),true);
        assert_eq!(command,"\"C:/Public Example/中文's/leaf-mcp-adapter.exe\" --descriptor \"C:/Public Example/中文's/descriptor.json\"");
        assert_eq!(cli_stage("doctor","tunnel_cli_rejected".into()),"tunnel_cli_doctor_rejected");
        assert_eq!(cli_stage("init","tunnel_cli_timeout".into()),"tunnel_cli_init_timeout");
    }
    #[test]
    fn official_tunnel_client_prepares_profile_with_spaces_and_unicode() {
        let Some(executable)=std::env::var_os("LEAF_TEST_TUNNEL_CLIENT") else {return;};
        let root=tempfile::tempdir().unwrap();
        let directory=root.path().join("Public Example 中文's");std::fs::create_dir(&directory).unwrap();
        let helper=directory.join(if cfg!(windows){"leaf-mcp-adapter.exe"}else{"leaf-mcp-adapter"});
        std::fs::copy(std::env::current_exe().unwrap(),&helper).unwrap();
        let descriptor=directory.join("descriptor 中文.json");std::fs::write(&descriptor,"{}").unwrap();
        let profile=prepare_profile_with_helper(&format!("tunnel_{}","0".repeat(32)),&PathBuf::from(executable),&directory.join("profiles"),&descriptor,"synthetic-placeholder-not-an-api-key",&helper).unwrap();
        let text=std::fs::read_to_string(&profile.profile).unwrap();
        assert!(profile_contains_command(&text,&helper,&descriptor));
        assert!(!text.contains("synthetic-placeholder-not-an-api-key"));
        if cfg!(windows){assert!(text.contains("C:/")||text.contains(":/"));}
    }
    #[cfg(unix)]
    fn fixture(directory:&std::path::Path,body:&str)->PathBuf{
        use std::os::unix::fs::PermissionsExt;
        let path=directory.join("synthetic-connector");std::fs::write(&path,format!("#!/bin/sh\n{body}\n")).unwrap();std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o700)).unwrap();path
    }
    #[cfg(unix)]
    fn spec(path:PathBuf)->TunnelLaunchSpec {TunnelLaunchSpec{executable:path,proxy_url:String::new(),profile:"synthetic-profile".into(),generation:1,health_file:None,#[cfg(feature="native-smoke")]synthetic:false}}
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
