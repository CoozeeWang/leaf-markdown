//! Test driver exists only in explicitly isolated native-smoke builds.
use tauri::{Manager,Emitter};
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
    config.app.windows[0].incognito=true;
    #[cfg(target_os="macos")]
    { config.app.windows[0].data_store_identifier=Some(digest[..16].try_into().unwrap());config.app.windows[0].create=false; }
}

#[tauri::command]
pub fn mcp_test_mode(app: tauri::AppHandle,window:tauri::WebviewWindow) -> Option<String> {
    (enabled(&app) && window.label().starts_with("document-")).then(|| if window.label()=="document-1" {std::env::var("LEAF_MCP_TEST_MODE").unwrap_or_default()}else{"passive".into()})
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
    #[cfg(target_os="macos")]
    for isolated in [window.clone(),app.get_webview_window("main").ok_or("test launcher absent")?] {
        let (tx,rx)=tokio::sync::oneshot::channel();
        isolated.with_webview(move |webview|unsafe {
            use objc2::{msg_send,runtime::AnyObject};
            let view=webview.inner() as *mut AnyObject;
            let config:*mut AnyObject=msg_send![view,configuration];
            let store:*mut AnyObject=msg_send![config,websiteDataStore];
            let persistent:bool=msg_send![store,isPersistent];
            let _=tx.send(!persistent);
        }).map_err(|_|"native data store inspection")?;
        ensure(rx.await.map_err(|_|"native data store inspection")?,"actual WKWebView must use ephemeral isolated storage")?;
    }
    ensure(window.is_visible().unwrap_or(false),"native document must be visible")?;
    ensure(app.state::<super::Documents>().0.lock().unwrap().get(label)==Some(&None),"actual unsaved document registry")?;
    let _=broker.bridge(app,label,"test",json!({"action":"reset","content":""})).await?;
    let original=broker.inner.registry.lock().unwrap().documents.values().find(|d|d.label==label).cloned().ok_or("renderer registration absent")?;
    ensure(original.client.is_none(),"default authorization must be closed")?;
    let token=super::mcp::digest(&json!(std::env::var("LEAF_MCP_TEST_DIR").unwrap()));
    broker.inner.credentials.lock().unwrap().insert("synthetic-client".into(),token.clone());
    *broker.inner.enabled.lock().unwrap()=true;
    let port=broker.serve_http(app.clone(),"synthetic-client".into(),token.clone()).await?;
    let mut headers=std::collections::HashMap::new();
    headers.insert("origin".parse().unwrap(),"https://untrusted.invalid".parse().unwrap());
    let origin=StreamableHttpClientTransportConfig::with_uri(format!("http://127.0.0.1:{port}/mcp")).auth_header(token.clone()).custom_headers(headers).reinit_on_expired_session(false);
    ensure(().serve(StreamableHttpClientTransport::from_config(origin)).await.is_err(),"authenticated unapproved Origin must be rejected")?;
    let bad_auth=StreamableHttpClientTransportConfig::with_uri(format!("http://127.0.0.1:{port}/mcp")).auth_header("invalid-synthetic-token").reinit_on_expired_session(false);
    ensure(().serve(StreamableHttpClientTransport::from_config(bad_auth)).await.is_err(),"wrong bearer must be rejected")?;
    let config=StreamableHttpClientTransportConfig::with_uri(format!("http://127.0.0.1:{port}/mcp")).auth_header(token).reinit_on_expired_session(false);
    let client=().serve(StreamableHttpClientTransport::from_config(config)).await.map_err(|_|"standard MCP initialize")?;
    let listing=serde_json::to_value(client.list_tools(None).await.map_err(|_|"standard MCP tools discovery")?).map_err(|_|"tools encoding")?;
    let apply=listing["tools"].as_array().unwrap().iter().find(|tool|tool["name"]=="apply_edit_batch").ok_or("batch tool missing")?;
    ensure(apply["inputSchema"]["required"].as_array().unwrap().contains(&json!("request_id")),"MCP discovery explains mutation request identity")?;
    if mode=="renderer-ack-loss-restart" {
        let snapshot=broker.bridge(app,label,"snapshot",json!({})).await?;
        let records=broker.inner.ledger.records.lock().unwrap().values().cloned().collect::<Vec<_>>();
        ensure(records.iter().any(|r|r.state=="PREPARED"),"pending ledger survived actual process restart")?;
        ensure(records.iter().any(|r|r.state=="FINALIZED"),"finalized ledger survived actual process restart")?;
        for record in records.iter().filter(|r|r.state=="PREPARED"||r.state=="FINALIZED") {
            let args=json!({"document_id":"retired-document","session_id":record.session_id,"authorization_epoch":record.authorization_epoch,"task_id":record.task_id,"request_id":record.request_id,"revision":record.source_revision,"changes":[]});
            ensure(tool(&client,"apply_edit_batch",args.clone()).await.is_err(),"restart cannot resurrect pending or finalized session")?;
            ensure(tool(&client,"reconcile_request",args).await.is_err(),"restart cannot expose old session outcome without authorization")?;
        }
        ensure(broker.bridge(app,label,"snapshot",json!({})).await?==snapshot,"restart never redispatches prepared mutation")?;
        let _=client.cancel().await;return Ok(());
    }
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
    if mode=="task-history-gate" {history_gate(app,label,broker,&client).await?;}
    if mode=="renderer-ack-loss" {ack_loss_gate(app,label,broker,&client).await?;edge_gate(app,label,broker,&client).await?;}
    if mode=="all-write-entrances" {entrances_gate(app,label,broker,&client).await?;}
    if mode=="stop-late-second-window" {stop_late_gate(app,broker,&client).await?;}
    if mode=="properties-markdown" {
        ensure(apply["inputSchema"]["properties"]["operations"].is_object(),"structured operations are discoverable through actual MCP tools/list")?;
        properties_gate(app,label,broker,&client).await?;
    }
    if mode=="footnotes-tables" {
        let schema=apply["inputSchema"]["properties"]["operations"]["items"]["oneOf"].as_array().ok_or("operation discovery")?;
        ensure(schema.iter().any(|s|s["properties"]["kind"]["const"]=="footnote")&&schema.iter().any(|s|s["properties"]["kind"]["const"]=="table"),"footnote/table operations discoverable through actual MCP")?;
        footnotes_tables_gate(app,label,broker,&client).await?;
    }
    broker.unregister(label);
    ensure(tool(&client,"read_document",binding).await.is_err(),"closed session must fail")?;
    let _=client.cancel().await;Ok(())
}

