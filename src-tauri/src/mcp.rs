//! Leaf owns authorization and task serialization. Renderers own document text.
use std::{collections::HashMap,sync::{Arc,Mutex,atomic::{AtomicU64,Ordering}},time::Duration};
use rmcp::{ServerHandler,ErrorData,model::*,service::{RequestContext,RoleServer},transport::streamable_http_server::{StreamableHttpService,StreamableHttpServerConfig,session::local::LocalSessionManager}};
use serde::{Serialize,Deserialize};
use serde_json::{Value,json};
use sha2::{Digest,Sha256};
use tauri::{Manager,Emitter};
use tokio::sync::{Mutex as AsyncMutex,oneshot};

static IDS:AtomicU64=AtomicU64::new(1);
fn id(prefix:&str)->String { format!("{prefix}-{}-{}",std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),IDS.fetch_add(1,Ordering::Relaxed)) }
pub fn digest(value:&Value)->String { format!("{:x}",Sha256::digest(serde_json::to_vec(value).unwrap())) }
fn required<'a>(v:&'a Value,key:&str)->Result<&'a str,String> { v[key].as_str().filter(|v|!v.is_empty()).ok_or_else(||format!("missing_{key}")) }

#[derive(Clone,Serialize,Deserialize)]
pub struct OpenedDocument {pub document_id:String,pub session_id:String,pub label:String,pub authorization_epoch:u64,pub client:Option<String>,pub scope:Option<Value>,pub task:Option<Value>}
#[derive(Default)]
pub struct OpenedDocumentRegistry {pub documents:HashMap<String,OpenedDocument>}
type Pending=(String,oneshot::Sender<Value>);
pub struct McpEditorBridge {pending:Mutex<HashMap<String,Pending>>}
#[derive(Clone)]
pub struct LeafMcpBroker {pub inner:Arc<BrokerState>}
pub struct BrokerState {pub registry:Mutex<OpenedDocumentRegistry>,pub queue:AsyncMutex<()>,bridge:McpEditorBridge,pub enabled:Mutex<bool>,pub credentials:Mutex<HashMap<String,String>>,pub results:Mutex<HashMap<String,(String,Value)>>}
impl Default for LeafMcpBroker {
    fn default()->Self {Self{inner:Arc::new(BrokerState{registry:Mutex::new(OpenedDocumentRegistry::default()),queue:AsyncMutex::new(()),bridge:McpEditorBridge{pending:Mutex::new(HashMap::new())},enabled:Mutex::new(false),credentials:Mutex::new(HashMap::new()),results:Mutex::new(HashMap::new())})}}
}
impl LeafMcpBroker {
    pub fn register(&self,label:&str)->OpenedDocument {
        let mut registry=self.inner.registry.lock().unwrap();
        registry.documents.retain(|_,d|d.label!=label);
        let d=OpenedDocument{document_id:id("document"),session_id:id("session"),label:label.into(),authorization_epoch:0,client:None,scope:None,task:None};
        registry.documents.insert(d.session_id.clone(),d.clone());d
    }
    pub fn unregister(&self,label:&str) {self.inner.registry.lock().unwrap().documents.retain(|_,d|d.label!=label);}
    pub async fn bridge(&self,app:&tauri::AppHandle,label:&str,operation:&str,args:Value)->Result<Value,String> {
        let call=id("bridge");let (tx,rx)=oneshot::channel();
        self.inner.bridge.pending.lock().unwrap().insert(call.clone(),(label.into(),tx));
        let emit=app.emit_to(label,"leaf-mcp-editor",json!({"call_id":call,"operation":operation,"args":args}));
        if emit.is_err() {self.inner.bridge.pending.lock().unwrap().remove(&call);return Err("renderer_unavailable".into());}
        let result=tokio::time::timeout(Duration::from_secs(3),rx).await;
        self.inner.bridge.pending.lock().unwrap().remove(&call);
        let value=result.map_err(|_|"renderer_ack_timeout")?.map_err(|_|"renderer_unavailable")?;
        if let Some(error)=value["error"].as_str() {return Err(error.into());}Ok(value["result"].clone())
    }
    pub async fn authorize(&self,app:&tauri::AppHandle,label:&str,session:&str,client:&str,scope:Value)->Result<OpenedDocument,String> {
        let _serial=self.inner.queue.lock().await;
        if !self.inner.credentials.lock().unwrap().contains_key(client) {return Err("client_unconfigured".into());}
        let mut d=self.inner.registry.lock().unwrap().documents.get(session).cloned().ok_or("stale_session")?;
        if d.label!=label || d.task.is_some() {return Err("document_locked".into());}
        let snapshot=self.bridge(app,label,"snapshot",json!({})).await?;
        let length=snapshot["content"].as_str().ok_or("renderer_snapshot")?.encode_utf16().count() as u64;
        let from=scope["from"].as_u64().ok_or("invalid_scope")?;let to=scope["to"].as_u64().ok_or("invalid_scope")?;
        if from>to||to>length {return Err("invalid_scope".into());}
        d.authorization_epoch+=1;d.client=Some(client.into());d.scope=Some(scope);
        self.inner.registry.lock().unwrap().documents.insert(session.into(),d.clone());Ok(d)
    }
    fn document(&self,app:&tauri::AppHandle,client:&str,args:&Value)->Result<OpenedDocument,String> {
        if !*self.inner.enabled.lock().unwrap() {return Err("connection_disabled".into());}
        let session=required(args,"session_id")?;
        let d=self.inner.registry.lock().unwrap().documents.get(session).cloned().ok_or("stale_session")?;
        if d.document_id!=required(args,"document_id")?||d.client.as_deref()!=Some(client)||args["authorization_epoch"].as_u64()!=Some(d.authorization_epoch) {return Err("not_authorized".into());}
        if !app.state::<super::Documents>().0.lock().unwrap().contains_key(&d.label)||app.get_webview_window(&d.label).is_none(){return Err("stale_session".into());}Ok(d)
    }
    pub async fn call(&self,app:&tauri::AppHandle,client:&str,name:&str,args:Value)->Result<Value,String> {
        let _serial=self.inner.queue.lock().await;
        if name=="list_documents" {
            if !*self.inner.enabled.lock().unwrap(){return Err("connection_disabled".into());}
            let mut docs:Vec<_>=self.inner.registry.lock().unwrap().documents.values().filter(|d|d.client.as_deref()==Some(client)).cloned().collect();docs.sort_by(|a,b|a.session_id.cmp(&b.session_id));return Ok(json!({"documents":docs}));
        }
        let mut d=self.document(app,client,&args)?;
        match name {
            "read_document"=>{
                let mut snapshot=self.bridge(app,&d.label,"snapshot",json!({})).await?;
                if let Some(rev)=args["revision"].as_u64(){if snapshot["revision"].as_u64()!=Some(rev){return Err("stale_revision".into());}}
                let content=snapshot["content"].as_str().ok_or("renderer_snapshot")?;
                let scope=d.scope.as_ref().ok_or("not_authorized")?;
                let from=args["from"].as_u64().unwrap_or(scope["from"].as_u64().unwrap()) as usize;
                let to=args["to"].as_u64().unwrap_or(scope["to"].as_u64().unwrap()) as usize;
                let units:Vec<_>=content.encode_utf16().collect();
                if from<scope["from"].as_u64().unwrap() as usize||to>scope["to"].as_u64().unwrap() as usize||from>to||to>units.len(){return Err("outside_scope".into());}
                snapshot["content"]=json!(String::from_utf16(&units[from..to]).map_err(|_|"invalid_unicode_boundary")?);
                snapshot["range"]=json!({"from":from,"to":to});snapshot["document_id"]=json!(d.document_id);snapshot["session_id"]=json!(d.session_id);Ok(snapshot)
            },
            "begin_edit"=>{
                let request=required(&args,"request_id")?;
                let key=format!("{}:begin:{request}",d.session_id);let hash=digest(&args);
                if let Some((old,result))=self.inner.results.lock().unwrap().get(&key){if old==&hash{return Ok(result.clone());}return Err("request_id_conflict".into());}
                if d.task.is_some() {return Err("document_locked".into());}
                let snapshot=self.bridge(app,&d.label,"snapshot",json!({})).await?;
                if args["revision"]!=snapshot["revision"] {return Err("stale_revision".into());}
                let task=json!({"task_id":id("task"),"request_id":request,"session_id":d.session_id,"document_id":d.document_id,"authorization_epoch":d.authorization_epoch,"scope":d.scope,"revision":snapshot["revision"]});
                self.bridge(app,&d.label,"begin",task.clone()).await?;d.task=Some(task.clone());self.inner.registry.lock().unwrap().documents.insert(d.session_id.clone(),d);
                self.inner.results.lock().unwrap().insert(key,(hash,task.clone()));Ok(task)
            },
            "apply_edit_batch"=>{
                let request=required(&args,"request_id")?;let key=format!("{}:{request}",d.session_id);let hash=digest(&args);
                if let Some((old,result))=self.inner.results.lock().unwrap().get(&key){if old==&hash{return Ok(result.clone());}return Err("request_id_conflict".into());}
                let task=d.task.as_ref().ok_or("task_stopped")?;
                if task["task_id"]!=args["task_id"]{return Err("stale_task".into());}
                let mut batch=args.clone();batch["mutation_id"]=json!(id("mutation"));
                let result=self.bridge(app,&d.label,"apply",batch).await?;
                d.scope=Some(result["scope"].clone());self.inner.registry.lock().unwrap().documents.insert(d.session_id.clone(),d);
                self.inner.results.lock().unwrap().insert(key,(hash,result.clone()));Ok(result)
            },
            "task_status"=>{
                let mut snapshot=self.bridge(app,&d.label,"snapshot",json!({})).await?;
                let scope=d.scope.as_ref().ok_or("not_authorized")?;let units:Vec<_>=snapshot["content"].as_str().ok_or("renderer_snapshot")?.encode_utf16().collect();
                let from=scope["from"].as_u64().unwrap() as usize;let to=scope["to"].as_u64().unwrap() as usize;
                if to>units.len(){return Err("stale_scope".into());}
                snapshot["content"]=json!(String::from_utf16(&units[from..to]).map_err(|_|"invalid_unicode_boundary")?);
                Ok(json!({"task":d.task,"snapshot":snapshot}))
            },
            "finish_edit"|"stop_edit"=>{
                if let Some(task)=&d.task {if task["task_id"]!=args["task_id"] {return Err("stale_task".into());}self.bridge(app,&d.label,"finish",task.clone()).await?;}
                d.task=None;self.inner.registry.lock().unwrap().documents.insert(d.session_id.clone(),d);Ok(json!({"state":"finished","disk_status":"unsaved"}))
            },
            _=>Err("unknown_tool".into()),
        }
    }
    pub async fn serve_http(&self,app:tauri::AppHandle,client:String,token:String)->Result<u16,String> {
        let broker=self.clone();
        let handler=LeafMcpHandler{broker:broker.clone(),app,client:client.clone()};
        let service=StreamableHttpService::new(move||Ok(handler.clone()),Arc::new(LocalSessionManager::default()),StreamableHttpServerConfig::default().with_legacy_session_mode(false).with_json_response(true).enforce_origin_validation());
        let auth=token.clone();let client_key=client.clone();
        let route=axum::Router::new().nest_service("/mcp",service).layer(axum::middleware::from_fn(move |req:axum::extract::Request,next:axum::middleware::Next|{let auth=auth.clone();let client_key=client_key.clone();let broker=broker.clone();async move{
            let valid=req.headers().get("authorization").and_then(|v|v.to_str().ok()).is_some_and(|v|v==format!("Bearer {auth}")) && *broker.inner.enabled.lock().unwrap() && broker.inner.credentials.lock().unwrap().get(&client_key)==Some(&auth);
            if !valid {return axum::http::StatusCode::UNAUTHORIZED.into_response();}next.run(req).await
        }}));
        use axum::response::IntoResponse;
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|_|"broker_bind")?;let port=listener.local_addr().map_err(|_|"broker_bind")?.port();
        tauri::async_runtime::spawn(async move{let _=axum::serve(listener,route).await;});Ok(port)
    }
}

