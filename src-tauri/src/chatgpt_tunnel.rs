//! One GUI-owned connector tree. Readiness is local evidence, never host proof.
use std::{path::PathBuf,process::{Child,Command,Stdio},time::{Duration,Instant}};
use serde::Serialize;

pub struct TunnelLaunchSpec {
    pub executable:PathBuf,
    pub profile:PathBuf,
    pub generation:u64,
    #[cfg(feature="native-smoke")] pub synthetic:bool,
}
#[derive(Clone,Default,Serialize)]
pub struct TunnelRuntimeStatus {
    pub generation:u64,pub epoch:u64,pub saved_config:bool,pub runtime_present:bool,
    pub process:bool,pub local_ready:bool,pub host_verified:bool,pub last_error:Option<String>,
}
#[derive(Default)]
pub struct TunnelManager { child:Option<Child>,status:TunnelRuntimeStatus }
impl TunnelManager {
    pub fn status(&mut self)->TunnelRuntimeStatus {
        if self.child.as_mut().is_some_and(|c|c.try_wait().ok().flatten().is_some()) {
            let _=self.stop();self.status.last_error=Some("tunnel_exited".into());
        }self.status.clone()
    }
    pub fn start(&mut self,spec:&TunnelLaunchSpec,key:&str)->Result<TunnelRuntimeStatus,String> {
        if self.status().process&&self.status.generation==spec.generation{return Ok(self.status.clone());}
        self.stop()?;
        if key.is_empty(){return Err("runtime_key_required".into());}
        let mut command=Command::new(&spec.executable);
        command.args(["run","--profile"]).arg(&spec.profile).env_clear();
        for name in ["HOME","PATH","SYSTEMROOT","WINDIR","TEMP","TMP","LANG"] {if let Some(v)=std::env::var_os(name){command.env(name,v);}}
        command.env("CONTROL_PLANE_API_KEY",key).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(feature="native-smoke")]
        if spec.synthetic {command.env("LEAF_MCP_TEST_PROCESS_ROLE","chatgpt-tunnel-fixture").stderr(Stdio::inherit());}
        #[cfg(unix)] {use std::os::unix::process::CommandExt;command.process_group(0);}
        self.child=Some(command.spawn().map_err(|_|"tunnel_spawn_failed")?);
        self.status.generation=spec.generation;self.status.epoch+=1;self.status.process=true;
        self.status.runtime_present=true;self.status.local_ready=false;self.status.host_verified=false;self.status.last_error=None;
        Ok(self.status.clone())
    }
    pub fn local_ready(&mut self,generation:u64,epoch:u64)->bool {
        if self.status().process&&self.status.generation==generation&&self.status.epoch==epoch {self.status.local_ready=true;true}else{false}
    }
    pub fn stop(&mut self)->Result<(),String> {
        self.status.epoch+=1;self.status.process=false;self.status.local_ready=false;self.status.host_verified=false;
        if let Some(mut child)=self.child.take(){
            #[cfg(unix)] {
                let group=format!("-{}",child.id());
                let _=Command::new("/bin/kill").args(["-KILL","--",&group]).status();
                let _=child.wait();
                let start=Instant::now();
                while Command::new("/bin/kill").args(["-0","--",&group]).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s|s.success()) {
                    if start.elapsed()>Duration::from_secs(3){return Err("tunnel_stop_timeout".into());}
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            #[cfg(not(unix))] {let _=child.kill();let _=child.wait();}
        }Ok(())
    }
}
impl Drop for TunnelManager {fn drop(&mut self){let _=self.stop();}}

#[cfg(feature="native-smoke")]
pub fn synthetic_fixture_main()->i32 {
    // This executable branch precedes Tauri and is absent from production builds.
    let result=(||->Result<(),String>{
        let args=std::env::args().collect::<Vec<_>>();
        let profile=args.iter().position(|v|v=="--profile").and_then(|i|args.get(i+1)).ok_or("fixture_profile")?;
        let profile:serde_json::Value=serde_json::from_slice(&std::fs::read(profile).map_err(|_|"fixture_profile")?).map_err(|_|"fixture_profile")?;
        if std::env::var("CONTROL_PLANE_API_KEY").ok().as_deref()!=Some("synthetic-tunnel-key-sentinel"){return Err("fixture_environment".into());}
        let runtime=tokio::runtime::Runtime::new().map_err(|_|"fixture_runtime")?;
        runtime.block_on(async {
            use rmcp::ServiceExt;
            let mut command=tokio::process::Command::new(std::env::current_exe().map_err(|_|"fixture_executable")?.parent().unwrap().join("leaf-mcp-adapter"));
            command.args(["--descriptor",profile["descriptor"].as_str().ok_or("fixture_descriptor")?]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).kill_on_drop(true);
            let mut child=command.spawn().map_err(|_|"fixture_adapter")?;
            let client=().serve((child.stdout.take().unwrap(),child.stdin.take().unwrap())).await.map_err(|_|"fixture_stdio")?;
            let response=client.call_tool(serde_json::from_value(serde_json::json!({"name":"read_document","arguments":profile["binding"]})).unwrap()).await.map_err(|_|"fixture_read")?;
            let result=serde_json::to_value(response).map_err(|_|"fixture_result")?;
            if result["isError"]==true||result["structuredContent"]["content"]!="Synthetic live Tunnel buffer" {return Err("fixture_live_buffer".into());}
            std::fs::write(profile["evidence"].as_str().ok_or("fixture_evidence")?,b"{\"adapter_stdio\":true,\"live_buffer\":true,\"host_verified\":false}").map_err(|_|"fixture_evidence")?;
            // Keep the real adapter connected so its authenticated heartbeat remains independent.
            std::future::pending::<()>().await;Ok(())
        })
    })();
    if let Err(category)=result {eprintln!("Leaf synthetic tunnel: {category}");1}else{0}
}
