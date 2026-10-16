#![cfg_attr(target_os="windows", windows_subsystem="windows")]
//! MCP process with inherited protocol pipes. Windows must not allocate a console.
//! The adapter owns no documents: every operation goes to the live Leaf broker.
#[path = "../ai_credentials.rs"]
mod ai_credentials;
#[path = "../atomic_file.rs"]
mod atomic_file;
use std::{sync::Arc, path::PathBuf};
use rmcp::{ServiceExt,ServerHandler,ErrorData,model::*,service::{RoleClient,RoleServer,Peer,RequestContext},transport::{stdio,StreamableHttpClientTransport,streamable_http_client::StreamableHttpClientTransportConfig}};

#[derive(Clone)]
struct Adapter {upstream:Arc<Peer<RoleClient>>,info:ServerConfig}
impl ServerHandler for Adapter {
    fn get_info(&self)->ServerConfig {self.info.clone()}
    async fn list_tools(&self,p:Option<PaginatedRequestParams>,_:RequestContext<RoleServer>)->Result<ListToolsResult,ErrorData> {
        self.upstream.list_tools(p).await.map(|mut result| {
            // The broker connection uses the legacy handshake, which omits this
            // discriminator. Restore it at the bridge: rmcp strips it again for
            // legacy hosts, while modern hosts require it on every result.
            result.result_type=Some(ResultType::COMPLETE);result
        }).map_err(|_|ErrorData::internal_error("broker_unavailable",None))
    }
    async fn call_tool(&self,p:CallToolRequestParams,_:RequestContext<RoleServer>)->Result<CallToolResponse,ErrorData> {
        self.upstream.call_tool(p).await.map(|mut result| {
            result.result_type=Some(ResultType::COMPLETE);result.into()
        }).map_err(|_|ErrorData::internal_error("broker_unavailable",None))
    }
    async fn list_resources(&self,p:Option<PaginatedRequestParams>,_:RequestContext<RoleServer>)->Result<ListResourcesResult,ErrorData> {
        self.upstream.list_resources(p).await.map(|mut result| {
            result.result_type=Some(ResultType::COMPLETE);result
        }).map_err(|_|ErrorData::internal_error("broker_unavailable",None))
    }
    async fn read_resource(&self,p:ReadResourceRequestParams,_:RequestContext<RoleServer>)->Result<ReadResourceResponse,ErrorData> {
        self.upstream.read_resource(p).await.map(|mut result| {
            result.result_type=Some(ResultType::COMPLETE);result.into()
        }).map_err(|_|ErrorData::internal_error("broker_unavailable",None))
    }
}
fn descriptor_path()->Result<PathBuf,String> {
    let args:Vec<_>=std::env::args_os().skip(1).collect();
    if args.len()==2&&args[0]=="--descriptor" {return Ok(PathBuf::from(&args[1]));}
    if args.is_empty() {return std::env::var_os("LEAF_MCP_DESCRIPTOR").map(PathBuf::from).ok_or("descriptor_required".into());}
    Err("invalid_arguments".into())
}
async fn run()->Result<(),String> {
    let path=descriptor_path()?;
    let descriptor:ai_credentials::BrokerDescriptor=serde_json::from_slice(&std::fs::read(path).map_err(|_|"descriptor_unavailable")?).map_err(|_|"invalid_broker_descriptor")?;
    descriptor.validate()?;
    trace("descriptor_valid");
    let token=tokio::time::timeout(std::time::Duration::from_secs(60),tokio::task::spawn_blocking({let d=descriptor.clone();move||d.load_token()})).await.map_err(|_|"credential_access_timeout")?.map_err(|_|"credential_unavailable")??;
    trace("keyring_loaded");
    let config=StreamableHttpClientTransportConfig::with_uri(descriptor.uri).auth_header(token).reinit_on_expired_session(false);
    let upstream=().serve(StreamableHttpClientTransport::from_config(config)).await.map_err(|_|"broker_unavailable")?;
    trace("upstream_initialized");
    let peer_info=upstream.peer_info().ok_or("broker_unavailable")?;
    let mut info=ServerConfig::default();info.capabilities=peer_info.capabilities.clone();info.protocol_version=peer_info.protocol_version.clone();info.instructions=peer_info.instructions.clone();
    let adapter=Adapter{upstream:Arc::new(upstream.peer().clone()),info};
    let service=adapter.serve(stdio()).await.map_err(|_|"stdio_unavailable")?;
    trace("stdio_initialized");
    // Independent of model calls and their request deadlines. EOF terminates
    // this loop; a killed helper stops renewing and the broker lease expires.
    let peer=upstream.peer().clone();
    let heartbeat=tokio::spawn(async move{
        #[cfg(not(feature="native-smoke"))]
        let period=std::time::Duration::from_secs(5);
        #[cfg(feature="native-smoke")]
        let period=if std::env::var_os("LEAF_AI_LIFECYCLE_NATIVE").is_some(){std::time::Duration::from_millis(100)}else{std::time::Duration::from_secs(5)};
        let mut interval=tokio::time::interval(period);
        loop {interval.tick().await;let _=tokio::time::timeout(std::time::Duration::from_secs(3),peer.send_request(ClientRequest::PingRequest(Default::default()))).await;}
    });
    let _ended=service.waiting().await;
    heartbeat.abort();
    let _=tokio::time::timeout(std::time::Duration::from_secs(5),upstream.peer().call_tool(CallToolRequestParams::new("adapter_disconnect"))).await;
    let _=upstream.cancel().await;Ok(())
}
fn trace(stage:&str) {
    #[cfg(feature="native-smoke")]
    if let Some(path)=std::env::var_os("LEAF_MCP_TEST_TRACE") {let _=std::fs::write(path,stage);}
    #[cfg(not(feature="native-smoke"))]
    let _=stage;
}
fn main() {
    // First, while still single-threaded and before runtime/logging startup.
    std::env::remove_var("CONTROL_PLANE_API_KEY");
    if std::env::args().nth(1).as_deref()==Some("--leaf-build-identity") {println!("{}",ai_credentials::native_build_identity());return;}
    #[cfg(feature="native-smoke")]
    if let Some(path)=std::env::var_os("LEAF_MCP_TEST_ADAPTER_ENV_TRACE"){
        let mut proof=serde_json::json!({"has_runtime_key":std::env::var_os("CONTROL_PLANE_API_KEY").is_some()});
        #[cfg(windows)] {
            #[link(name="kernel32")] extern "system" {fn GetConsoleWindow()->*mut std::ffi::c_void;}
            proof["has_console"]=serde_json::json!(unsafe{!GetConsoleWindow().is_null()});
        }
        let _=std::fs::write(path,serde_json::to_vec(&proof).unwrap());
    }
    let runtime=tokio::runtime::Runtime::new().expect("MCP runtime unavailable");
    if let Err(category)=runtime.block_on(run()) {eprintln!("Leaf MCP: {category}");std::process::exit(1);}
}

