//! Test driver exists only in explicitly isolated native-smoke builds.
use tauri::{Manager, Emitter};
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
    config.app.windows[0].url=tauri::WebviewUrl::App("index.html?document=1".into());
    #[cfg(target_os="macos")]
    { config.app.windows[0].data_store_identifier=Some(digest[..16].try_into().unwrap()); }
}

#[tauri::command]
pub fn mcp_test_mode(app: tauri::AppHandle) -> Option<String> {
    enabled(&app).then(|| std::env::var("LEAF_MCP_TEST_MODE").unwrap_or_default())
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
    let window=app.get_webview_window("main").ok_or("native test window absent")?;
    // A real unsaved document window uses the production Documents registry.
    app.state::<super::Documents>().0.lock().unwrap().insert("main".into(),None);
    window.show().map_err(|_|"native test window show")?;
    let _=window.emit("leaf-mcp-test",json!({"ready":true}));
    Ok(())
}
