#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{collections::HashMap, fs, io::Write, path::PathBuf, sync::{Mutex, atomic::{AtomicUsize, Ordering}}};
use tauri::{Emitter, Manager};
#[cfg(target_os = "macos")]
mod native_print;
#[cfg(target_os = "macos")]
mod native_shortcuts;
#[cfg(target_os = "macos")]
mod native_title;
mod recovery;
mod resources;

#[derive(Default)]
struct RecoveryState { gate: Mutex<()>, drafts: Mutex<HashMap<String, String>>, initial: Mutex<HashMap<String, String>> }

#[derive(Default)]
struct Documents(Mutex<HashMap<String, Option<PathBuf>>>);
#[derive(Default)]
struct MenuFocus(Mutex<Option<String>>);
#[derive(Default)]
struct OpenBuffers(Mutex<HashMap<String,String>>);
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct ExportSnapshot { source: String, name: String, numbered: bool, #[serde(default, skip_deserializing)] base_path: Option<PathBuf> }
#[derive(Default)]
struct Exports(Mutex<HashMap<String, ExportSnapshot>>);
static NEXT_WINDOW: AtomicUsize = AtomicUsize::new(1);
/// The launcher window declared in `tauri.conf.json`. It carries no document of
/// its own: hide it when a document opens, then remove it when the last
/// document closes so the application exits.
const LAUNCHER: &str = "main";

// Wry supplies its own WebView2 options, so an environment-only CDP flag
// is not sufficient on every runtime. This hook is absent from normal builds.
#[cfg(all(target_os = "windows", feature = "native-smoke"))]
fn native_smoke_browser_args() -> String {
    let port: u16 = std::env::var("LEAF_NATIVE_SMOKE_PORT").expect("native smoke port").parse().expect("valid native smoke port");
    format!("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}")
}

// Pending document creation is included in Documents, so closing a window
// must not terminate another document that is still opening.
fn close_auxiliary_windows(closing: &str, remaining_documents: usize) -> bool {
    closing.starts_with("document-") && remaining_documents == 0
}

#[cfg(test)]
mod window_close_tests {
    use super::close_auxiliary_windows;
    #[test]
    fn closing_last_document_removes_launcher_and_previews() {
        assert!(close_auxiliary_windows("document-1", 0));
    }
    #[test]
    fn another_open_or_pending_document_keeps_application_alive() {
        assert!(!close_auxiliary_windows("document-1", 1));
        assert!(!close_auxiliary_windows("document-1", 2));
    }
    #[test]
    fn closing_auxiliary_windows_does_not_close_documents() {
        assert!(!close_auxiliary_windows("main", 0));
        assert!(!close_auxiliary_windows("export-1", 0));
        assert!(!close_auxiliary_windows("export-1", 1));
    }
}

fn hide_launcher(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(launcher) = app.get_webview_window(LAUNCHER) {
        launcher.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn document_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows().into_values().find(|window| window.label().starts_with("document-"))
}

fn menu_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| {
            // AppKit may momentarily clear the key window while dispatching a
            // menu accelerator. Retain its last recipient instead of dropping
            // the command or sending it to an arbitrary document/launcher.
            let label = app.state::<MenuFocus>().0.lock().unwrap().clone()?;
            app.get_webview_window(&label).filter(|w| w.is_visible().unwrap_or(false))
        })
}

#[cfg(target_os = "windows")]
fn open_windows_arguments(app: &tauri::AppHandle, args: Vec<String>, cwd: &str) {
    use tauri_plugin_dialog::DialogExt;
    let paths = document_arguments(args, std::path::Path::new(cwd));
    if paths.is_empty() {
        if let Some(window) = app.webview_windows().values().next() {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
    // Ready and single-instance callbacks run on the event loop. Command
    // attributes do not affect direct Rust calls, so dispatch explicitly.
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        for path in paths {
            if let Err(error) = open_document(app.clone(), Some(path.to_string_lossy().into_owned())) {
                app.dialog().message(error).title("Leaf").show(|_| {});
            }
        }
    });
}

#[cfg(any(target_os = "windows", test))]
fn document_arguments(args: Vec<String>, cwd: &std::path::Path) -> Vec<PathBuf> {
    args.into_iter().skip(1).filter_map(|arg| {
        let path = PathBuf::from(arg);
        let extension = path.extension()?.to_str()?.to_ascii_lowercase();
        if !matches!(extension.as_str(), "md" | "markdown" | "mdown") { return None; }
        Some(if path.is_absolute() { path } else { cwd.join(path) })
    }).collect()
}