async fn footnotes_tables_gate(app:&tauri::AppHandle,label:&str,broker:&super::mcp::LeafMcpBroker,client:&rmcp::service::Peer<rmcp::service::RoleClient>)->Result<(),String>{
    let source="---\ntitle: \"Old\"\n---\n\n# Old\n\nBody😀é[^a] again[^a]\n\n| A | B |\n| --- | ---: |\n| old | `code\\|pipe` |\n\n[^a]: old note\n\n[^orphan]: keep\n";
    let reset=broker.bridge(app,label,"test",json!({"action":"reset","content":source})).await?;
    let session=broker.inner.registry.lock().unwrap().documents.values().find(|d|d.label==label).unwrap().session_id.clone();
    let d=broker.authorize(app,label,&session,"synthetic-client",json!({"from":0,"to":source.encode_utf16().count()})).await?;
    let binding=json!({"document_id":d.document_id,"session_id":d.session_id,"authorization_epoch":d.authorization_epoch});
    let mut begin=binding.clone();begin["request_id"]=json!("footnotes-tables-begin");begin["revision"]=reset["revision"].clone();
    let task=tool(client,"begin_edit",begin).await?;
    let table_range=|text:&str|{let from=text.find("\n\n|").unwrap()+2;let to=from+text[from..].find("\n\n").unwrap();(text[..from].encode_utf16().count(),text[..to].encode_utf16().count(),text[from..to].to_string())};
    let (from,to,raw)=table_range(source);let heading=source[..source.find("# Old").unwrap()+2].encode_utf16().count();
    let mut batch=binding.clone();batch["task_id"]=task["task_id"].clone();batch["request_id"]=json!("footnotes-tables-mixed");batch["revision"]=reset["revision"].clone();
    batch["operations"]=json!([
        {"kind":"property","action":"set","key":"title","expected":"\"Old\"","value":"New"},
        {"kind":"footnote","action":"set-definition","id":"a","expected":"[^a]: old note","body":"**Updated😀é**\n\nSecond *paragraph*"},
        {"kind":"table","action":"set-cell","from":from,"to":to,"expected":raw,"row":1,"column":0,"value":"**Cell😀é**"}
    ]);
    batch["changes"]=json!([{"from":heading,"to":heading+3,"expected":"Old","insert":"New heading"}]);
    let receipt=tool(client,"apply_edit_batch",batch.clone()).await?;
    ensure(receipt["changed"]==true,"actual mixed MCP dispatch changed current editor")?;
    ensure(tool(client,"apply_edit_batch",batch.clone()).await?==receipt,"mixed receipt idempotent")?;
    batch["operations"][1]["body"]=json!("different");ensure(tool(client,"apply_edit_batch",batch).await.is_err(),"mixed digest binds operations and changes")?;
    for (index,action) in ["add","add-reference","delete-reference","rename","renumber","delete","add-definition","delete-definition","set-header","set-alignment","insert-row","delete-row","insert-column","delete-column"].into_iter().enumerate(){
        let before=broker.bridge(app,label,"snapshot",json!({})).await?;let text=before["content"].as_str().unwrap();
        let def=|id:&str|{let start=text.find(&format!("[^{id}]:")).unwrap();let tail=&text[start..];tail[..tail.find("\n\n").unwrap_or_else(||tail.trim_end_matches('\n').len())].to_string()};
        let operation=match action {
            "add"|"add-reference"=>{let at=text[..text.find(" again").unwrap()].encode_utf16().count();json!({"kind":"footnote","action":action,"id":"c","from":at,"to":at,"expected":"","body":"new note"})},
            "delete-reference"=>{let start=text.find("[^c]").unwrap();let at=text[..start].encode_utf16().count();json!({"kind":"footnote","action":action,"id":"c","from":at,"to":at+4,"expected":"[^c]"})},
            "rename"=>json!({"kind":"footnote","action":action,"id":"c","new_id":"renamed","expected":def("c")}),
            "renumber"=>json!({"kind":"footnote","action":action,"include_named":true}),
            "delete"=>json!({"kind":"footnote","action":action,"id":"2","expected":def("2")}),
            "add-definition"=>json!({"kind":"footnote","action":action,"id":"temp","expected":"","body":"temporary"}),
            "delete-definition"=>json!({"kind":"footnote","action":action,"id":"temp","expected":def("temp")}),
            _=>{let (from,to,raw)=table_range(text);let mut op=json!({"kind":"table","action":action,"from":from,"to":to,"expected":raw});match action{
                "set-header"=>{op["values"]=json!(["Updated","B"]);},
                "set-alignment"=>{op["column"]=json!(0);op["alignment"]=json!("center");},
                "insert-row"=>{op["index"]=json!(2);op["values"]=json!(["last","final"]);},
                "delete-row"=>{op["index"]=json!(2);},
                "insert-column"=>{op["index"]=json!(2);op["values"]=json!(["C","column"]);op["alignment"]=json!("right");},
                "delete-column"=>{op["index"]=json!(2);},_=>{}
            }op}
        };
        let mut batch=binding.clone();batch["task_id"]=task["task_id"].clone();batch["request_id"]=json!(format!("structure-action-{index}"));batch["revision"]=before["revision"].clone();batch["operations"]=json!([operation]);
        tool(client,"apply_edit_batch",batch).await.map_err(|e|format!("{action}: {e}"))?;
    }
    let after=broker.bridge(app,label,"snapshot",json!({})).await?;let text=after["content"].as_str().unwrap();
    ensure(text.contains("title: \"New\"")&&text.contains("# New heading")&&text.contains("**Updated😀é**")&&text.contains("Second *paragraph*")&&text.contains("**Cell😀é**")&&text.contains("`code\\|pipe`")&&text.contains("[^orphan]: keep"),"mixed native source preserves structures and Unicode")?;
    for (index,insert) in ["Body[^missing]","Body","Body[^missing]"].into_iter().enumerate(){
        let at=text[..text.find("Body").unwrap()].encode_utf16().count();let (from,to,raw)=table_range(text);
        let mut invalid=binding.clone();invalid["task_id"]=task["task_id"].clone();invalid["request_id"]=json!(format!("structure-invalid-{index}"));invalid["revision"]=after["revision"].clone();
        if index<2 {invalid["operations"]=json!([{"kind":"table","action":"set-cell","from":from,"to":to,"expected":raw,"row":1,"column":0,"value":if index==0{"safe"}else{"bad|extra"}}]);}
        invalid["changes"]=json!([{"from":at,"to":at+4,"expected":"Body","insert":insert}]);
        ensure(tool(client,"apply_edit_batch",invalid).await.is_err(),"invalid mixed batch rejected")?;
        ensure(broker.bridge(app,label,"snapshot",json!({})).await?==after,"invalid mixed batch has zero content/revision mutation")?;
    }
    let mut end=binding.clone();end["task_id"]=task["task_id"].clone();tool(client,"finish_edit",end).await?;
    ensure(broker.bridge(app,label,"test",json!({"action":"undo"})).await?["content"]==source,"one actual undo restores all mixed MCP structure batches")?;
    ensure(broker.bridge(app,label,"test",json!({"action":"redo"})).await?["content"]==after["content"],"one actual redo restores complete mixed structure task")?;
    Ok(())
}

