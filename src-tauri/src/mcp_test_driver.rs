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
    if mode=="chatgpt-tunnel-tracer" {return tunnel_tracer(app,label,broker,mode).await;}
    if mode=="chatgpt-tunnel-dev-bundle" {return tunnel_lifecycle(app,label,broker).await;}
    if mode=="chatgpt-tunnel-ui" {return connections_ui(app,label,broker).await;}
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
    if mode=="file-identity-conflict" {file_identity_gate(app,broker,&client).await?;}
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

async fn tunnel_tracer(app:&tauri::AppHandle,label:&str,broker:&super::mcp::LeafMcpBroker,_mode:&str)->Result<(),String>{
    use super::mcp::ai_credentials::{BrokerDescriptor,BoundCredential,CredentialRef,SecretStore,OsKeyring,random_token};
    use super::chatgpt_tunnel::TunnelLaunchSpec;
    let directory=std::path::PathBuf::from(std::env::var("LEAF_MCP_TEST_DIR").unwrap());
    let profile_path=directory.join("transient-tunnel.json");let evidence=directory.join("tunnel-evidence.json");
    let formal=super::application_data(app).map_err(|_|"test data")?.join("mcp-profiles-v1.json");let before=std::fs::read(&formal).ok();
    let source="Synthetic live Tunnel buffer";
    broker.bridge(app,label,"test",json!({"action":"reset","content":source})).await?;
    let session=broker.window_binding(label).ok_or("test document")?.session_id;
    let token=random_token()?;
    *broker.inner.enabled.lock().unwrap()=true;broker.inner.credentials.lock().unwrap().insert("chatgpt".into(),token.clone());
    let port=broker.serve_http(app.clone(),"chatgpt".into(),token.clone()).await?;
    let d=broker.authorize(app,label,&session,"chatgpt",json!({"from":0,"to":source.encode_utf16().count()})).await?;
    let reference=CredentialRef{service:format!("{}.mcp",app.config().identifier),account:format!("chatgpt-{}",random_token()?)};
    let instance=random_token()?;
    let descriptor=BrokerDescriptor{uri:format!("http://127.0.0.1:{port}/mcp"),client:"chatgpt".into(),generation:1,instance:instance.clone(),credential_ref:reference.clone()};
    let payload=BoundCredential{token,uri:descriptor.uri.clone(),instance,generation:1,external_secret:None};
    let r=reference.clone();
    tauri::async_runtime::spawn_blocking(move||OsKeyring.set(&r,&serde_json::to_string(&payload).unwrap())).await.map_err(|_|"test keyring")??;
    let outcome:Result<(),String>=async {
        let descriptor_path=directory.join("chatgpt.json");
        std::fs::write(&descriptor_path,serde_json::to_vec(&descriptor).unwrap()).map_err(|_|"test descriptor")?;
        std::fs::write(&profile_path,serde_json::to_vec(&json!({"descriptor":descriptor_path,"binding":{"document_id":d.document_id,"session_id":d.session_id,"authorization_epoch":d.authorization_epoch},"evidence":evidence})).unwrap()).map_err(|_|"test profile")?;
        let spec=TunnelLaunchSpec{executable:std::env::current_exe().map_err(|_|"test executable")?,profile:profile_path,generation:1,health_file:None,synthetic:true};
        let status=broker.inner.tunnel.lock().unwrap().start(&spec,"synthetic-tunnel-key-sentinel")?;
        for _ in 0..600 {
            if evidence.exists(){break;}
            if !broker.inner.tunnel.lock().unwrap().status().process{return Err("synthetic_connector_exited".into());}
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let proof:Value=serde_json::from_slice(&std::fs::read(&evidence).map_err(|_|"tunnel evidence missing")?).map_err(|_|"tunnel evidence invalid")?;
        ensure(proof["adapter_stdio"]==true&&proof["live_buffer"]==true,"actual sibling adapter read the current authorized buffer")?;
        ensure(broker.inner.tunnel.lock().unwrap().local_ready(1,status.epoch),"only current generation may become locally ready")?;
        ensure(!broker.inner.tunnel.lock().unwrap().status().host_verified,"local ready never proves the remote host")?;
        ensure(std::fs::read(&formal).ok()==before,"transient tracer does not persist formal profiles")?;
        Ok(())
    }.await;
    let stopped=broker.inner.tunnel.lock().unwrap().stop();
    let _=tauri::async_runtime::spawn_blocking(move||OsKeyring.delete(&reference)).await;
    outcome?;stopped?;Ok(())
}

async fn connections_ui(app:&tauri::AppHandle,label:&str,broker:&super::mcp::LeafMcpBroker)->Result<(),String>{
    let root=std::path::PathBuf::from(std::env::var("LEAF_MCP_TEST_DIR").unwrap());
    let exe=std::env::current_exe().map_err(|_|"UI executable")?;
    let fixture=root.join("connector-fixture/tunnel-client");
    std::fs::create_dir_all(fixture.parent().unwrap()).map_err(|_|"UI fixture directory")?;
    std::fs::copy(&exe,&fixture).map_err(|_|"UI fixture copy")?;
    #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(&fixture,std::fs::Permissions::from_mode(0o700)).map_err(|_|"UI fixture permissions")?;}
    let outcome:Result<(),String>=async {
        let state=broker.bridge(app,label,"test",json!({"action":"ai-settings-configure","executable":fixture})).await?;
        ensure(state["key_empty"]==true&&state["master"]==true,"actual settings submit clears input and enables master after IPC")?;
        ensure(broker.client_profiles()?.iter().all(|p|p.configured&&p.has_runtime_key==(p.client=="chatgpt")),"actual UI configures three independent native profiles")?;
        ensure(state["state"]=="stopped"&&state["configured_badges"]==3,"saved native Tunnel config does not claim connected")?;
        let cleared=broker.bridge(app,label,"test",json!({"action":"ai-settings-clear"})).await?;
        let profiles=broker.client_profiles()?;
        ensure(!profiles[0].configured&&profiles[1].configured&&profiles[2].configured,"actual UI clear keeps other native clients")?;
        ensure(cleared["focus"]=="aiClient"&&cleared["key_empty"]==true,"actual native confirmation restores usable focus and no secret")?;
        Ok(())
    }.await;
    for client in ["chatgpt","claude-desktop","workbuddy"] {let _=broker.revoke_client(app,client,true,&format!("ui-cleanup-{client}")).await;}
    let _=broker.set_enabled(app,false).await;
    outcome
}

async fn tunnel_lifecycle(app:&tauri::AppHandle,label:&str,broker:&super::mcp::LeafMcpBroker)->Result<(),String>{
    use rmcp::{ServiceExt,transport::{StreamableHttpClientTransport,streamable_http_client::StreamableHttpClientTransportConfig}};
    use super::mcp::ai_credentials::{OsKeyring,random_token};
    let root=std::path::PathBuf::from(std::env::var("LEAF_MCP_TEST_DIR").unwrap());let evidence=root.join("tunnel-evidence.json");
    let source="Synthetic live Tunnel buffer";let exe=std::env::current_exe().map_err(|_|"Dev executable")?;
    ensure(exe.to_string_lossy().contains(".cache/Leaf Dev.app/Contents/MacOS/leaf"),"actual lifecycle must launch from staged Leaf Dev bundle")?;
    let helper=exe.parent().unwrap().join("leaf-mcp-adapter");let fixture=root.join("connector-fixture/tunnel-client");
    std::fs::create_dir_all(fixture.parent().unwrap()).map_err(|_|"fixture directory")?;std::fs::copy(&exe,&fixture).map_err(|_|"fixture copy")?;
    #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(&fixture,std::fs::Permissions::from_mode(0o700)).map_err(|_|"fixture permissions")?;}
    let b=broker.configure_client(app,"workbuddy","local-synthetic".into(),"buddy-config",0).await?;broker.enable_client("workbuddy","buddy-enable",b.generation).await?;broker.set_enabled(app,true).await?;
    let buddy=broker.inner.profiles.lock().unwrap().as_ref().unwrap().status("workbuddy")?;
    let generation=||broker.inner.profiles.lock().unwrap().as_ref().unwrap().status("chatgpt").map(|p|p.generation);
    let first=broker.configure_tunnel(app,format!("tunnel_{}","a".repeat(32)),fixture.clone(),"synthetic-tunnel-key-sentinel".into(),"tunnel-config".into(),generation()?).await?;
    ensure(first["profile"]["has_runtime_key"]==true&&first["runtime"]["saved_config"]==true&&first["runtime"]["process"]==false,"saved configuration is distinct from a running connector")?;
    let runtime_ref=broker.inner.profiles.lock().unwrap().as_ref().unwrap().status("chatgpt")?.runtime_ref;
    let current=generation()?;broker.enable_client("chatgpt","tunnel-enable",current).await?;
    let reset=broker.bridge(app,label,"test",json!({"action":"reset","content":source})).await?;
    let session=broker.window_binding(label).ok_or("test document")?.session_id;
    let d=broker.authorize(app,label,&session,"chatgpt",json!({"from":0,"to":source.encode_utf16().count()})).await?;
    let binding=json!({"document_id":d.document_id,"session_id":d.session_id,"authorization_epoch":d.authorization_epoch});
    write_tunnel_input(&root,&helper,&binding,"normal")?;
    let started=broker.start_tunnel(app).await?;let proof=wait_tunnel_proof(broker,&evidence,true).await?;
    ensure(broker.start_tunnel(app).await?["runtime"]["epoch"]==started["runtime"]["epoch"],"repeated native start owns the same connector")?;
    let trace:Value=serde_json::from_slice(&std::fs::read(root.join("adapter-env.json")).map_err(|_|"adapter environment trace")?).map_err(|_|"adapter environment trace")?;
    ensure(trace["has_runtime_key"]==false,"actual helper environment excludes the runtime key")?;
    let acl:Value=serde_json::from_slice(&std::fs::read(root.join("acl-runtime-effective.json")).map_err(|_|"runtime ACL evidence")?).map_err(|_|"runtime ACL evidence")?;
    ensure(acl.as_array().is_some_and(|rows|rows.iter().any(|r|r["trusted_apps"]==1))&&!acl.as_array().unwrap().iter().any(|r|r["trusted_apps"]==2),"actual runtime entry trusts only the GUI")?;
    let descriptor:super::mcp::ai_credentials::BrokerDescriptor=serde_json::from_slice(&std::fs::read(super::application_data(app).unwrap().join("mcp/chatgpt.json")).unwrap()).unwrap();
    let token=broker.inner.profiles.lock().unwrap().as_ref().unwrap().token("chatgpt",&OsKeyring)?;
    let client=().serve(StreamableHttpClientTransport::from_config(StreamableHttpClientTransportConfig::with_uri(descriptor.uri).auth_header(token).reinit_on_expired_session(false))).await.map_err(|_|"lifecycle MCP")?;
    let mut begin=binding.clone();begin["request_id"]=json!("tunnel-task");begin["revision"]=reset["revision"].clone();let task=tool(&client,"begin_edit",begin).await?;
    let mut batch=binding.clone();batch["task_id"]=task["task_id"].clone();batch["request_id"]=json!("tunnel-batch");batch["revision"]=reset["revision"].clone();batch["changes"]=json!([{"from":source.encode_utf16().count(),"to":source.encode_utf16().count(),"expected":"","insert":" revised"}]);tool(&client,"apply_edit_batch",batch).await?;
    let retained=broker.bridge(app,label,"snapshot",json!({})).await?;
    broker.stop_tunnel(app).await?;ensure_tree_stopped(&proof).await?;
    ensure(broker.bridge(app,label,"snapshot",json!({})).await?["content"]==retained["content"]&&!broker.window_locked(label),"native stop preserves applied draft and releases the task immediately")?;
    ensure(tool(&client,"read_document",binding).await.is_err(),"stop retires old authorization")?;let _=client.cancel().await;
    let undo=broker.bridge(app,label,"test",json!({"action":"undo"})).await?;ensure(undo["content"]==source,"stopped Tunnel task remains one undo")?;
    let _=broker.bridge(app,label,"test",json!({"action":"redo"})).await?;
    let root_ref=&root;let helper_ref=&helper;let evidence_ref=&evidence;
    let start_fixture=|mode:String|async move {
        let g=generation()?;broker.enable_client("chatgpt",&format!("enable-{}",random_token()?),g).await?;
        broker.bridge(app,label,"test",json!({"action":"reset","content":source})).await?;
        let session=broker.window_binding(label).unwrap().session_id;
        let d=broker.authorize(app,label,&session,"chatgpt",json!({"from":0,"to":source.encode_utf16().count()})).await?;
        write_tunnel_input(root_ref,helper_ref,&json!({"document_id":d.document_id,"session_id":d.session_id,"authorization_epoch":d.authorization_epoch}),&mode)?;
        let _=std::fs::remove_file(evidence_ref);broker.start_tunnel(app).await?;Ok::<(),String>(())
    };
    start_fixture("normal".into()).await?;let old=wait_tunnel_proof(broker,&evidence,true).await?;
    broker.configure_tunnel(app,format!("tunnel_{}","b".repeat(32)),fixture.clone(),String::new(),"replace-blank".into(),generation()?).await?;ensure_tree_stopped(&old).await?;
    ensure(broker.inner.profiles.lock().unwrap().as_ref().unwrap().status("chatgpt")?.runtime_ref==runtime_ref,"blank reconfiguration retains the GUI-only key entry")?;
    start_fixture("hang-start".into()).await?;
    broker.inner.tunnel.lock().unwrap().expire_start_for_test();
    for _ in 0..200{if !broker.tunnel_status()?["runtime"]["process"].as_bool().unwrap_or(false){break;}tokio::time::sleep(std::time::Duration::from_millis(100)).await;}
    ensure(broker.tunnel_status()?["runtime"]["last_error"]=="tunnel_start_timeout","actual startup is bounded")?;
    start_fixture("crash-root".into()).await?;let crashed=wait_tunnel_proof(broker,&evidence,false).await?;
    for _ in 0..100{if broker.tunnel_status()?["runtime"]["process"]==false{break;}tokio::time::sleep(std::time::Duration::from_millis(50)).await;}
    ensure_tree_stopped(&crashed).await?;ensure(broker.tunnel_status()?["runtime"]["local_ready"]==false,"parent crash cannot leave local ready")?;
    start_fixture("normal".into()).await?;let cleared=wait_tunnel_proof(broker,&evidence,true).await?;
    broker.revoke_client(app,"chatgpt",true,"tunnel-clear").await?;ensure_tree_stopped(&cleared).await?;
    ensure(broker.tunnel_status()?["profile"]["has_runtime_key"]==false&&broker.tunnel_status()?["runtime"]["saved_config"]==false,"clear removes only ChatGPT configuration")?;
    ensure(broker.inner.profiles.lock().unwrap().as_ref().unwrap().status("workbuddy")?==buddy,"ChatGPT lifecycle leaves another client's profile unchanged")?;
    broker.configure_tunnel(app,format!("tunnel_{}","c".repeat(32)),fixture.clone(),"synthetic-tunnel-key-sentinel".into(),"configure-again".into(),generation()?).await?;
    start_fixture("normal".into()).await?;let disabled=wait_tunnel_proof(broker,&evidence,true).await?;broker.set_enabled(app,false).await?;ensure_tree_stopped(&disabled).await?;
    broker.set_enabled(app,true).await?;start_fixture("normal".into()).await?;let exit_tree=wait_tunnel_proof(broker,&evidence,true).await?;
    std::fs::write(root.join("app-exit-tree.json"),serde_json::to_vec(&exit_tree).unwrap()).map_err(|_|"app exit evidence")?;
    std::fs::write(root.join("lifecycle-status.json"),serde_json::to_vec(&broker.tunnel_status()?).unwrap()).map_err(|_|"masked status")?;
    // Test-only OS entries are deleted before exiting; the running owned tree
    // is intentionally left for production RunEvent::Exit cleanup to prove.
    tauri::async_runtime::spawn_blocking({let b=broker.clone();move||{let mut guard=b.inner.profiles.lock().unwrap();let store=guard.as_mut().unwrap();store.clear_runtime(&super::mcp::ai_credentials::GuiRuntimeSecretStore)?;for c in ["chatgpt","workbuddy"]{store.revoke(c,true,&format!("test-cleanup-{c}"),&OsKeyring)?;}Ok::<(),String>(())}}).await.map_err(|_|"test credential cleanup")??;
    Ok(())
}
fn write_tunnel_input(root:&std::path::Path,helper:&std::path::Path,binding:&Value,mode:&str)->Result<(),String>{
    let descriptor=root.join("app-data/mcp/chatgpt.json");
    std::fs::write(root.join("fixture-input.json"),serde_json::to_vec(&json!({"helper":helper,"descriptor":descriptor,"binding":binding,"mode":mode,"adapter_env":root.join("adapter-env.json"),"adapter_trace":root.join("adapter-startup.trace"),"evidence":root.join("tunnel-evidence.json")})).unwrap()).map_err(|_|"fixture input".into())
}
async fn wait_tunnel_proof(broker:&super::mcp::LeafMcpBroker,path:&std::path::Path,ready:bool)->Result<Value,String>{
    for _ in 0..950 {
        if let Ok(bytes)=std::fs::read(path){if let Ok(proof)=serde_json::from_slice::<Value>(&bytes){if !ready||broker.tunnel_status()?["runtime"]["local_ready"]==true {ensure(proof["live_buffer"]==true&&proof["host_verified"]==false,"actual adapter buffer proof remains local-only")?;return Ok(proof);}}}
        let status=broker.tunnel_status()?;if status["runtime"]["process"]==false{let root=path.parent().unwrap();let stage=std::fs::read_to_string(root.join("adapter-startup.trace")).unwrap_or_else(|_|"adapter_not_started".into());return Err(format!("fixture stopped: {}; helper stage: {stage}; buffer proof: {}",status["runtime"]["last_error"].as_str().unwrap_or("none"),path.exists()));}tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }Err("fixture readiness timed out".into())
}
async fn ensure_tree_stopped(proof:&Value)->Result<(),String>{
    for _ in 0..100 {
        let alive=["connector_pid","helper_pid","descendant_pid"].iter().any(|k|proof[*k].as_u64().is_some_and(|pid|std::process::Command::new("/bin/kill").args(["-0",&pid.to_string()]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().is_ok_and(|s|s.success())));
        if !alive{return Ok(());}tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }Err("owned fixture descendant remained alive".into())
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

async fn file_identity_gate(app:&tauri::AppHandle,broker:&super::mcp::LeafMcpBroker,client:&rmcp::service::Peer<rmcp::service::RoleClient>)->Result<(),String>{
    let root=std::path::PathBuf::from(std::env::var("LEAF_MCP_TEST_DIR").unwrap());
    for (index,atomic) in [false,true].into_iter().enumerate() {
        let path=root.join(if atomic{"different.md"}else{"synthetic.md"});
        let initial=std::fs::read_to_string(&path).map_err(|_|"synthetic seed")?;
        let previous=broker.inner.registry.lock().unwrap().documents.values().map(|d|d.label.clone()).collect::<Vec<_>>();
        super::create_document(app.clone(),Some(path.to_string_lossy().into()),None,None)?;
        let label=wait_document(app,broker,&previous).await?;
        let registered=broker.window_binding(&label).ok_or("saved registration")?;
        let original_identity=registered.logical_identity.clone();
        ensure(original_identity.starts_with("file:"),"production registry binds actual anchor identity")?;
        ensure(broker.register_window(app,&label).session_id==registered.session_id,"registration is stable")?;
        let snapshot=broker.bridge(app,&label,"snapshot",json!({})).await?;
        ensure(snapshot["content"]==initial,"production initial path loads actual disk")?;
        let d=broker.authorize(app,&label,&registered.session_id,"synthetic-client",json!({"from":0,"to":initial.encode_utf16().count()})).await?;
        let binding=json!({"document_id":d.document_id,"session_id":d.session_id,"authorization_epoch":d.authorization_epoch});
        let mut begin=binding.clone();begin["revision"]=snapshot["revision"].clone();begin["request_id"]=json!(format!("file-begin-{index}"));
        let task=tool(client,"begin_edit",begin).await?;
        let mut batch=binding.clone();batch["task_id"]=task["task_id"].clone();batch["request_id"]=json!(format!("file-first-{index}"));batch["revision"]=snapshot["revision"].clone();batch["changes"]=json!([{"from":0,"to":9,"expected":&initial[..9],"insert":"Assisted!"}]);
        let first=tool(client,"apply_edit_batch",batch.clone()).await?;
        ensure(first["bufferResult"]["state"]=="applied"&&first["diskResult"]["state"]=="pending","buffer receipt does not claim disk success")?;
        let mut revision=first["applied_revision"].clone();
        if !atomic {
            batch["request_id"]=json!("file-second");batch["revision"]=revision;batch["changes"]=json!([{"from":10,"to":15,"expected":"saved","insert":"draft"}]);
            let second=tool(client,"apply_edit_batch",batch.clone()).await?;revision=second["applied_revision"].clone();
            let saved=broker.bridge(app,&label,"test",json!({"action":"save"})).await?;
            ensure(saved["saved"]==true,"real renderer save IPC succeeds")?;
            ensure(std::fs::read_to_string(&path).map_err(|_|"saved disk read")?=="Assisted! draft draft","actual native disk matches saved snapshot")?;
            let mut query=binding.clone();query["request_id"]=json!("file-first-0");let old=tool(client,"reconcile_request",query.clone()).await?;
            ensure(old["diskResult"]["state"]=="superseded"&&old["bufferResult"]["revision"]==first["applied_revision"],"later disk revision does not relabel prior exact buffer")?;
            query["request_id"]=json!("file-second");ensure(tool(client,"reconcile_request",query).await?["diskResult"]["state"]=="saved","actual tool observes native save ledger")?;
            let current=broker.window_binding(&label).unwrap();
            ensure(current.document_id==registered.document_id && current.session_id==registered.session_id && current.logical_identity!=original_identity,"own atomic save updates anchor alias while keeping logical session")?;
            let alias=root.join("saved-alias.md");std::fs::hard_link(&path,&alias).map_err(|_|"synthetic alias")?;
            let count=app.state::<super::Documents>().0.lock().unwrap().len();
            super::create_document(app.clone(),Some(alias.to_string_lossy().into()),None,None)?;
            ensure(app.state::<super::Documents>().0.lock().unwrap().len()==count,"saved anchor alias focuses existing window")?;
            batch["request_id"]=json!("file-third");batch["revision"]=revision;batch["changes"]=json!([{"from":0,"to":9,"expected":"Assisted!","insert":"AI draft!"}]);
            revision=tool(client,"apply_edit_batch",batch.clone()).await?["applied_revision"].clone();
        }
        broker.bridge(app,&label,"test",json!({"action":"pause-auto-timer"})).await?;
        let before=broker.bridge(app,&label,"snapshot",json!({})).await?;
        let before_identity=broker.window_binding(&label).unwrap().logical_identity;
        let external=if atomic{"External replacement draft"}else{"External in-place draft"};
        if atomic {let replacement=root.join("external-replacement.md");std::fs::write(&replacement,external).map_err(|_|"replacement seed")?;std::fs::rename(replacement,&path).map_err(|_|"external atomic replacement")?;}else{std::fs::write(&path,external).map_err(|_|"external in-place write")?;}
        // Observe the application's real three-second file watcher, not a
        // mocked event or forced read in this driver.
        for _ in 0..100 {
            let state=broker.bridge(app,&label,"test",json!({"action":"session-state"})).await?;
            if broker.window_binding(&label).is_some_and(|d|d.task.is_none()) && state["aiEditResult"]["diskResult"]["state"]=="conflict" {break;}
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        ensure(!broker.window_locked(&label),"actual watcher stops and unlocks task")?;
        let state=broker.bridge(app,&label,"test",json!({"action":"session-state"})).await?;
        ensure(state["paused"]==true,"actual watcher pauses autosave")?;
        ensure(state["aiEditResult"]["checkpoint"]["state"]=="protected","wait for completed recovery boundary after capability invalidation")?;
        ensure(broker.window_binding(&label).unwrap().logical_identity==before_identity,"external replacement must never impersonate an own-save anchor rebind")?;
        ensure(broker.bridge(app,&label,"snapshot",json!({})).await?==before,"watcher preserves applied buffer and revision")?;
        ensure(std::fs::read_to_string(&path).map_err(|_|"external disk read")?==external,"external disk remains untouched")?;
        let mut restart=binding.clone();restart["request_id"]=json!(format!("conflict-restart-{index}"));restart["revision"]=before["revision"].clone();
        ensure(tool(client,"begin_edit",restart).await.is_err(),"unresolved conflict cannot acquire a new AI write capability")?;
        let canonical_path=app.state::<super::Documents>().0.lock().unwrap().get(&label).cloned().flatten().ok_or("actual saved path absent")?;
        let protected=super::recovery_store(app)?.read(&super::recovery::file_key(&canonical_path))?;
        ensure(protected.versions.iter().any(|v|v.content==before["content"].as_str().unwrap()),"actual local recovery protects AI draft")?;
        batch["request_id"]=json!(format!("file-late-{index}"));batch["revision"]=revision;batch["changes"]=json!([]);
        ensure(tool(client,"apply_edit_batch",batch.clone()).await.is_err(),"late task mutation is refused")?;
        let undone=broker.bridge(app,&label,"test",json!({"action":"undo"})).await?;ensure(undone["content"]==initial,"conflicted task remains one whole undo")?;
        ensure(broker.bridge(app,&label,"test",json!({"action":"redo"})).await?["content"]==before["content"],"whole redo preserves applied task")?;
        let destroyed=app.get_webview_window(&label).unwrap();destroyed.destroy().map_err(|_|"test close")?;
        for _ in 0..100 {if broker.window_binding(&label).is_none(){break;}tokio::time::sleep(std::time::Duration::from_millis(30)).await;}
        let previous=broker.inner.registry.lock().unwrap().documents.values().map(|d|d.label.clone()).collect::<Vec<_>>();
        super::create_document(app.clone(),Some(path.to_string_lossy().into()),None,None)?;
        let reopened=wait_document(app,broker,&previous).await?;
        ensure(broker.window_binding(&reopened).unwrap().session_id!=d.session_id,"actual close/reopen retires session")?;
        ensure(tool(client,"apply_edit_batch",batch).await.is_err(),"old session cannot target reopened file")?;
        ensure(broker.bridge(app,&reopened,"snapshot",json!({})).await?["content"]==external,"reopen reads surviving external disk")?;
    }
    file_transition_gate(app,broker,client,&root).await?;
    Ok(())
}

async fn file_transition_gate(app:&tauri::AppHandle,broker:&super::mcp::LeafMcpBroker,client:&rmcp::service::Peer<rmcp::service::RoleClient>,root:&std::path::Path)->Result<(),String>{
    for action in ["save-as","rename","relocate","external-rename","save-failure"] {
        let source=root.join(format!("{action}-source.md"));let target=root.join(format!("{action}-target.md"));
        let initial="Synthetic saved draft";std::fs::write(&source,initial).map_err(|_|"transition seed")?;
        let previous=broker.inner.registry.lock().unwrap().documents.values().map(|d|d.label.clone()).collect::<Vec<_>>();
        super::create_document(app.clone(),Some(source.to_string_lossy().into()),None,None)?;
        let label=wait_document(app,broker,&previous).await?;let window=app.get_webview_window(&label).unwrap();
        let d=broker.window_binding(&label).unwrap();let d=broker.authorize(app,&label,&d.session_id,"synthetic-client",json!({"from":0,"to":initial.len()})).await?;
        let binding=json!({"document_id":d.document_id,"session_id":d.session_id,"authorization_epoch":d.authorization_epoch});
        let before=broker.bridge(app,&label,"snapshot",json!({})).await?;
        let mut begin=binding.clone();begin["revision"]=before["revision"].clone();begin["request_id"]=json!(format!("transition-{action}"));let task=tool(client,"begin_edit",begin).await?;
        let mut batch=binding.clone();batch["task_id"]=task["task_id"].clone();batch["revision"]=before["revision"].clone();batch["request_id"]=json!(format!("transition-batch-{action}"));batch["changes"]=json!([{"from":0,"to":9,"expected":"Synthetic","insert":"Assisted!"}]);
        let receipt=tool(client,"apply_edit_batch",batch.clone()).await?;
        broker.bridge(app,&label,"test",json!({"action":"pause-auto-timer"})).await?;
        let applied=broker.bridge(app,&label,"snapshot",json!({})).await?;
        if action=="save-as" {
            let save_binding=json!({"document_id":d.document_id,"session_id":d.session_id,"revision":receipt["applied_revision"]});
            super::write_document(app.clone(),window.clone(),app.state::<super::Documents>(),app.state::<super::DocumentAnchors>(),app.state::<super::RecoveryState>(),target.to_string_lossy().into(),"Assisted! saved draft".into(),None,vec![],Some(save_binding)).await?;
            ensure(std::fs::read_to_string(&source).unwrap()==initial,"save-as leaves original disk unchanged")?;
        }else if action=="rename" {
            let canonical=app.state::<super::Documents>().0.lock().unwrap().get(&label).cloned().flatten().ok_or("rename source absent")?;
            super::rename_document(app.clone(),window.clone(),app.state::<super::Documents>(),app.state::<super::DocumentAnchors>(),app.state::<super::RecoveryState>(),canonical.to_string_lossy().into(),"rename-target.md".into(),initial.into(),"Assisted! saved draft".into()).await?;
        }else if action=="relocate" {
            std::fs::write(&target,initial).map_err(|_|"relocation seed")?;
            super::relocate_document(app.clone(),window.clone(),app.state::<super::Documents>(),app.state::<super::DocumentAnchors>(),app.state::<super::RecoveryState>(),target.to_string_lossy().into(),initial.into(),vec![]).await?;
            ensure(std::fs::read_to_string(&target).unwrap()==initial,"relocation never overwrites chosen disk")?;
        }else if action=="external-rename" {
            std::fs::rename(&source,&target).map_err(|_|"external rename")?;
            super::observe_document(app.clone(),window.clone(),app.state::<super::Documents>(),app.state::<super::DocumentAnchors>(),app.state::<super::RecoveryState>(),vec![]).await?;
        }else {
            let permissions=std::fs::metadata(&source).unwrap().permissions();let mut readonly=permissions.clone();readonly.set_readonly(true);std::fs::set_permissions(&source,readonly).map_err(|_|"readonly fixture")?;
            let save=broker.bridge(app,&label,"test",json!({"action":"save"})).await?;
            std::fs::set_permissions(&source,permissions).map_err(|_|"restore synthetic permission")?;
            ensure(save["saved"]==false,"real save IPC reports injected readonly failure")?;
            let mut query=binding.clone();query["request_id"]=batch["request_id"].clone();let result=tool(client,"reconcile_request",query).await?;
            ensure(result["bufferResult"]["revision"]==receipt["applied_revision"] && result["diskResult"]["state"]=="failed" && result["checkpoint"]["state"]=="protected","real failure preserves applied receipt and recovery proof")?;
            ensure(std::fs::read_to_string(&source).unwrap()==initial,"save failure cannot overwrite original disk")?;
            let canonical=app.state::<super::Documents>().0.lock().unwrap().get(&label).cloned().flatten().unwrap();let record=super::recovery_store(app)?.read(&super::recovery::file_key(&canonical))?;
            ensure(record.draft.iter().chain(record.versions.iter()).any(|v|v.content=="Assisted! saved draft"),"failed real save retains local draft")?;
        }
        ensure(!broker.window_locked(&label),"identity change or failed save finalizes before returning")?;
        ensure(broker.bridge(app,&label,"snapshot",json!({})).await?==applied,"identity boundary preserves applied buffer")?;
        batch["request_id"]=json!(format!("late-transition-{action}"));batch["revision"]=receipt["applied_revision"].clone();batch["changes"]=json!([]);
        ensure(tool(client,"apply_edit_batch",batch).await.is_err(),"identity boundary invalidates late task")?;
        ensure(broker.bridge(app,&label,"test",json!({"action":"undo"})).await?["content"]==initial,"identity boundary retains whole undo")?;
        window.destroy().map_err(|_|"transition cleanup")?;
    }Ok(())
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
            let saved=super::write_document(app.clone(),app.get_webview_window(label).unwrap(),app.state::<super::Documents>(),app.state::<super::DocumentAnchors>(),app.state::<super::RecoveryState>(),path.to_string_lossy().into_owned(),final_text.into(),None,vec![],None).await;
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