#[tauri::command(async)]
fn open_export(app: tauri::AppHandle, window: tauri::WebviewWindow, mut snapshot: ExportSnapshot) -> Result<(), String> {
    snapshot.base_path = app.state::<Documents>().0.lock().unwrap().get(window.label()).cloned().flatten();
    let label = format!("export-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    app.state::<Exports>().0.lock().unwrap().insert(label.clone(), snapshot);
    let builder = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html?export=1".into()))
        .title("导出 PDF — Leaf").inner_size(950., 800.).min_inner_size(720., 480.);
    #[cfg(all(target_os = "windows", feature = "native-smoke"))]
    let builder = builder.additional_browser_args(&native_smoke_browser_args());
    let result = builder.build();
    if let Err(error) = result {
        app.state::<Exports>().0.lock().unwrap().remove(&label);
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
fn export_snapshot(window: tauri::WebviewWindow, exports: tauri::State<Exports>) -> Result<ExportSnapshot, String> {
    exports.0.lock().unwrap().get(window.label()).cloned().ok_or("导出快照不存在".into())
}

fn resource_document(app: &tauri::AppHandle, label: &str) -> Result<PathBuf, String> {
    app.state::<Documents>().0.lock().unwrap().get(label).cloned().flatten()
        .or_else(|| app.state::<Exports>().0.lock().unwrap().get(label).and_then(|s| s.base_path.clone()))
        .ok_or("请先保存文档，以确定资源目录".into())
}
// Every command below that touches the filesystem is `(async)`: Tauri runs a
// command on the UI thread unless told otherwise, and one slow read or write
// there freezes the whole window -- a document kept in iCloud Drive goes
// through the file provider, where an ordinary read, fsync or rename can wait
// on the network. Off-thread, a slow operation delays only its own reply.
// Window-building commands also run off the UI thread: synchronous command
// handlers deadlock WebView2 on Windows. Tauri dispatches native UI work itself.
#[tauri::command(async)]
fn import_attachment(app: tauri::AppHandle, window: tauri::WebviewWindow, name: String, data: Option<Vec<u8>>, source: Option<String>) -> Result<String, String> {
    if !window.label().starts_with("document-") { return Err("请先打开或新建文档".into()); }
    let doc = resource_document(&app, window.label())?;
    let data = match (data, source) { (Some(data), None) => data, (None, Some(path)) => resources::bytes(std::path::Path::new(&path))?, _ => return Err("附件来源无效".into()) };
    resources::import_managed(&doc, &name, &data, Some(&app.path().app_data_dir().map_err(|e| e.to_string())?.join("removed-images-v1")))
}
// Shows the attachment in the file manager instead of opening it: a picture the
// webview cannot decode is still a real file the reader may want to find.
#[tauri::command(async)]
fn reveal_resource(app: tauri::AppHandle, window: tauri::WebviewWindow, relative: String) -> Result<(), String> {
    let doc = resource_document(&app, window.label())?;
    let path = resources::resolve(&doc, &relative)?;
    if !path.exists() { return Err("文件已不在原位置".into()); }
    #[cfg(target_os = "macos")]
    { std::process::Command::new("open").arg("-R").arg(&path).spawn().map_err(|e| e.to_string())?; }
    #[cfg(target_os = "windows")]
    {
        // Quoting the path keeps spaces in folder names from splitting the argument.
        std::process::Command::new("explorer").arg(format!("/select,\"{}\"", path.to_string_lossy())).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { return Err("当前平台不支持在文件管理器中显示".into()); }
    Ok(())
}
#[tauri::command(async)]
fn read_resource(app: tauri::AppHandle, window: tauri::WebviewWindow, relative: String) -> Result<Vec<u8>, String> {
    let doc = resource_document(&app, window.label())?;
    resources::restore(&app.path().app_data_dir().map_err(|e| e.to_string())?.join("removed-images-v1"), &doc, &relative)?;
    resources::bytes(&resources::resolve(&doc, &relative)?)
}
#[tauri::command(async)]
fn open_link(app: tauri::AppHandle, window: tauri::WebviewWindow, target: String) -> Result<(), String> {
    let lower = target.to_ascii_lowercase();
    let external = lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:");
    let destination = if external {
        if target.chars().any(|c| c.is_control()) { return Err("链接无效".into()); }
        target
    } else {
        let doc = resource_document(&app, window.label())?;
        let path = resources::resolve(&doc, &target)?;
        let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
        if matches!(ext.as_str(), "md" | "markdown" | "mdown") { return open_document(app, Some(path.to_string_lossy().into_owned())); }
        if !matches!(ext.as_str(), "pdf" | "txt" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "heif" | "svg") { return Err("此附件类型请在文件管理器中打开".into()); }
        path.to_string_lossy().into_owned()
    };
    #[cfg(target_os = "macos")]
    { std::process::Command::new("open").arg(&destination).spawn().map_err(|e| e.to_string())?; }
    #[cfg(target_os = "windows")]
    {
        // ShellExecute avoids shell command interpolation entirely.
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "shell32")] unsafe extern "system" { fn ShellExecuteW(hwnd: *mut std::ffi::c_void, op: *const u16, file: *const u16, params: *const u16, dir: *const u16, show: i32) -> isize; }
        let path: Vec<u16> = std::ffi::OsStr::new(&destination).encode_wide().chain(Some(0)).collect();
        let result = unsafe { ShellExecuteW(std::ptr::null_mut(), std::ptr::null(), path.as_ptr(), std::ptr::null(), std::ptr::null(), 1) };
        if result <= 32 { return Err("无法打开链接".into()); }
    }
    Ok(())
}

#[tauri::command]
fn print_export(window: tauri::WebviewWindow) -> Result<(), String> {
    if !window.label().starts_with("export-") { return Err("请先打开 PDF 导出预览".into()); }
    #[cfg(target_os = "macos")]
    return window.with_webview(|platform| unsafe {
        native_print::show(&*(platform.inner() as *const objc2::runtime::AnyObject));
    }).map_err(|e| e.to_string());
    #[cfg(not(target_os = "macos"))]
    window.print().map_err(|e| e.to_string())
}

#[tauri::command]
fn initial_path(window: tauri::WebviewWindow, docs: tauri::State<Documents>) -> Option<String> {
    docs.0.lock().unwrap().get(window.label()).and_then(|p| p.as_ref()).map(|p| p.to_string_lossy().into_owned())
}

// The save dialog already asked about an existing name and the user chose
// Replace. Keep the replaced original recoverable from the system trash
// instead of destroying it outright.
fn discard_replaced_document(path: &std::path::Path) -> Result<(), String> {
    trash::delete(path).map_err(|error| format!("无法把原文件移入废纸篓：{error}"))
}

fn create_empty_document_with(path: &std::path::Path, discard: &dyn Fn(&std::path::Path) -> Result<(), String>) -> Result<(), String> {
    if path.exists() { discard(path)?; }
    // create_new still guards the race where another process recreates the
    // name between the discard above and this open.
    let file = fs::OpenOptions::new().write(true).create_new(true).open(path)
        .map_err(|error| if error.kind() == std::io::ErrorKind::AlreadyExists {
            "同名文件已存在，请换一个名称，或直接打开原文件。".to_string()
        } else { error.to_string() })?;
    file.sync_all().map_err(|error| error.to_string())
}

fn create_empty_document(path: &std::path::Path) -> Result<(), String> {
    create_empty_document_with(path, &discard_replaced_document)
}

#[tauri::command(async)]
fn new_document(path: String) -> Result<(), String> {
    create_empty_document(std::path::Path::new(&path))
}

#[tauri::command(async)]
fn open_document(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    create_document(app, path, None)
}

fn create_document(app: tauri::AppHandle, path: Option<String>, recovered: Option<String>) -> Result<(), String> {
    let path = path.map(|p| fs::canonicalize(p).map_err(|e| e.to_string())).transpose()?;
    if let Some(ref target) = path {
        let docs = app.state::<Documents>();
        let docs = docs.0.lock().unwrap();
        for (label, existing) in docs.iter() {
            if existing.as_ref() == Some(target) {
                if let Some(window) = app.get_webview_window(label) {
                    window.unminimize().map_err(|e| e.to_string())?;
                    window.set_focus().map_err(|e| e.to_string())?;
                    hide_launcher(&app)?;
                    return Ok(());
                }
            }
        }
    }
    let label = format!("document-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    app.state::<Documents>().0.lock().unwrap().insert(label.clone(), path);
    if let Some(content) = recovered { app.state::<RecoveryState>().initial.lock().unwrap().insert(label.clone(), content); }
    let builder = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html?document=1".into()))
        .title("Leaf").inner_size(1100., 800.).min_inner_size(900., 480.);
    #[cfg(all(target_os = "windows", feature = "native-smoke"))]
    let builder = builder.additional_browser_args(&native_smoke_browser_args());
    let result = builder.build();
    if let Err(error) = result {
        app.state::<Documents>().0.lock().unwrap().remove(&label);
        app.state::<RecoveryState>().initial.lock().unwrap().remove(&label);
        return Err(error.to_string());
    }
    // The launcher has done its job once a document window is on screen. Hide it
    // rather than destroy it: the window keeps its own state, and the ordinary
    // "all windows destroyed" exit path stays untouched, so quitting Leaf still
    // runs through the unsaved-document checks.
    hide_launcher(&app)?;
    Ok(())
}

#[tauri::command(async)]
fn read_document(path: String) -> Result<String, String> { fs::read_to_string(path).map_err(|e| e.to_string()) }

fn recovery_store(app: &tauri::AppHandle) -> Result<recovery::Store, String> {
    Ok(recovery::Store::new(app.path().app_data_dir().map_err(|e| e.to_string())?.join("recovery-v1")))
}
fn recovery_key(window: &tauri::WebviewWindow, docs: &Documents, recovery: &RecoveryState) -> String {
    if let Some(Some(path)) = docs.0.lock().unwrap().get(window.label()) { return recovery::file_key(path); }
    recovery.drafts.lock().unwrap().entry(window.label().into()).or_insert_with(recovery::draft_key).clone()
}
fn retention_days(app: &tauri::AppHandle) -> Result<u32,String> {
    let path=app.path().app_data_dir().map_err(|e|e.to_string())?.join("recovery-retention.json");
    let days:u32=match fs::read(path) {Ok(bytes)=>serde_json::from_slice(&bytes).map_err(|e|format!("恢复时限设置无法读取：{e}"))?,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>30,Err(e)=>return Err(e.to_string())};
    if ![7,30,90].contains(&days){return Err("恢复记录保留时限无效".into());}Ok(days)
}
#[tauri::command(async)]
fn recovery_retention(app:tauri::AppHandle,recovery:tauri::State<RecoveryState>,days:Option<u32>)->Result<u32,String>{
    let _guard=recovery.gate.lock().unwrap();
    if let Some(days)=days {
        if ![7,30,90].contains(&days){return Err("恢复记录保留时限无效".into());}
        let root=app.path().app_data_dir().map_err(|e|e.to_string())?;fs::create_dir_all(&root).map_err(|e|e.to_string())?;
        let mut temp=tempfile::NamedTempFile::new_in(&root).map_err(|e|e.to_string())?;
        temp.write_all(days.to_string().as_bytes()).map_err(|e|e.to_string())?;temp.as_file().sync_all().map_err(|e|e.to_string())?;
        temp.persist(root.join("recovery-retention.json")).map_err(|e|e.to_string())?;
        let _=app.emit("leaf-retention-days",days);
    }
    retention_days(&app)
}
#[tauri::command(async)]
fn recovery_expire(app:tauri::AppHandle,recovery:tauri::State<RecoveryState>,docs:tauri::State<Documents>)->Result<usize,String>{
    let _guard=recovery.gate.lock().unwrap();
    let mut active:Vec<String>=docs.0.lock().unwrap().values().filter_map(|path|path.as_ref().map(|p|recovery::file_key(p))).collect();
    active.extend(recovery.drafts.lock().unwrap().values().cloned());
    let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e|e.to_string())?.as_millis() as u64;
    recovery_store(&app)?.expire(retention_days(&app)?,now,&active)
}
#[tauri::command]
fn recovery_initial(window: tauri::WebviewWindow, recovery: tauri::State<RecoveryState>) -> Option<String> {
    recovery.initial.lock().unwrap().remove(window.label())
}
#[tauri::command(async)]
fn recovery_checkpoint(app: tauri::AppHandle, window: tauri::WebviewWindow, docs: tauri::State<Documents>, recovery: tauri::State<RecoveryState>, content: String, preserve: Option<bool>) -> Result<(), String> {
    if !window.label().starts_with("document-") { return Err("请先打开或新建文档".into()); }
    let _guard = recovery.gate.lock().unwrap();
    let key = recovery_key(&window, &docs, &recovery);
    let source = docs.0.lock().unwrap().get(window.label()).and_then(|p| p.as_ref()).map(|p| p.to_string_lossy().into_owned());
    let owner = recovery.drafts.lock().unwrap().entry(window.label().into()).or_insert_with(recovery::draft_key).clone();
    app.state::<OpenBuffers>().0.lock().unwrap().insert(window.label().into(),content.clone());
    recovery_store(&app)?.checkpoint(&key, source, &content, &owner, preserve.unwrap_or(false))
}
#[tauri::command(async)]
fn recovery_list(app: tauri::AppHandle, window: tauri::WebviewWindow, docs: tauri::State<Documents>, recovery: tauri::State<RecoveryState>, drafts: bool) -> Result<Vec<recovery::Entry>, String> {
    let _guard = recovery.gate.lock().unwrap();
    let store = recovery_store(&app)?;
    let current = recovery_key(&window, &docs, &recovery);
    if !drafts { return store.list(&current); }
    let mut active = vec![];
    for (label, path) in docs.0.lock().unwrap().iter() {
        if label == window.label() { continue; }
        if let Some(path) = path { active.push(recovery::file_key(path)); }
        else if let Some(key) = recovery.drafts.lock().unwrap().get(label) { active.push(key.clone()); }
    }
    Ok(store.drafts()?.into_iter().filter(|entry| !active.contains(&entry.key)).collect())
}
#[tauri::command(async)]
fn recovery_read(app: tauri::AppHandle, recovery: tauri::State<RecoveryState>, key: String, id: String) -> Result<String, String> {
    let _guard = recovery.gate.lock().unwrap();
    recovery_store(&app)?.content(&key, &id)
}
#[tauri::command(async)]
fn recovery_delete(app: tauri::AppHandle, window: tauri::WebviewWindow, docs: tauri::State<Documents>, recovery: tauri::State<RecoveryState>, key: String, id: String) -> Result<(), String> {
    let _guard = recovery.gate.lock().unwrap();
    for (label, path) in docs.0.lock().unwrap().iter() {
        if label == window.label() { continue; }
        let other = path.as_ref().map(|p| recovery::file_key(p)).or_else(|| recovery.drafts.lock().unwrap().get(label).cloned());
        if other.as_ref() == Some(&key) { return Err("该文档正在其他窗口编辑，无法删除。".into()); }
    }
    recovery_store(&app)?.delete_entry(&key, &id)
}
#[tauri::command(async)]
fn recovery_open(app: tauri::AppHandle, recovery: tauri::State<RecoveryState>, key: String, id: String) -> Result<(), String> {
    let content = {
        let _guard = recovery.gate.lock().unwrap();
        recovery_store(&app)?.content(&key, &id)?
    };
    // Orphan drafts always open as a new unsaved document, never bind silently
    // to the old disk path (which may have changed since the crash).
    create_document(app, None, Some(content))
}
#[tauri::command]
fn finish_title_rename(window:tauri::WebviewWindow,error:Option<String>)->Result<(),String>{
    #[cfg(target_os="macos")]
    {let label=window.label().to_owned();window.run_on_main_thread(move||unsafe{native_title::finish_for(&label,error.as_deref())}).map_err(|e|e.to_string())?;}
    Ok(())
}
fn validate_file_name(name: &str) -> Result<(),String> {
    if name.trim().is_empty() || name=="." || name==".." || name.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c)) || name.ends_with([' ','.']) {
        return Err("文件名不能包含路径或特殊符号".into());
    }
    Ok(())
}
fn rename_file(source: &std::path::Path, name: &str, expected: &str) -> Result<PathBuf,String> {
    validate_file_name(name)?;
    let target=source.with_file_name(name);
    if target==source { return Ok(target); }
    if fs::read_to_string(source).map_err(|e|e.to_string())?!=expected { return Err("文件已被其他程序修改，请重新载入后重命名".into()); }
    #[cfg(target_os="macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        unsafe extern "C" { fn renamex_np(from:*const std::ffi::c_char,to:*const std::ffi::c_char,flags:u32)->i32; }
        let from=std::ffi::CString::new(source.as_os_str().as_bytes()).map_err(|e|e.to_string())?;
        let to=std::ffi::CString::new(target.as_os_str().as_bytes()).map_err(|e|e.to_string())?;
        if unsafe{renamex_np(from.as_ptr(),to.as_ptr(),4)}!=0 {return Err(format!("无法重命名（同名文件不会被覆盖）：{}",std::io::Error::last_os_error()));}
    }
    #[cfg(not(target_os="macos"))]
    {
        fs::hard_link(source,&target).map_err(|e|format!("无法重命名（同名文件不会被覆盖）：{e}"))?;
        if let Err(e)=fs::remove_file(source) {let _=fs::remove_file(&target);return Err(e.to_string());}
    }
    Ok(target)
}
#[derive(serde::Serialize)]
struct ResourceWrite { path: String, content: String, mappings: Vec<(String,String)>, warning: Option<String> }
#[tauri::command(async)]
fn rename_document(app:tauri::AppHandle,window:tauri::WebviewWindow,docs:tauri::State<Documents>,recovery:tauri::State<RecoveryState>,path:String,name:String,expected:String,content:String)->Result<ResourceWrite,String>{
    let _guard=recovery.gate.lock().unwrap();
    let mut documents=docs.0.lock().unwrap();
    let source=documents.get(window.label()).cloned().flatten().ok_or("请先保存文档")?;
    if source!=PathBuf::from(path) {return Err("文档路径已变化，请重试".into());}
    validate_file_name(&name)?;
    let target=source.with_file_name(&name);
    if documents.iter().any(|(label,p)|label!=window.label()&&p.as_ref()==Some(&target)){return Err("该文件已在另一窗口打开".into());}
    if target!=source && target.exists(){return Err("同名文件已存在，请换一个名称".into());}
    let store=recovery_store(&app)?;
    store.copy_for_rename(&recovery::file_key(&source),&recovery::file_key(&target),&target.to_string_lossy())?;
    let (_,mappings)=resources::rehome(&source,&target,&format!("{expected}\n{content}"))?;
    let rewritten=resources::rewrite_paths(&expected,&mappings);
    let target=rename_file(&source,&name,&expected)?;
    if rewritten!=expected {
        if let Err(error)=atomic_save(target.to_str().ok_or("文件路径无效")?,&rewritten,Some(expected.clone())) {
            let _=rename_file(&target,source.file_name().and_then(|s|s.to_str()).ok_or("文件名无效")?,&expected);
            return Err(error);
        }
    }
    documents.insert(window.label().into(),Some(target.clone()));
    Ok(ResourceWrite {path:target.to_string_lossy().into_owned(),content:rewritten,mappings,warning:None})
}
#[tauri::command(async)]
fn export_bundle(window:tauri::WebviewWindow,docs:tauri::State<Documents>,directory:String,content:String,resources:Vec<String>)->Result<String,String> {
    let source=docs.0.lock().unwrap().get(window.label()).cloned().flatten().ok_or("请先保存文档")?;
    resources::export_bundle(&source,std::path::Path::new(&directory),&content,&resources).map(|p|p.to_string_lossy().into_owned())
}
#[tauri::command(async)]
fn write_document(app: tauri::AppHandle, window: tauri::WebviewWindow, docs: tauri::State<Documents>, recovery: tauri::State<RecoveryState>, path: String, content: String, expected: Option<String>, resources: Vec<String>) -> Result<ResourceWrite, String> {
    if !window.label().starts_with("document-") { return Err("请先打开或新建文档".into()); }
    let _guard = recovery.gate.lock().unwrap();
    let old_key = recovery_key(&window, &docs, &recovery);
    let target = match fs::canonicalize(&path) {
        Ok(path) => path,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let path = PathBuf::from(&path);
            fs::canonicalize(path.parent().ok_or("无法确定保存目录")?).map_err(|e| e.to_string())?.join(path.file_name().ok_or("无效文件名")?)
        }
        Err(e) => return Err(e.to_string()),
    };
    let mut documents = docs.0.lock().unwrap();
    if documents.iter().any(|(label, p)| label != window.label() && p.as_ref() == Some(&target)) { return Err("目标文件已在另一个 Leaf 窗口打开，请切换窗口或选择其他文件。".into()); }
    let (content,mappings)=if let Some(source)=documents.get(window.label()).and_then(|p|p.as_ref()).filter(|p|*p!=&target) {
        resources::copy_references(source,&target,&resources)?;
        resources::rehome(source,&target,&content)?
    } else { (content,Vec::new()) };
    let target_string = target.to_str().ok_or("文件路径不是有效 UTF-8")?;
    let key = recovery::file_key(&target);
    let store = recovery_store(&app)?;
    // If the local history cannot be protected, do not silently overwrite disk.
    store.before_save(&key, target_string.into(), expected.as_deref())?;
    let image_store = app.path().app_data_dir().map_err(|e| e.to_string())?.join("removed-images-v1");
    resources::restore_references(&image_store, &target, &content)?;
    let mut previous = expected.clone();
    // Seed cleanup from this exact file's retained history, so a removal
    // skipped by an older version can still be completed on the next save.
    if let Ok(record)=store.read(&key) {
        let text=previous.get_or_insert_with(String::new);
        for version in record.versions { text.push('\n'); text.push_str(&version.content); }
    }
    let mut cleanup_warning=None;
    atomic_save(target_string, &content, expected)?;
    let buffers: Vec<String> = app.state::<OpenBuffers>().0.lock().unwrap().iter().filter(|(label,_)| label.as_str()!=window.label()).map(|(_,content)|content.clone()).collect();
    if let Some(before) = previous {
        if let Err(error) = resources::collect_removed_protected(&image_store, &target, &before, &content, &buffers) { cleanup_warning=Some(format!("文档已保存，图片清理未完成：{error}")); }
    }
    documents.insert(window.label().to_owned(), Some(target.clone()));
    // Disk is already saved. A cleanup failure must not be reported as a failed
    // write, since that would leave the editor's comparison baseline stale.
    if let Err(error) = store.saved(&old_key, &content) { eprintln!("Recovery cleanup: {error}"); }
    if key != old_key { if let Err(error) = store.saved(&key, &content) { eprintln!("Recovery cleanup: {error}"); } }
    Ok(ResourceWrite {path:target.to_string_lossy().into_owned(),content,mappings,warning:cleanup_warning})
}