async fn properties_gate(app:&tauri::AppHandle,label:&str,broker:&super::mcp::LeafMcpBroker,client:&rmcp::service::Peer<rmcp::service::RoleClient>)->Result<(),String>{
    let source="---\n# keep\ntitle: \"Old\" # inline\ncount: 0x10\ncomplex: &anchor {nested: value}\n---\n\n# Heading\n\nBody 😀é\n";
    let reset=broker.bridge(app,label,"test",json!({"action":"reset","content":source})).await?;
    let session=broker.inner.registry.lock().unwrap().documents.values().find(|d|d.label==label).unwrap().session_id.clone();
    let d=broker.authorize(app,label,&session,"synthetic-client",json!({"from":0,"to":source.encode_utf16().count()})).await?;
    let binding=json!({"document_id":d.document_id,"session_id":d.session_id,"authorization_epoch":d.authorization_epoch});
    let mut begin=binding.clone();begin["request_id"]=json!("structure-begin");begin["revision"]=reset["revision"].clone();
    let task=tool(client,"begin_edit",begin).await?;
    let mut revision=reset["revision"].clone();
    for (index,operation) in [
        json!({"kind":"property","action":"set","key":"title","expected":"\"Old\"","value":"New"}),
        json!({"kind":"property","action":"add","key":"tags","expected":"","value":["synthetic","😀"]}),
        json!({"kind":"property","action":"delete","key":"title","expected":"\"New\""})
    ].into_iter().enumerate(){
        let mut batch=binding.clone();batch["task_id"]=task["task_id"].clone();batch["request_id"]=json!(format!("property-{index}"));batch["revision"]=revision.clone();batch["operations"]=json!([operation]);
        let result=tool(client,"apply_edit_batch",batch.clone()).await?;
        ensure(result["changed"]==true,"property operation must reach actual editor")?;
        ensure(tool(client,"apply_edit_batch",batch.clone()).await?==result,"property retry must return exact receipt")?;
        batch["operations"][0]["expected"]=json!("different source");
        ensure(tool(client,"apply_edit_batch",batch).await.is_err(),"operations are bound to request digest")?;
        revision=result["applied_revision"].clone();
    }
    let before=broker.bridge(app,label,"snapshot",json!({})).await?;
    ensure(before["content"].as_str().unwrap()==source.replace("title: \"Old\" ","").replace("---\n\n# Heading","\"tags\": [\"synthetic\",\"😀\"]\n---\n\n# Heading"),"property source and comments preserved")?;
    for (index,operations) in [
        json!([{"kind":"property","action":"set","key":"complex","expected":"{nested: value}","value":"bad"}]),
        json!([{"kind":"property","action":"set","key":"count","expected":"0x10","value":20},{"kind":"unknown"}])
    ].into_iter().enumerate(){
        let mut batch=binding.clone();batch["task_id"]=task["task_id"].clone();batch["request_id"]=json!(format!("property-refused-{index}"));batch["revision"]=revision.clone();batch["operations"]=operations;
        ensure(tool(client,"apply_edit_batch",batch).await.is_err(),"unsupported batch must fail before any mutation")?;
        ensure(broker.bridge(app,label,"snapshot",json!({})).await?==before,"rejected property batch leaves exact snapshot")?;
    }
    let current=before["content"].as_str().unwrap();let heading_byte=current.find("Heading").unwrap();let heading=current[..heading_byte].encode_utf16().count();
    let mut mixed=binding.clone();mixed["task_id"]=task["task_id"].clone();mixed["request_id"]=json!("mixed-structure");mixed["revision"]=revision.clone();mixed["operations"]=json!([
        {"kind":"property","action":"set","key":"count","expected":"0x10","value":20},
        {"kind":"markdown","from":heading,"to":heading+7,"expected":"Heading","insert":"Updated"}
    ]);
    let result=tool(client,"apply_edit_batch",mixed.clone()).await?;ensure(result["changed"]==true,"mixed structure reaches same native transaction")?;
    ensure(tool(client,"apply_edit_batch",mixed.clone()).await?==result,"mixed structure receipt is idempotent")?;
    let after=broker.bridge(app,label,"snapshot",json!({})).await?;
    ensure(after["content"].as_str().unwrap()==current.replace("count: 0x10","count: 20").replace("# Heading","# Updated"),"mixed property and Markdown source exact")?;
    mixed["request_id"]=json!("stale-structure");ensure(tool(client,"apply_edit_batch",mixed).await.is_err(),"stale structured revision rejected")?;
    let mut end=binding.clone();end["task_id"]=task["task_id"].clone();tool(client,"finish_edit",end).await?;
    ensure(broker.bridge(app,label,"test",json!({"action":"undo"})).await?["content"]==source,"whole property task undo")?;
    ensure(broker.bridge(app,label,"test",json!({"action":"redo"})).await?["content"]==after["content"],"whole mixed property and Markdown task redo")?;
    Ok(())
}

