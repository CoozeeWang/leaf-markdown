//! Console MCP process on every platform, including Windows. No GUI subsystem.
//! The adapter owns no documents: every operation goes to the live Leaf broker.
#[path = "../ai_credentials.rs"]
mod ai_credentials;
use std::{sync::Arc, path::PathBuf};
use rmcp::{ServiceExt,ServerHandler,ErrorData,model::*,service::{RoleClient,RoleServer,Peer,RequestContext},transport::{stdio,StreamableHttpClientTransport,streamable_http_client::StreamableHttpClientTransportConfig}};

#[derive(Clone)]
struct Adapter {upstream:Arc<Peer<RoleClient>>,info:ServerConfig}
impl ServerHandler for Adapter {
    fn get_info(&self)->ServerConfig {self.info.clone()}
    async fn list_tools(&self,p:Option<PaginatedRequestParams>,_:RequestContext<RoleServer>)->Result<ListToolsResult,ErrorData> {
        self.upstream.list_tools(p).await.map_err(|_|ErrorData::internal_error("broker_unavailable",None))
    }
    async fn call_tool(&self,p:CallToolRequestParams,_:RequestContext<RoleServer>)->Result<CallToolResponse,ErrorData> {
        self.upstream.call_tool(p).await.map(Into::into).map_err(|_|ErrorData::internal_error("broker_unavailable",None))
    }
    async fn list_resources(&self,p:Option<PaginatedRequestParams>,_:RequestContext<RoleServer>)->Result<ListResourcesResult,ErrorData> {
        self.upstream.list_resources(p).await.map_err(|_|ErrorData::internal_error("broker_unavailable",None))
    }
    async fn read_resource(&self,p:ReadResourceRequestParams,_:RequestContext<RoleServer>)->Result<ReadResourceResponse,ErrorData> {
        self.upstream.read_resource(p).await.map(Into::into).map_err(|_|ErrorData::internal_error("broker_unavailable",None))
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
#[tokio::main]
async fn main() {
    if let Err(category)=run().await {eprintln!("Leaf MCP: {category}");std::process::exit(1);}
}