fn atomic_save(path: &str, content: &str, expected: Option<String>) -> Result<(), String> {
    let target = PathBuf::from(&path);
    // Compare immediately before writing; do not overwrite an external edit silently.
    let current = match fs::read_to_string(&target) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    if current != expected { return Err("文件已被其他程序修改，请另存为以保留当前编辑内容。".into()); }
    let parent = target.parent().ok_or("无法确定保存目录")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    if let Ok(meta) = fs::metadata(&target) {
        if meta.permissions().readonly() { return Err("文件为只读，请另存为。".into()); }
        temp.as_file().set_permissions(meta.permissions()).map_err(|e| e.to_string())?;
    }
    temp.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    // Recheck after preparing the temporary file, reducing the external-write race.
    let latest = match fs::read_to_string(&target) { Ok(text) => Some(text), Err(e) if e.kind() == std::io::ErrorKind::NotFound => None, Err(e) => return Err(e.to_string()) };
    if latest != current { return Err("保存期间文件被其他程序修改，请另存为。".into()); }
    temp.persist(&target).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn new_document_honors_confirmed_replace_and_discards_the_original_first() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("同名.md");
        create_empty_document_with(&path, &|p| fs::remove_file(p).map_err(|e| e.to_string())).unwrap();
        fs::write(&path, "保留原文").unwrap();
        let discarded = std::cell::RefCell::new(None);
        create_empty_document_with(&path, &|p| {
            fs::remove_file(p).map_err(|e| e.to_string())?;
            *discarded.borrow_mut() = Some(p.to_path_buf());
            Ok(())
        }).unwrap();
        assert_eq!(discarded.into_inner().as_deref(), Some(path.as_path()), "原文件应先被移走（生产环境移入废纸篓）");
        assert_eq!(fs::metadata(&path).unwrap().len(), 0, "替换后应是新的空文档");
    }
    #[test]
    fn a_failed_discard_keeps_the_existing_document() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("保留.md");
        fs::write(&path, "保留原文").unwrap();
        let result = create_empty_document_with(&path, &|_| Err("废纸篓不可用".into()));
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "保留原文");
    }
    use super::*;
    #[test]
    fn readonly_file_is_not_replaced_even_when_its_directory_is_writable() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("readonly.md");
        fs::write(&file, "original").unwrap();
        let permissions = fs::metadata(&file).unwrap().permissions();
        let mut readonly = permissions.clone(); readonly.set_readonly(true);
        fs::set_permissions(&file, readonly).unwrap();
        let result = atomic_save(file.to_str().unwrap(), "changed", Some("original".into()));
        fs::set_permissions(&file, permissions).unwrap();
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(file).unwrap(), "original");
    }
    #[test]
    fn startup_arguments_accept_markdown_paths_without_reading_other_files() {
        let cwd = std::env::temp_dir();
        let paths = document_arguments(vec!["Leaf.exe".into(), "中文 文件.MD".into(), "--help".into(), "photo.png".into(), "notes.markdown".into()], &cwd);
        assert_eq!(paths, vec![cwd.join("中文 文件.MD"), cwd.join("notes.markdown")]);
    }
    #[test]
    fn preserves_external_edits() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("中文.md");
        fs::write(&file, "external").unwrap();
        assert!(atomic_save(file.to_str().unwrap(), "mine", Some("old".into())).is_err());
        assert_eq!(fs::read_to_string(file).unwrap(), "external");
    }
    #[test]
    fn round_trips_markdown_and_creates_new_files() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("中文.md");
        let content = "# 标题\r\n\r\n正文  \r\n";
        atomic_save(file.to_str().unwrap(), content, None).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), content);
        atomic_save(file.to_str().unwrap(), "changed", Some(content.into())).unwrap();
        assert_eq!(fs::read_to_string(file).unwrap(), "changed");
    }
}