async fn stop_late_gate(app:&tauri::AppHandle,broker:&super::mcp::LeafMcpBroker,client:&rmcp::service::Peer<rmcp::service::RoleClient>)->Result<(),String>{
    let root=std::path::PathBuf::from(std::env::var("LEAF_MCP_TEST_DIR").unwrap());
    let path=root.join("synthetic.md");
    let previous=broker.inner.registry.lock().unwrap().documents.values().map(|d|d.label.clone()).collect::<Vec<_>>();
    super::create_document(app.clone(),Some(path.to_string_lossy().into_owned()),None,None)?;
    let label=wait_document(app,broker,&previous).await?;
    broker.bridge(app,&label,"test",json!({"action":"human","content":"Synthetic saved draft with human history"})).await?;
    let original=broker.bridge(app,&label,"snapshot",json!({})).await?;
    broker.bridge(app,&label,"test",json!({"action":"delay-attachment","files":[root.join("synthetic.txt")]})).await?;
    for _ in 0..100 {if broker.bridge(app,&label,"test",json!({"action":"delay-status"})).await?["started"]==true{break;}tokio::time::sleep(std::time::Duration::from_millis(10)).await;}
    ensure(broker.bridge(app,&label,"test",json!({"action":"delay-status"})).await?["started"]==true,"real production attachment import is delayed")?;
    let d=broker.window_binding(&label).ok_or("saved document registration")?;
    let d=broker.authorize(app,&label,&d.session_id,"synthetic-client",json!({"from":0,"to":original["content"].as_str().unwrap().len()})).await?;
    let binding=json!({"document_id":d.document_id,"session_id":d.session_id,"authorization_epoch":d.authorization_epoch});
    let queued_menu_binding=broker.window_binding(&label).ok_or("menu binding absent")?;
    let mut begin=binding.clone();begin["request_id"]=json!("late-begin");begin["revision"]=original["revision"].clone();
    let task=tool(client,"begin_edit",begin).await?;
    let before_count=app.state::<super::Documents>().0.lock().unwrap().len();
    let alias=root.join("alias.md");std::fs::hard_link(&path,&alias).map_err(|_|"synthetic hardlink")?;
    super::create_document(app.clone(),Some(alias.to_string_lossy().into_owned()),None,None)?;
    ensure(app.state::<super::Documents>().0.lock().unwrap().len()==before_count,"hardlink alias cannot open second writer window")?;
    let moved=root.join("renamed.md");std::fs::rename(&path,&moved).map_err(|_|"synthetic rename")?;
    super::create_document(app.clone(),Some(moved.to_string_lossy().into_owned()),None,None)?;
    ensure(app.state::<super::Documents>().0.lock().unwrap().len()==before_count,"renamed alias focuses same logical document")?;
    let second_previous=broker.inner.registry.lock().unwrap().documents.values().map(|d|d.label.clone()).collect::<Vec<_>>();
    super::create_document(app.clone(),Some(root.join("different.md").to_string_lossy().into_owned()),None,None)?;
    let other=wait_document(app,broker,&second_previous).await?;
    broker.bridge(app,&other,"test",json!({"action":"human","content":"Independent human edit"})).await?;
    ensure(broker.bridge(app,&other,"snapshot",json!({})).await?["content"]=="Independent human edit","other real native window remains editable")?;
    broker.bridge(app,&label,"test",json!({"action":"native-stop","task_id":task["task_id"]})).await?;
    let status=tool(client,"task_status",binding.clone()).await?;
    ensure(status["task"].is_null(),"native stop completes actual renderer finalization")?;
    app.emit_to(&label,"leaf-menu",json!({"command":"undo","binding":queued_menu_binding})).map_err(|_|"late production menu event")?;
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    ensure(broker.bridge(app,&label,"snapshot",json!({})).await?==original,"pre-lock queued native menu cannot undo after stop")?;
    broker.bridge(app,&label,"test",json!({"action":"release-attachment"})).await?;
    let recovered=broker.bridge(app,&label,"test",json!({"action":"late-recovery"})).await;
    ensure(matches!(recovered,Err(ref error) if error=="stale_mutation_context"),"late recovery refuses stopped context before session restore")?;
    ensure(broker.bridge(app,&label,"snapshot",json!({})).await?==original,"late attachment and recovery never advance stopped revision")?;
    let mut late=binding.clone();late["task_id"]=task["task_id"].clone();late["request_id"]=json!("late-batch");late["revision"]=original["revision"].clone();late["changes"]=json!([{"from":0,"to":0,"expected":"","insert":"forbidden"}]);
    ensure(tool(client,"apply_edit_batch",late.clone()).await.is_err(),"late AI batch fails after native stop")?;
    late["session_id"]=json!("retired-session");ensure(tool(client,"apply_edit_batch",late.clone()).await.is_err(),"retired native session is rejected")?;
    late["session_id"]=binding["session_id"].clone();late["authorization_epoch"]=json!(0);ensure(tool(client,"apply_edit_batch",late).await.is_err(),"retired native epoch is rejected")?;
    broker.bridge(app,&label,"test",json!({"action":"human","content":"Human resumed after actual stop"})).await?;
    ensure(broker.bridge(app,&label,"snapshot",json!({})).await?["content"]=="Human resumed after actual stop","manual edits resume after finalization")?;
    Ok(())
}

