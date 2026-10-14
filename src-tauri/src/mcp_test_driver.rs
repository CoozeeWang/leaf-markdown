//! Test driver exists only in explicitly isolated native-smoke builds.
use tauri::Manager;
use serde_json::{json, Value};

pub fn enabled(app: &tauri::AppHandle) -> bool {
    app.config().identifier.starts_with("studio.leaf.editor.dev.mcptest")
        && std::env::var_os("LEAF_MCP_TEST_DIR").is_some()
}

pub fn configure(config: &mut tauri::utils::config::Config) {
    if config.identifier != "studio.leaf.editor.dev.mcptest" { return; }
    use sha2::{Digest,Sha256};
    let root=std::env::var("LEAF_MCP_TEST_DIR").expect("isolated test directory");
    let digest=Sha256::digest(root.as_bytes());
    config.identifier=format!("studio.leaf.editor.dev.mcptest.{:x}",digest);
    #[cfg(target_os="macos")]
    { config.app.windows[0].data_store_identifier=Some(digest[..16].try_into().unwrap()); }
}

#[tauri::command]
pub fn mcp_test_mode(app: tauri::AppHandle,window:tauri::WebviewWindow) -> Option<String> {
    (enabled(&app) && window.label().starts_with("document-")).then(|| std::env::var("LEAF_MCP_TEST_MODE").unwrap_or_default())
}

#[tauri::command]
pub fn mcp_test_report(app: tauri::AppHandle, report: Value) -> Result<(), String> {
    if !enabled(&app) { return Err("test driver disabled".into()); }
    let root=std::path::PathBuf::from(std::env::var("LEAF_MCP_TEST_DIR").map_err(|_|"test directory absent")?);
    std::fs::write(root.join("result.json"),serde_json::to_vec(&report).map_err(|_|"report encoding")?).map_err(|_|"report write".to_string())?;
    app.exit(if report["pass"] == true {0}else{1});
    Ok(())
}

pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    if !enabled(app) { return Ok(()); }
    super::create_document(app.clone(),None,None,None)
}

fn ensure(condition:bool,message:&str)->Result<(),String>{if condition {Ok(())}else{Err(message.into())}}

async fn tool(client:&rmcp::service::Peer<rmcp::service::RoleClient>,name:&str,args:Value)->Result<Value,String> {
    let params=serde_json::from_value(json!({"name":name,"arguments":args})).map_err(|_|"client parameters")?;
    let result=client.call_tool(params).await.map_err(|_|"MCP client call")?;
    let value=serde_json::to_value(result).map_err(|_|"client result")?;
    if value["isError"]==true {return Err(value["structuredContent"]["error"].as_str().unwrap_or("tool_error").into());}Ok(value["structuredContent"].clone())
}

#[tauri::command]
pub async fn mcp_test_run(app:tauri::AppHandle,window:tauri::WebviewWindow,mode:String)->Result<Value,String> {
    if !enabled(&app) {return Err("test disabled".into());}
    let result=run(&app,window.label(),&mode).await;
    Ok(match result{Ok(())=>json!({"pass":true,"layer":"actual-tauri"}),Err(error)=>json!({"pass":false,"failure":error})})
}

async fn run(app:&tauri::AppHandle,label:&str,mode:&str)->Result<(),String> {
    use rmcp::{ServiceExt,transport::{StreamableHttpClientTransport,streamable_http_client::StreamableHttpClientTransportConfig}};
    let broker=app.state::<super::mcp::LeafMcpBroker>().inner();
    let window=app.get_webview_window(label).ok_or("native document absent")?;
    ensure(window.is_visible().unwrap_or(false),"native document must be visible")?;
    ensure(app.state::<super::Documents>().0.lock().unwrap().get(label)==Some(&None),"actual unsaved document registry")?;
    let _=broker.bridge(app,label,"test",json!({"action":"reset","content":""})).await?;
    let original=broker.inner.registry.lock().unwrap().documents.values().find(|d|d.label==label).cloned().ok_or("renderer registration absent")?;
    ensure(original.client.is_none(),"default authorization must be closed")?;
    let token=super::mcp::digest(&json!(std::env::var("LEAF_MCP_TEST_DIR").unwrap()));
    broker.inner.credentials.lock().unwrap().insert("synthetic-client".into(),token.clone());
    *broker.inner.enabled.lock().unwrap()=true;
    let port=broker.serve_http(app.clone(),"synthetic-client".into(),token.clone()).await?;
    let config=StreamableHttpClientTransportConfig::with_uri(format!("http://127.0.0.1:{port}/mcp")).auth_header(token).reinit_on_expired_session(false);
    let client=().serve(StreamableHttpClientTransport::from_config(config)).await.map_err(|_|"standard MCP initialize")?;
    let mut binding=json!({"document_id":original.document_id,"session_id":original.session_id,"authorization_epoch":0});
    ensure(tool(&client,"read_document",binding.clone()).await.is_err(),"unauthorized read must fail")?;
    let d=broker.authorize(app,label,&original.session_id,"synthetic-client",json!({"from":0,"to":0})).await?;
    binding["authorization_epoch"]=json!(d.authorization_epoch);
    ensure(tool(&client,"list_documents",json!({})).await?["documents"].as_array().unwrap().len()==1,"authorized list")?;
    let read=tool(&client,"read_document",binding.clone()).await?;
    ensure(read["content"]=="","empty buffer read")?;
    let mut begin=binding.clone();begin["request_id"]=json!("begin-tracer");begin["revision"]=read["revision"].clone();
    let task=tool(&client,"begin_edit",begin.clone()).await?;
    ensure(tool(&client,"begin_edit",begin).await?==task,"idempotent begin")?;
    let mut batch=binding.clone();batch["task_id"]=task["task_id"].clone();batch["request_id"]=json!("batch-tracer");batch["revision"]=read["revision"].clone();batch["changes"]=json!([{"from":0,"to":0,"expected":"","insert":"Synthetic draft"}]);
    let result=tool(&client,"apply_edit_batch",batch.clone()).await?;
    ensure(result["applied_revision"].as_u64()==Some(read["revision"].as_u64().unwrap()+1),"receipt revision")?;
    ensure(tool(&client,"apply_edit_batch",batch.clone()).await?==result,"duplicate batch result")?;
    let status=tool(&client,"task_status",binding.clone()).await?;
    ensure(status["snapshot"]["content"]=="Synthetic draft","actual live CodeMirror buffer")?;
    batch["request_id"]=json!("outside");batch["revision"]=result["applied_revision"].clone();batch["changes"]=json!([{"from":16,"to":16,"expected":"","insert":"bad"}]);
    ensure(tool(&client,"apply_edit_batch",batch).await.is_err(),"out of scope must fail")?;
    let mut end=binding.clone();end["task_id"]=task["task_id"].clone();tool(&client,"finish_edit",end).await?;
    let undo=broker.bridge(app,label,"test",json!({"action":"undo"})).await?;ensure(undo["content"]=="","single tracer undo")?;
    let redo=broker.bridge(app,label,"test",json!({"action":"redo"})).await?;ensure(redo["content"]=="Synthetic draft","single tracer redo")?;
    broker.unregister(label);
    ensure(tool(&client,"read_document",binding).await.is_err(),"closed session must fail")?;
    if mode!="tracer" {return Err("task proof mode not implemented".into());}
    let _=client.cancel().await;Ok(())
}