#[cfg(test)]
mod protocol_tests {
    use super::*;
    use serde_json::{json,Value};
    use tokio::io::{AsyncBufReadExt,AsyncWriteExt,BufReader};

    struct SyntheticBroker;
    impl ServerHandler for SyntheticBroker {
        fn get_info(&self)->ServerConfig {
            ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_resources().build())
        }
        async fn list_tools(&self,_:Option<PaginatedRequestParams>,_:RequestContext<RoleServer>)->Result<ListToolsResult,ErrorData> {
            Ok(serde_json::from_value(json!({"tools":[{"name":"synthetic_read","inputSchema":{"type":"object"}}],"_meta":{"synthetic":"tools"}})).unwrap())
        }
        async fn call_tool(&self,p:CallToolRequestParams,_:RequestContext<RoleServer>)->Result<CallToolResponse,ErrorData> {
            if p.name=="protocol-error" {return Err(ErrorData::invalid_params("synthetic rejection",None));}
            let result:CallToolResult=serde_json::from_value(json!({"content":[{"type":"text","text":"synthetic draft"}],"structuredContent":{"revision":7},"isError":p.name=="tool-error","_meta":{"synthetic":"call"}})).unwrap();
            Ok(result.into())
        }
        async fn list_resources(&self,_:Option<PaginatedRequestParams>,_:RequestContext<RoleServer>)->Result<ListResourcesResult,ErrorData> {
            Ok(serde_json::from_value(json!({"resources":[{"uri":"synthetic://reader","name":"Synthetic Reader"}],"_meta":{"synthetic":"resources"}})).unwrap())
        }
        async fn read_resource(&self,_:ReadResourceRequestParams,_:RequestContext<RoleServer>)->Result<ReadResourceResponse,ErrorData> {
            let result:ReadResourceResult=serde_json::from_value(json!({"contents":[{"uri":"synthetic://reader","text":"synthetic resource"}],"_meta":{"synthetic":"read"}})).unwrap();
            Ok(result.into())
        }
    }

    async fn exercise_bridge(modern:bool) {
        // Use the same legacy upstream handshake as production. The two wire
        // connections must negotiate independently; this is not a serializer test.
        let (broker_io,upstream_io)=tokio::io::duplex(65536);
        let broker_task=tokio::spawn(async {SyntheticBroker.serve(broker_io).await.unwrap().waiting().await});
        let upstream=().serve(upstream_io).await.unwrap();
        assert!(upstream.peer().list_tools(None).await.unwrap().result_type.is_none());
        let adapter=Adapter{upstream:Arc::new(upstream.peer().clone()),info:SyntheticBroker.get_info()};
        let (adapter_io,host_io)=tokio::io::duplex(65536);
        let adapter_task=tokio::spawn(async {adapter.serve(adapter_io).await.unwrap().waiting().await});
        let (reader,mut writer)=tokio::io::split(host_io);
        let mut lines=BufReader::new(reader).lines();
        let meta=json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"Synthetic host","version":"1"},"io.modelcontextprotocol/clientCapabilities":{}});
        let mut requests=vec![(if modern {"server/discover"}else{"initialize"},if modern {json!({})}else{json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"Synthetic host","version":"1"}})})];
        requests.extend([
            ("tools/list",json!({})),
            ("tools/call",json!({"name":"synthetic_read"})),
            ("resources/list",json!({})),
            ("resources/read",json!({"uri":"synthetic://reader"})),
            ("tools/call",json!({"name":"tool-error"})),
            ("tools/call",json!({"name":"protocol-error"})),
        ]);
        for (index,(method,mut params)) in requests.into_iter().enumerate() {
            if modern {params["_meta"]=meta.clone();}
            let message=json!({"jsonrpc":"2.0","id":index,"method":method,"params":params});
            writer.write_all(format!("{message}\n").as_bytes()).await.unwrap();
            let reply:Value=serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(reply["id"],index);
            if index==6 {
                assert_eq!(reply["error"]["code"],-32603);
                assert!(reply.get("result").is_none());
                continue;
            }
            assert!(reply.get("error").is_none(),"{reply}");
            let result=&reply["result"];
            if modern {assert_eq!(result["resultType"],"complete","{method}: {result}");}
            else {assert!(result.get("resultType").is_none(),"legacy {method}: {result}");}
            if index==0 {
                if !modern {writer.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n").await.unwrap();}
                continue;
            }
            if modern&&["tools/list","resources/list","resources/read"].contains(&method) {
                assert_eq!(result["ttlMs"],0);assert_eq!(result["cacheScope"],"private");
            }
            match index {
                1=>{assert_eq!(result["tools"][0]["name"],"synthetic_read");assert_eq!(result["_meta"]["synthetic"],"tools");},
                2|5=>{assert_eq!(result["structuredContent"]["revision"],7);assert_eq!(result["isError"],index==5);assert_eq!(result["_meta"]["synthetic"],"call");},
                3=>{assert_eq!(result["resources"][0]["uri"],"synthetic://reader");assert_eq!(result["_meta"]["synthetic"],"resources");},
                4=>{assert_eq!(result["contents"][0]["text"],"synthetic resource");assert_eq!(result["_meta"]["synthetic"],"read");},
                _=>unreachable!(),
            }
        }
        drop(writer);drop(lines);
        adapter_task.await.unwrap().unwrap();
        upstream.cancel().await.unwrap();
        broker_task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn modern_host_receives_complete_legacy_broker_responses() {
        tokio::time::timeout(std::time::Duration::from_secs(10),exercise_bridge(true)).await.unwrap();
    }
    #[tokio::test]
    async fn legacy_host_keeps_legacy_broker_response_shape() {
        tokio::time::timeout(std::time::Duration::from_secs(10),exercise_bridge(false)).await.unwrap();
    }
}