async fn wait_document(app:&tauri::AppHandle,broker:&super::mcp::LeafMcpBroker,previous:&[String])->Result<String,String>{
    for _ in 0..100 {
        let label=broker.inner.registry.lock().unwrap().documents.values().find(|d|!previous.contains(&d.label)).map(|d|d.label.clone());
        if let Some(label)=label {if broker.bridge(app,&label,"snapshot",json!({})).await.is_ok(){return Ok(label);}}
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }Err("second renderer registration timeout".into())
}
async fn entrances_gate(app:&tauri::AppHandle,label:&str,broker:&super::mcp::LeafMcpBroker,client:&rmcp::service::Peer<rmcp::service::RoleClient>)->Result<(),String>{
    let source="---\ntitle: Synthetic\n---\n\n# Heading\n\nBody[^1] {==quote==}{>>note<<}\n\n| A | B |\n| --- | --- |\n| one | two |\n\n[^1]: Footnote\n";
    broker.bridge(app,label,"test",json!({"action":"reset","content":source})).await?;
    let snapshot=broker.bridge(app,label,"snapshot",json!({})).await?;
    let d=broker.register(label);let d=broker.authorize(app,label,&d.session_id,"synthetic-client",json!({"from":0,"to":source.encode_utf16().count()})).await?;
    let binding=json!({"document_id":d.document_id,"session_id":d.session_id,"authorization_epoch":d.authorization_epoch});
    let mut begin=binding.clone();begin["revision"]=snapshot["revision"].clone();begin["request_id"]=json!("entrances-begin");
    let task=tool(client,"begin_edit",begin).await?;
    for entrance in ["body","source","properties","footnote","table","comment","writing","recovery","attachment"] {
        let outcome=broker.bridge(app,label,"test",json!({"action":"entrance","entrance":entrance,"files":["synthetic.txt"]})).await;
        if entrance=="recovery" {ensure(matches!(outcome,Err(ref error) if error=="document_locked"),"recovery refused before session state changes")?;}else{outcome?;}
        ensure(broker.bridge(app,label,"snapshot",json!({})).await?==snapshot,&format!("production {entrance} changed locked draft"))?;
    }
    for command in super::MUTATING_MENU_IDS {
        ensure(!super::dispatch_document_menu(app,label,command)?,&format!("native {command} must reject locked recipient"))?;
        let item=super::document_menu_item(app,command).ok_or("native menu absent")?;
        ensure(!item.is_enabled().map_err(|_|"menu enabled inspection")?,"actual native edit menu must be disabled")?;
    }
    let previous=broker.inner.registry.lock().unwrap().documents.values().map(|d|d.label.clone()).collect::<Vec<_>>();
    super::create_document(app.clone(),None,Some("Another synthetic document".into()),None)?;
    let other=wait_document(app,broker,&previous).await?;
    broker.bridge(app,&other,"test",json!({"action":"human","content":"Another edited document"})).await?;
    ensure(broker.bridge(app,&other,"snapshot",json!({})).await?["content"]=="Another edited document","different production document remains editable")?;
    ensure(super::dispatch_document_menu(app,&other,"undo")?,"native history route works in independent document")?;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    ensure(broker.bridge(app,&other,"snapshot",json!({})).await?["content"]=="Another synthetic document","native menu event reaches other CodeMirror history")?;
    ensure(broker.bridge(app,label,"snapshot",json!({})).await?==snapshot,"another window event must not alter locked document")?;
    let mut end=binding;end["task_id"]=task["task_id"].clone();tool(client,"stop_edit",end).await?;
    broker.bridge(app,label,"test",json!({"action":"human","content":"Human resumed"})).await?;
    ensure(broker.bridge(app,label,"snapshot",json!({})).await?["content"]=="Human resumed","human resumes after native finalize")?;
    Ok(())
}