#[derive(Clone)]
struct LeafMcpHandler {broker:LeafMcpBroker,app:tauri::AppHandle,client:String}
impl ServerHandler for LeafMcpHandler {
    fn get_info(&self)->ServerConfig {let mut info=ServerConfig::default();info.capabilities=ServerCapabilities::builder().enable_tools().build();info}
    async fn list_tools(&self,_:Option<PaginatedRequestParams>,_:RequestContext<RoleServer>)->Result<ListToolsResult,ErrorData> {
        let names=["list_documents","read_document","begin_edit","apply_edit_batch","task_status","finish_edit","stop_edit"];
        let tools=names.into_iter().map(|name|serde_json::from_value(json!({"name":name,"description":"Access an explicitly authorized open Leaf document","inputSchema":{"type":"object","properties":{},"additionalProperties":true}})).unwrap()).collect();Ok(ListToolsResult{tools,..Default::default()})
    }
    async fn call_tool(&self,params:CallToolRequestParams,_:RequestContext<RoleServer>)->Result<CallToolResponse,ErrorData> {
        let result=self.broker.call(&self.app,&self.client,&params.name,Value::Object(params.arguments.unwrap_or_default())).await;
        let (content,error)=match result{Ok(v)=>(v,false),Err(e)=>(json!({"error":e}),true)};
        let result:CallToolResult=serde_json::from_value(json!({"content":[{"type":"text","text":content.to_string()}],"structuredContent":content,"isError":error})).map_err(|_|ErrorData::internal_error("result encoding",None))?;Ok(result.into())
    }
}

#[tauri::command]
pub fn mcp_register(app:tauri::AppHandle,window:tauri::WebviewWindow,broker:tauri::State<LeafMcpBroker>)->Result<OpenedDocument,String> {
    if !app.state::<super::Documents>().0.lock().unwrap().contains_key(window.label()) {return Err("not_document_window".into());}Ok(broker.register(window.label()))
}
#[tauri::command]
pub fn mcp_renderer_reply(window:tauri::WebviewWindow,broker:tauri::State<LeafMcpBroker>,call_id:String,reply:Value)->Result<(),String> {
    let mut pending=broker.inner.bridge.pending.lock().unwrap();
    if pending.get(&call_id).is_none_or(|(label,_)|label!=window.label()){return Err("unknown_bridge_call".into());}
    let (_,tx)=pending.remove(&call_id).unwrap();let _=tx.send(reply);Ok(())
}
#[tauri::command]
pub async fn mcp_authorize(app:tauri::AppHandle,window:tauri::WebviewWindow,broker:tauri::State<'_,LeafMcpBroker>,session_id:String,client:String,scope:Value)->Result<OpenedDocument,String> {broker.authorize(&app,window.label(),&session_id,&client,scope).await}