fn main() {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(all(target_os = "windows", feature = "native-smoke"))]
    for window in &mut context.config_mut().app.windows {
        window.additional_browser_args = Some(native_smoke_browser_args());
    }
    let builder = tauri::Builder::default();
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        open_windows_arguments(app, args, &cwd);
    }));
    builder.manage(OpenBuffers::default()).manage(Documents::default()).manage(Exports::default()).manage(RecoveryState::default()).manage(MenuFocus::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![recovery_retention, recovery_expire, import_attachment, reveal_resource, export_bundle, read_resource, open_link, initial_path, new_document, open_document, read_document, write_document, rename_document, finish_title_rename, open_export, export_snapshot, print_export, recovery_initial, recovery_checkpoint, recovery_list, recovery_read, recovery_delete, recovery_open])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            native_shortcuts::install(app.handle().clone());
            use tauri::menu::{Menu, Submenu, MenuItem, PredefinedMenuItem};
            let handle = app.handle();
            let new = MenuItem::with_id(handle, "new", "新建", true, Some("CmdOrCtrl+N"))?;
            let open = MenuItem::with_id(handle, "open", "打开…", true, Some("CmdOrCtrl+O"))?;
            let save = MenuItem::with_id(handle, "save", "保存", true, Some("CmdOrCtrl+S"))?;
            let save_as = MenuItem::with_id(handle, "save-as", "另存为…", true, Some("CmdOrCtrl+Shift+S"))?;
            let export = MenuItem::with_id(handle, "export-pdf", "导出 PDF…", true, Some("CmdOrCtrl+E"))?;
            let recovery_menu = MenuItem::with_id(handle, "recovery", "历史版本与草稿…", true, None::<&str>)?;
            let find = MenuItem::with_id(handle, "find", "查找与替换", true, Some("CmdOrCtrl+F"))?;
            // The native predefined Quit terminates through AppKit directly.
            // Route it through the same unsaved-document checks as window close.
            let quit = MenuItem::with_id(handle, "quit", "退出 Leaf", true, Some("CmdOrCtrl+Q"))?;
            let settings = MenuItem::with_id(handle, "settings", "设置…", true, Some("CmdOrCtrl+Alt+,"))?;
            let copy_rich = MenuItem::with_id(handle, "copy-rich", "复制为富文本", true, Some("CmdOrCtrl+Shift+C"))?;
            let paste_plain = MenuItem::with_id(handle, "paste-plain", "粘贴为纯文本", true, Some("CmdOrCtrl+T"))?;
            let app_menu = Submenu::with_items(handle, "Leaf", true, &[&PredefinedMenuItem::about(handle, Some("关于 Leaf"), None)?, &settings, &quit])?;
            let file = Submenu::with_items(handle, "文件", true, &[&new, &open, &save, &save_as, &recovery_menu, &export, &PredefinedMenuItem::close_window(handle, Some("关闭窗口"))?])?;
            // Undo and redo are deliberately not PredefinedMenuItem: on macOS
            // those bind Cmd-Z to the webview's native undo stack, which cannot
            // see changes the editor applies programmatically (formatting,
            // superscript, list conversion), so undo silently stops working
            // after them. Keep the standard shortcuts but route them through
            // the menu event channel into the editor's own history.
            let undo = MenuItem::with_id(handle, "undo", "撤销", true, Some("CmdOrCtrl+Z"))?;
            let redo = MenuItem::with_id(handle, "redo", "重做", true, Some("CmdOrCtrl+Shift+Z"))?;
            let cycle_mode = MenuItem::with_id(handle, "cycle-mode", "切换视图模式", true, Some("CmdOrCtrl+R"))?;
            let edit = Submenu::with_items(handle, "编辑", true, &[&undo, &redo, &PredefinedMenuItem::cut(handle, None)?, &PredefinedMenuItem::copy(handle, None)?, &PredefinedMenuItem::paste(handle, None)?, &PredefinedMenuItem::select_all(handle, None)?, &find, &copy_rich, &paste_plain, &cycle_mode])?;
            app.set_menu(Menu::with_items(handle, &[&app_menu, &file, &edit])?)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os="macos")]
            if matches!(event, tauri::WindowEvent::Focused(false)|tauri::WindowEvent::Destroyed) {
                let label=window.label().to_owned();let _=window.run_on_main_thread(move||unsafe{native_title::blur(&label)});
            }
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                *window.app_handle().state::<MenuFocus>().0.lock().unwrap() = Some(window.label().into());
            }
            // AppKit can return focus to an open panel's parent after the document
            // has opened. Enforce the same rule on that later focus transition.
            if window.label() == LAUNCHER && matches!(event, tauri::WindowEvent::Focused(true)) {
                let app = window.app_handle();
                if let Some(document) = document_window(app) {
                    if let Err(error) = hide_launcher(app) { eprintln!("{error}"); }
                    let _ = document.unminimize();
                    let _ = document.set_focus();
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().state::<OpenBuffers>().0.lock().unwrap().remove(window.label());
                window.app_handle().state::<Exports>().0.lock().unwrap().remove(window.label());
                window.app_handle().state::<Documents>().0.lock().unwrap().remove(window.label());
                window.app_handle().state::<RecoveryState>().drafts.lock().unwrap().remove(window.label());
                window.app_handle().state::<RecoveryState>().initial.lock().unwrap().remove(window.label());
                // Document destruction happens only after the frontend's unsaved
                // checks. Once the last document is gone, remove auxiliary windows
                // too; leaving the hidden launcher alive would require a second close.
                let app = window.app_handle();
                let remaining = app.state::<Documents>().0.lock().unwrap().len();
                if close_auxiliary_windows(window.label(), remaining) {
                    for (label, auxiliary) in app.webview_windows() {
                        if label == LAUNCHER || label.starts_with("export-") {
                            if let Err(error) = auxiliary.destroy() { eprintln!("{error}"); }
                        }
                    }
                }
            }
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "quit" { let _ = app.emit("leaf-close", ()); }
            else if event.id().as_ref() == "new" {
                let target = app.webview_windows().into_values().find(|w| !w.label().starts_with("export-") && w.is_focused().unwrap_or(false))
                    .or_else(|| document_window(app)).or_else(|| app.get_webview_window(LAUNCHER));
                if let Some(window) = target { let _ = window.emit_to(window.label(), "leaf-menu", "new"); }
            }
            else if let Some(window) = menu_window(app) {
                let _ = window.emit_to(window.label(), "leaf-menu", event.id().as_ref());
            }
        })
        .build(context).expect("Leaf could not start")
        .run(|app, event| match event {
            tauri::RunEvent::Ready => {
                #[cfg(target_os = "windows")]
                open_windows_arguments(app, std::env::args().collect(), &std::env::current_dir().unwrap_or_default().to_string_lossy());
                // macOS can deliver a document before Tauri creates its configured
                // welcome window. Do not let that later window cover the document:
                // hide the launcher, exactly as opening a file from it does.
                let label = app.state::<Documents>().0.lock().unwrap().keys().next().cloned();
                if let Some(window) = label.and_then(|label| app.get_webview_window(&label)) {
                    if let Err(error) = hide_launcher(app) { eprintln!("{error}"); }
                    let _ = window.set_focus();
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => { for url in urls { if let Ok(path) = url.to_file_path() { if let Err(error) = open_document(app.clone(), Some(path.to_string_lossy().into_owned())) { eprintln!("{error}"); } } } }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(document) = document_window(app) {
                    if let Err(error) = hide_launcher(app) { eprintln!("{error}"); }
                    let _ = document.unminimize();
                    let _ = document.set_focus();
                }
            }
            tauri::RunEvent::ExitRequested { api, .. } if !app.webview_windows().is_empty() => {
                api.prevent_exit();
                let _ = app.emit("leaf-close", ());
            }
            _ => {}
        });
}

#[cfg(test)]
mod rename_tests {
    use super::*;
    #[test]
    fn rename_preserves_content_and_rejects_conflicts_and_paths() {
        let dir=tempfile::tempdir().unwrap();let old=dir.path().join("old.md");
        fs::write(&old,"original").unwrap();fs::write(dir.path().join("taken.md"),"other").unwrap();
        assert!(rename_file(&old,"taken.md","original").is_err());
        assert_eq!(fs::read_to_string(dir.path().join("taken.md")).unwrap(),"other");
        assert!(rename_file(&old,"../escape.md","original").is_err());
        assert!(rename_file(&old,"new.md","stale").is_err());
        let new=rename_file(&old,"新名字.md","original").unwrap();
        assert!(!old.exists());assert_eq!(fs::read_to_string(new).unwrap(),"original");
    }
}