async fn ack_loss_gate(app:&tauri::AppHandle,label:&str,broker:&super::mcp::LeafMcpBroker,client:&rmcp::service::Peer<rmcp::service::RoleClient>)->Result<(),String> {
    for (i,fault) in ["drop-ack","before-dispatch","unknown-receipt"].into_iter().enumerate() {
        broker.bridge(app,label,"test",json!({"action":"reset","content":"left right"})).await?;
        let snapshot=broker.bridge(app,label,"snapshot",json!({})).await?;
        let d=broker.register(label);let d=broker.authorize(app,label,&d.session_id,"synthetic-client",json!({"from":0,"to":10})).await?;
        let binding=json!({"document_id":d.document_id,"session_id":d.session_id,"authorization_epoch":d.authorization_epoch});
        let mut begin=binding.clone();begin["request_id"]=json!(format!("loss-begin-{i}"));begin["revision"]=snapshot["revision"].clone();
        let task=tool(client,"begin_edit",begin).await?;
        let mut batch=binding.clone();batch["task_id"]=task["task_id"].clone();batch["request_id"]=json!(format!("loss-batch-{i}"));batch["revision"]=snapshot["revision"].clone();batch["changes"]=json!([{"from":0,"to":4,"expected":"left","insert":"LEFT"}]);batch["test_fault"]=json!(fault);
        let outcome=tool(client,"apply_edit_batch",batch.clone()).await;
        let observed=broker.bridge(app,label,"snapshot",json!({})).await?;
        let record=broker.inner.ledger.records.lock().unwrap().get(&format!("{}:loss-batch-{i}",d.session_id)).cloned().ok_or("durable ledger missing")?;
        if fault=="drop-ack" {
            let receipt=outcome.map_err(|_|"post-dispatch ack loss must reconcile")?;
            ensure(observed["content"]=="LEFT right" && observed["revision"].as_u64()==Some(snapshot["revision"].as_u64().unwrap()+1),"ack loss must apply exactly once")?;
            ensure(record.transitions==["PREPARED","APPLIED","FINALIZED"],"durable ledger transition sequence")?;
            ensure(tool(client,"apply_edit_batch",batch.clone()).await?==receipt,"external response loss returns original result")?;
            let mut query=binding.clone();query["request_id"]=batch["request_id"].clone();ensure(tool(client,"reconcile_request",query).await?==receipt,"query returns unique finalized result")?;
            batch["changes"][0]["insert"]=json!("DIFFERENT");ensure(tool(client,"apply_edit_batch",batch).await.is_err(),"different digest cannot reuse request ID")?;
            let mut end=binding.clone();end["task_id"]=task["task_id"].clone();tool(client,"finish_edit",end).await?;
        } else if fault=="before-dispatch" {
            ensure(outcome.is_err() && observed==snapshot,"pre-dispatch failure must not mutate")?;
            ensure(record.state=="REJECTED","pre-dispatch known unapplied outcome")?;
            let mut end=binding.clone();end["task_id"]=task["task_id"].clone();tool(client,"stop_edit",end).await?;
        } else {
            ensure(outcome.is_err() && observed["content"]=="LEFT right","unknown receipt preserves applied draft")?;
            ensure(record.state=="UNKNOWN","unknown receipt fails closed")?;
            ensure(broker.inner.registry.lock().unwrap().documents[&d.session_id].task.is_none(),"unknown receipt finalizes task history and unlocks")?;
            batch["request_id"]=json!("late-after-unknown");ensure(tool(client,"apply_edit_batch",batch).await.is_err(),"unknown invalidates late task writes")?;
        }
        let text=broker.bridge(app,label,"test",json!({"action":"undo"})).await?;
        ensure(text["content"]=="left right","receipt proof single undo")?;
        let redo=broker.bridge(app,label,"test",json!({"action":"redo"})).await?;
        ensure(redo["content"]==if fault=="before-dispatch" {"left right"}else{"LEFT right"},"receipt proof single redo")?;
        let path=super::application_data(app).map_err(|_|"test ledger path")?.join("mcp-mutations-v1.json");
        let ledger:Value=serde_json::from_slice(&std::fs::read(path).map_err(|_|"test ledger read")?).map_err(|_|"test ledger parse")?;
        ensure(ledger[format!("{}:loss-batch-{i}",d.session_id)]["state"]==record.state,"ledger persisted on disk")?;
    }
    let previous=broker.inner.ledger.records.lock().unwrap().values().find(|r|r.state=="UNKNOWN").cloned().ok_or("unknown restart seed absent")?;
    let mut pending=previous;pending.request_id="restart-pending".into();pending.state="PREPARED".into();pending.result=None;pending.transitions=vec!["PREPARED".into()];
    broker.inner.ledger.save(pending.clone(),format!("{}:restart-pending",pending.session_id))?;
    Ok(())
}

async fn edge_gate(app:&tauri::AppHandle,label:&str,broker:&super::mcp::LeafMcpBroker,client:&rmcp::service::Peer<rmcp::service::RoleClient>)->Result<(),String> {
    broker.bridge(app,label,"test",json!({"action":"reset","content":"first\r\nA😀é last\r\n"})).await?;
    let before=broker.bridge(app,label,"snapshot",json!({})).await?;let content=before["content"].as_str().unwrap();
    ensure(before["line_ending"]=="\r\n","CRLF metadata preserved with LF buffer coordinates")?;
    let d=broker.register(label);let d=broker.authorize(app,label,&d.session_id,"synthetic-client",json!({"from":0,"to":content.encode_utf16().count()})).await?;
    let binding=json!({"document_id":d.document_id,"session_id":d.session_id,"authorization_epoch":d.authorization_epoch});
    let list=tool(client,"list_documents",json!({})).await?;ensure(tool(client,"list_documents",json!({})).await?==list,"stable opened session ordering")?;
    let mut page=binding.clone();page["revision"]=before["revision"].clone();page["from"]=json!(0);page["to"]=json!(6);
    let first=tool(client,"read_document",page.clone()).await?;ensure(tool(client,"read_document",page.clone()).await?==first,"fixed revision reads stable")?;
    page["request_id"]=json!("stable-read-id");let identified=tool(client,"read_document",page.clone()).await?;ensure(tool(client,"read_document",page.clone()).await?==identified,"idempotent read identity")?;
    let mut conflicting=page.clone();conflicting["from"]=json!(1);ensure(tool(client,"read_document",conflicting).await.is_err(),"changed read arguments cannot reuse identity")?;
    page.as_object_mut().unwrap().remove("request_id");
    page["from"]=json!(6);page["to"]=json!(content.encode_utf16().count());let second=tool(client,"read_document",page.clone()).await?;
    ensure(format!("{}{}",first["content"].as_str().unwrap(),second["content"].as_str().unwrap())==content,"pages neither omit nor duplicate source")?;
    ensure(tool(client,"read_document",json!({})).await.is_err(),"missing identity rejects without mutation")?;
    let mut begin=binding.clone();begin["revision"]=before["revision"].clone();begin["request_id"]=json!("competing-a");let mut other=begin.clone();other["request_id"]=json!("competing-b");
    let (a,b)=tokio::join!(tool(client,"begin_edit",begin.clone()),tool(client,"begin_edit",other));ensure(a.is_ok()!=b.is_ok(),"exactly one concurrent task owns document")?;
    let task=a.or(b)?;
    let mut batch=binding.clone();batch["task_id"]=task["task_id"].clone();batch["revision"]=before["revision"].clone();batch["request_id"]=json!("empty-batch");batch["changes"]=json!([]);
    let empty=tool(client,"apply_edit_batch",batch.clone()).await?;ensure(empty["changed"]==false&&empty["applied_revision"]==before["revision"],"empty batch creates no history/revision")?;
    batch["request_id"]=json!("concurrent-a");batch["changes"]=json!([{"from":7,"to":9,"expected":"😀","insert":"🐾"}]);let mut competing=batch.clone();competing["request_id"]=json!("concurrent-b");competing["changes"][0]["insert"]=json!("🌱");
    let (a,b)=tokio::join!(tool(client,"apply_edit_batch",batch),tool(client,"apply_edit_batch",competing));ensure(a.is_ok()!=b.is_ok(),"only one same-revision concurrent batch commits")?;
    ensure(tool(client,"read_document",page).await.is_err(),"old revision pages fail after edit")?;
    let mut end=binding.clone();end["task_id"]=task["task_id"].clone();tool(client,"stop_edit",end.clone()).await?;tool(client,"stop_edit",end).await?;
    let d=broker.authorize(app,label,&d.session_id,"synthetic-client",json!({"from":0,"to":content.encode_utf16().count()})).await?;
    ensure(d.authorization_epoch>binding["authorization_epoch"].as_u64().unwrap(),"new authorization advances epoch")?;
    ensure(tool(client,"read_document",binding.clone()).await.is_err(),"old epoch fails after reauthorization")?;
    let undo=broker.bridge(app,label,"test",json!({"action":"undo"})).await?;ensure(undo["content"]==content&&undo["history"]["undo"]==0,"one concurrent winning batch has one history item")?;
    Ok(())
}

async fn history_gate(app:&tauri::AppHandle,label:&str,broker:&super::mcp::LeafMcpBroker,client:&rmcp::service::Peer<rmcp::service::RoleClient>)->Result<(),String> {
    for (i,reason) in ["normal","partial-stop","save-failed","disconnected","renderer-exception","zero-edits"].into_iter().enumerate() {
        broker.bridge(app,label,"test",json!({"action":"reset","content":"alpha omega"})).await?;
        broker.bridge(app,label,"test",json!({"action":"human","content":"alpha omegaH"})).await?;
        broker.bridge(app,label,"test",json!({"action":"human","content":"alpha omegaHX"})).await?;
        let before=broker.bridge(app,label,"test",json!({"action":"undo"})).await?;
        ensure(before["content"]=="alpha omegaH" && before["history"]["redo"]==1,"human redo branch exists before AI")?;
        let d=broker.register(label);let d=broker.authorize(app,label,&d.session_id,"synthetic-client",json!({"from":0,"to":12})).await?;
        let binding=json!({"document_id":d.document_id,"session_id":d.session_id,"authorization_epoch":d.authorization_epoch});
        let mut begin=binding.clone();begin["request_id"]=json!(format!("history-begin-{i}"));begin["revision"]=before["revision"].clone();
        let task=tool(client,"begin_edit",begin).await?;
        let mut final_text="alpha omegaH";
        let mut revision=before["revision"].clone();
        if reason!="zero-edits" {
            let mut batch=binding.clone();batch["task_id"]=task["task_id"].clone();batch["request_id"]=json!(format!("history-first-{i}"));batch["revision"]=revision.clone();batch["changes"]=json!([{"from":0,"to":5,"expected":"alpha","insert":"ALPHA"}]);batch["test_clock"]=json!(1_000_000);
            revision=tool(client,"apply_edit_batch",batch.clone()).await?["applied_revision"].clone();final_text="ALPHA omegaH";
            broker.bridge(app,label,"test",json!({"action":"selection","anchor":9,"clock":1_180_000})).await?;
            tokio::time::sleep(std::time::Duration::from_millis(650)).await;
            if reason!="partial-stop" {
                batch["request_id"]=json!(format!("history-second-{i}"));batch["revision"]=revision;batch["changes"]=json!([{"from":6,"to":11,"expected":"omega","insert":"OMEGA"}]);batch["test_clock"]=json!(1_360_000);
                if reason=="renderer-exception" {
                    batch["changes"][0]["expected"]=json!("stale");
                    ensure(tool(client,"apply_edit_batch",batch).await.is_err(),"actual renderer rejection")?;
                } else {tool(client,"apply_edit_batch",batch).await?;final_text="ALPHA OMEGAH";}
            }
        }
        if reason=="save-failed" {
            let path=std::path::PathBuf::from(std::env::var("LEAF_MCP_TEST_DIR").unwrap()).join("missing-folder/Synthetic.md");
            let saved=super::write_document(app.clone(),app.get_webview_window(label).unwrap(),app.state::<super::Documents>(),app.state::<super::DocumentAnchors>(),app.state::<super::RecoveryState>(),path.to_string_lossy().into_owned(),final_text.into(),None,vec![]).await;
            ensure(saved.is_err(),"native save failure injected without disk overwrite")?;
        }
        let mut end=binding.clone();end["task_id"]=task["task_id"].clone();end["reason"]=json!(reason);
        tool(client,if reason=="normal"||reason=="zero-edits" {"finish_edit"}else{"stop_edit"},end.clone()).await?;
        let finished=broker.bridge(app,label,"snapshot",json!({})).await?;
        ensure(finished["content"]==final_text,"end retains linearized batches")?;
        tool(client,"finish_edit",end).await?;
        if reason=="zero-edits" {
            let redo=broker.bridge(app,label,"test",json!({"action":"redo"})).await?;
            ensure(redo["content"]=="alpha omegaHX","zero edit preserves existing redo")?;continue;
        }
        let undone=broker.bridge(app,label,"test",json!({"action":"undo"})).await?;
        ensure(undone["content"]=="alpha omegaH",&format!("whole task undo for {reason}"))?;
        let redone=broker.bridge(app,label,"test",json!({"action":"redo"})).await?;
        ensure(redone["content"]==final_text,&format!("whole task redo for {reason}"))?;
        broker.bridge(app,label,"test",json!({"action":"human","content":format!("{final_text}!"),"clock":1_360_001})).await?;
        let manual_undo=broker.bridge(app,label,"test",json!({"action":"undo"})).await?;ensure(manual_undo["content"]==final_text,"next human edit stays separate")?;
        let task_undo=broker.bridge(app,label,"test",json!({"action":"undo"})).await?;ensure(task_undo["content"]=="alpha omegaH","task after manual undo")?;
        let previous=broker.bridge(app,label,"test",json!({"action":"undo"})).await?;ensure(previous["content"]=="alpha omega","prior human history preserved")?;
    }
    Ok(())
}
