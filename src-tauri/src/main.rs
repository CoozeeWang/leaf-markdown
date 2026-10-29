#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{collections::HashMap, fs, io::Write, path::{Path, PathBuf}, sync::{Mutex, atomic::{AtomicUsize, Ordering}}};
#[cfg(target_os = "macos")]
use std::collections::VecDeque;
use tauri::{Emitter, Manager};
use window_role::{WindowRole,role_for_label};
use update_admission::{AdmissionRegistry,OperationLease,OpenRequest,SaveOperation};
#[cfg(target_os = "macos")]
mod native_print;
#[cfg(target_os = "windows")]
mod windows_pdf;
#[cfg(any(target_os = "windows", test))]
mod pdf_output;
#[cfg(target_os = "macos")]
mod native_shortcuts;
#[cfg(target_os = "macos")]
mod native_title;
mod atomic_file;
mod recovery;
mod resources;
mod app_links;
mod document_location;
mod recent;
mod new_markdown;
mod i18n;
mod mcp;
mod ai_client_install;
mod updates;
mod update_releases;
mod update_package;
#[cfg(any(test,feature="legacy-updater-tests"))]
mod update_install;
#[cfg(all(target_os="windows",any(test,feature="legacy-updater-tests")))]
#[path="update_install_windows_gui.rs"]
mod update_install_gui;
#[cfg(all(target_os="macos",feature="native-smoke"))]
mod update_macos_test_driver;
#[cfg(all(target_os="macos",feature="native-smoke"))]
mod update_preservation_test_driver;
#[cfg(all(target_os="macos",any(test,feature="native-smoke")))]
mod update_install_fixture;
mod update_binary_identity;
mod update_admission;
mod update_coordinator;
mod window_role;
#[cfg(feature="native-smoke")]
mod update_test_driver;
#[cfg(feature = "native-smoke")]
mod mcp_test_driver;
#[cfg(target_os = "macos")]
mod native_services;

fn application_data(app: &tauri::AppHandle) -> Result<PathBuf, tauri::Error> {
    #[cfg(feature="native-smoke")]
    if update_test_driver::enabled() {return Ok(PathBuf::from(std::env::var("LEAF_UPDATE_TEST_DIR").expect("isolated update directory")));}
    #[cfg(feature="native-smoke")]
    if mcp_test_driver::enabled(app) {
        return Ok(PathBuf::from(std::env::var("LEAF_MCP_TEST_DIR").expect("isolated test directory")).join("app-data"));
    }
    app.path().app_data_dir()
}

fn native_admission(app:&tauri::AppHandle,label:Option<&str>)->Result<OperationLease,String> {
    app.state::<AdmissionRegistry>().admit_for(label)
}
// OS requests survive preparation in one bounded native queue. The retry closes
// the race between checking admission and reserving the new document window.
fn dispatch_os_request(app:&tauri::AppHandle,request:OpenRequest)->Result<(),String> {
    loop {
        if app.state::<AdmissionRegistry>().queue_if_closed(request.clone())? {return Ok(());}
        let result=match &request {
            OpenRequest::Document(path)=>open_document(app.clone(),Some(path.to_string_lossy().into_owned())),
            OpenRequest::NewMarkdown(folder)=>{
                match native_admission(app,None) {
                    Err(error)=>Err(error),
                    Ok(lease)=>{
                        let path=new_markdown::create_localized(folder,&i18n::app_text(app,"NA0083"));
                        drop(lease);
                        return path.and_then(|path|dispatch_os_request(app,OpenRequest::Document(path.clone())).map_err(|error|crate::i18n::error("main.the_document_was_created_but_could_not",serde_json::json!({"path":path.display().to_string(),"error":error}))));
                    }
                }
            }
        };
        match result {Err(error) if error==update_admission::BUSY=>continue,other=>return other}
    }
}
fn resume_os_requests(app:tauri::AppHandle) {
    tauri::async_runtime::spawn_blocking(move||{
        for request in app.state::<AdmissionRegistry>().take_pending() {
            let creating=matches!(&request,OpenRequest::NewMarkdown(_));
            if let Err(error)=dispatch_os_request(&app,request){
                use tauri_plugin_dialog::DialogExt;
                #[cfg(target_os="windows")]
                show_windows_launcher_if_empty(&app);
                app.dialog().message(i18n::app_error(&app,&error)).title(if creating{i18n::app_text(&app,"NA0003")}else{"Leaf".into()}).show(|_|{});
            }
        }
    });
}

#[derive(Default)]
struct RecoveryState { gate: Mutex<()>, drafts: Mutex<HashMap<String, String>>, initial: Mutex<HashMap<String, String>> }

#[derive(Default)]
struct Documents(Mutex<HashMap<String, Option<PathBuf>>>);
#[derive(Default)]
struct DocumentAnchors(Mutex<HashMap<String, document_location::Anchor>>);
#[derive(Default)]
struct MenuFocus(Mutex<Option<String>>);
#[derive(Default)]
struct OpenBuffers(Mutex<HashMap<String,String>>);
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct ExportSnapshot { source: String, name: String, numbered: bool, #[serde(default, skip_deserializing)] base_path: Option<PathBuf> }
#[derive(Default)]
struct Exports(Mutex<HashMap<String, ExportSnapshot>>);
// Finder may send Opened before setup registers Recent. Keep the paths until
// Ready, then open them off the AppKit callback so state and windows are ready.
#[cfg(target_os = "macos")]
#[derive(Default)]
struct OpenRequests(Mutex<OpenRequestsState>);
#[cfg(target_os = "macos")]
#[derive(Default)]
struct OpenRequestsState { ready: bool, draining: bool, pending: VecDeque<PathBuf> }

#[cfg(target_os = "macos")]
impl OpenRequests {
    fn enqueue(&self, paths: impl IntoIterator<Item = PathBuf>) -> bool {
        let mut state = self.0.lock().unwrap();
        state.pending.extend(paths);
        Self::begin_drain(&mut state)
    }

    fn mark_ready(&self) -> bool {
        let mut state = self.0.lock().unwrap();
        state.ready = true;
        Self::begin_drain(&mut state)
    }

    fn begin_drain(state: &mut OpenRequestsState) -> bool {
        if !state.ready || state.draining || state.pending.is_empty() { return false; }
        state.draining = true;
        true
    }

    fn next(&self) -> Option<PathBuf> {
        let mut state = self.0.lock().unwrap();
        if let Some(path) = state.pending.pop_front() { Some(path) }
        else { state.draining = false; None }
    }
}

#[cfg(target_os = "macos")]
fn drain_open_requests(app: tauri::AppHandle) {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        while let Some(path) = app.state::<OpenRequests>().next() {
            if let Err(error) = dispatch_os_request(&app,OpenRequest::Document(path)) {
                app.dialog().message(i18n::render(&app.state::<i18n::Language>().current(), "NA0001", &serde_json::json!({"error":error})))
                    .title("Leaf").show(|_| {});
            }
        }
    });
}

#[cfg(all(test, target_os = "macos"))]
mod open_requests_tests {
    use super::OpenRequests;
    use std::path::PathBuf;

    #[test]
    fn early_open_requests_wait_for_ready_and_keep_their_order() {
        let requests = OpenRequests::default();
        assert!(!requests.enqueue([PathBuf::from("first.md"), PathBuf::from("second.md")]));
        assert!(requests.mark_ready());
        assert!(!requests.mark_ready());
        assert_eq!(requests.next(), Some(PathBuf::from("first.md")));
        assert!(!requests.enqueue([PathBuf::from("third.md")]));
        assert_eq!(requests.next(), Some(PathBuf::from("second.md")));
        assert_eq!(requests.next(), Some(PathBuf::from("third.md")));
        assert_eq!(requests.next(), None);
        assert!(requests.enqueue([PathBuf::from("fourth.md")]));
        assert_eq!(requests.next(), Some(PathBuf::from("fourth.md")));
        assert_eq!(requests.next(), None);
    }
}
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
    // The close-only probe needs an explicit Wry port but no PDF/legacy browser
    // overrides. This branch is absent from all production builds.
    if std::env::var_os("LEAF_NATIVE_SMOKE_SAFE_BROWSER").is_some() {
        return format!("--remote-debugging-address=127.0.0.1 --remote-debugging-port={port}");
    }
    format!("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}")
}

// Pending document creation is included in Documents, so closing a window
// must not terminate another document that is still opening.
fn close_auxiliary_windows(closing: &str, remaining_documents: usize) -> bool {
    role_for_label(closing)==WindowRole::Document && remaining_documents == 0
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

#[cfg(target_os = "windows")]
fn show_windows_launcher_if_empty(app: &tauri::AppHandle) {
    if document_window(app).is_none() {
        if let Some(window) = app.get_webview_window(LAUNCHER) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn document_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows().into_values().find(|window| verified_window_role(app,window.label())==WindowRole::Document)
}

// A label grammar is not an authority grant. Pending/live document and export
// registration must agree with the actual invoking native WebView.
fn verified_window_role(app:&tauri::AppHandle,label:&str)->WindowRole {
    if app.get_webview_window(label).is_none() {return WindowRole::Unknown;}
    match role_for_label(label) {
        WindowRole::Document if app.state::<Documents>().0.lock().unwrap().contains_key(label)=>WindowRole::Document,
        WindowRole::Export if app.state::<Exports>().0.lock().unwrap().contains_key(label)=>WindowRole::Export,
        WindowRole::Document|WindowRole::Export=>WindowRole::Unknown,
        role=>role,
    }
}
fn focus_primary_window(app:&tauri::AppHandle) {
    let target=document_window(app).or_else(||app.get_webview_window(updates::LABEL).filter(|w|w.is_visible().unwrap_or(false)))
        .or_else(||app.get_webview_window(LAUNCHER));
    if let Some(window)=target {
        if verified_window_role(app,window.label())==WindowRole::Document {let _=hide_launcher(app);}
        let _=window.show();let _=window.unminimize();let _=window.set_focus();
    }
}
fn request_ordinary_quit(app:&tauri::AppHandle) {
    let Ok((decision,interrupted))=app.state::<update_coordinator::UpdateCoordinator>().begin_quit(&app.state::<AdmissionRegistry>())else{return;};
    if let Some((id,labels))=interrupted{update_coordinator::release(app,&id,labels,"update_prepare_cancelled");}
    match decision{
        update_admission::CloseDecision::Allowed=>{},
        update_admission::CloseDecision::CancelledPrepare=>{let _=app.emit("leaf-update-admission-interrupted",());return;},
        update_admission::CloseDecision::CommittedBlocked=>return,
    }
    let participants=app.state::<Documents>().0.lock().unwrap().keys().cloned().collect::<std::collections::HashSet<_>>();
    // No document data can be lost when only auxiliary/welcome windows remain.
    if participants.is_empty() {app.exit(0);return;}
    let result=app.state::<Mutex<window_role::OrdinaryQuit>>().lock().unwrap().begin(participants.clone());
    if let Ok(quit_id)=result {
        for label in participants {
            #[cfg(feature="native-smoke")] update_test_driver::coordinator_leaf_close(app);
            let _=app.emit_to(&label,"leaf-close",serde_json::json!({"quit_id":quit_id}));
        }
    }else{app.state::<update_coordinator::UpdateCoordinator>().cancel_quit(None);}
}
/// Preserve native CloseRequested action ownership across the existing renderer
/// close flow. A no-ID legacy callback cannot consume a suppressed native event.
#[tauri::command]
async fn mcp_document_boundary(app:tauri::AppHandle,window:tauri::WebviewWindow,broker:tauri::State<'_,mcp::LeafMcpBroker>,reason:String,close_action_id:Option<u64>)->Result<(),String>{
    if reason=="close"{
        let nonce=update_coordinator::caller_nonce(&app,&window)?;
        let coordinator=app.state::<update_coordinator::UpdateCoordinator>();
        if close_action_id.is_none()&&coordinator.legacy_close_denied(window.label(),nonce){return Err("update_prepare_cancelled".into());}
        let action=if let Some(action)=coordinator.close_action(window.label(),nonce){
            if close_action_id.is_some_and(|id|id!=action.action_id){return Err("update_close_action_stale".into());}action
        }else{
            if close_action_id.is_some(){return Err("update_close_action_stale".into());}
            let action=coordinator.begin_close(&app.state::<AdmissionRegistry>(),window.label(),nonce)?;
            update_coordinator::publish_close_action(&app,&action);action
        };
        if !action.allowed{return Err("update_prepare_cancelled".into());}
    }
    mcp::mcp_document_boundary(app,window,broker,reason).await
}
#[tauri::command]
fn ordinary_quit_cancelled(app:tauri::AppHandle,window:tauri::WebviewWindow,quit_id:u64)->Result<(),String> {
    if verified_window_role(&app,window.label())!=WindowRole::Document {return Err("window_role_denied".into());}
    if app.state::<Mutex<window_role::OrdinaryQuit>>().lock().unwrap().cancel(quit_id,window.label()) {
        app.state::<update_coordinator::UpdateCoordinator>().cancel_quit(Some(window.label()));Ok(())
    }else{Err("quit_intent_stale".into())}
}
fn last_document_closed(app:&tauri::AppHandle) {
    let updater=app.get_webview_window(updates::LABEL);
    let visible=updater.as_ref().is_some_and(|window|window.is_visible().unwrap_or(false));
    for (label,window) in app.webview_windows() {
        if role_for_label(&label)==WindowRole::Export {let _=window.destroy();}
    }
    if visible {return;}
    if updater.is_some() {
        if let Some(launcher)=app.get_webview_window(LAUNCHER) {let _=launcher.show();let _=launcher.set_focus();}
    } else if let Some(launcher)=app.get_webview_window(LAUNCHER) {let _=launcher.destroy();}
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

const MUTATING_MENU_IDS:&[&str]=&["cut","paste","paste-plain","add-comment","undo","redo","recovery"];
fn dispatch_update_menu(app:&tauri::AppHandle,caller:&str)->Result<(),String> {
    if !matches!(verified_window_role(app,caller),WindowRole::Launcher|WindowRole::Document|WindowRole::Update) {return Err("update_wrong_role".into());}
    updates::open_update_window(app)
}
fn document_menu_item(app:&tauri::AppHandle,id:&str)->Option<tauri::menu::MenuItem<tauri::Wry>> {
    fn find(items:Vec<tauri::menu::MenuItemKind<tauri::Wry>>,id:&str)->Option<tauri::menu::MenuItem<tauri::Wry>> {
        for item in items {match item {
            tauri::menu::MenuItemKind::MenuItem(item) if item.id().as_ref()==id=>return Some(item),
            tauri::menu::MenuItemKind::Submenu(sub)=>{if let Some(item)=find(sub.items().ok()?,id){return Some(item);}},
            _=>{}
        }}None
    }
    find(app.menu()?.items().ok()?,id)
}
fn refresh_reveal_menu(app:&tauri::AppHandle) {
    let enabled=menu_window(app).is_some_and(|window|verified_window_role(app,window.label())==WindowRole::Document&&document_location::can_reveal(&app.state::<Documents>().0.lock().unwrap(),window.label()));
    if let Some(item)=document_menu_item(app,"reveal-document") {let _=item.set_enabled(enabled);}
}
fn refresh_reveal_menu_on_main(app:&tauri::AppHandle) {
    let handle=app.clone();let _=app.run_on_main_thread(move||refresh_reveal_menu(&handle));
}
fn document_menu_allowed(role:WindowRole,command:&str,admitted:bool,locked:bool)->bool{
    window_role::allows_menu(role,command)
        &&(matches!(command,"copy"|"find"|"settings"|"copy-rich"|"reveal-document")||admitted)
        &&(!MUTATING_MENU_IDS.contains(&command)||!locked)
}
pub(crate) fn refresh_document_menu_on_main(app:&tauri::AppHandle){
    let handle=app.clone();let _=app.run_on_main_thread(move||refresh_document_menu(&handle));
}
fn refresh_document_menu(app:&tauri::AppHandle) {
    refresh_reveal_menu(app);
    let window=menu_window(app);
    let role=window.as_ref().map(|window|verified_window_role(app,window.label())).unwrap_or(WindowRole::Unknown);
    let admitted=window.as_ref().is_some_and(|window|app.state::<AdmissionRegistry>().document_mutation_allowed(window.label()));
    let locked=window.as_ref().is_some_and(|window|app.state::<mcp::LeafMcpBroker>().window_locked(window.label()));
    for id in ["new","open","save","save-as","export-pdf","find","settings","copy-rich","cycle-mode","cut","paste","paste-plain","add-comment","undo","redo","recovery"] {
        if let Some(item)=document_menu_item(app,id) {
            let allowed=document_menu_allowed(role,id,admitted,locked);
            let _=item.set_enabled(allowed);
        }
    }
}
fn dispatch_document_menu(app:&tauri::AppHandle,label:&str,command:&str)->Result<bool,String> {
    if command=="reveal-document"&&!document_location::can_reveal(&app.state::<Documents>().0.lock().unwrap(),label){return Ok(false);}
    let broker=app.state::<mcp::LeafMcpBroker>();
    if !document_menu_allowed(verified_window_role(app,label),command,
        app.state::<AdmissionRegistry>().document_mutation_allowed(label),broker.window_locked(label)){return Ok(false);}
    #[cfg(target_os="macos")]
    if command=="cut"||command=="paste" {
        let window=app.get_webview_window(label).ok_or("menu_window_unavailable")?;
        let lease=native_admission(app,Some(label))?;
        let handle=app.clone();let target=label.to_owned();let paste=command=="paste";
        app.run_on_main_thread(move||{
            let _lease=lease;
            if _lease.recheck().is_err(){return;}
            if handle.state::<mcp::LeafMcpBroker>().window_locked(&target){return;}
            if let Ok(native)=window.ns_window(){unsafe{
                use objc2::{class,msg_send,sel,runtime::AnyObject};
                let native=native as *mut AnyObject;
                let responder:*mut AnyObject=msg_send![native,firstResponder];
                let application:*mut AnyObject=msg_send![class!(NSApplication),sharedApplication];
                let action=if paste{sel!(paste:)}else{sel!(cut:)};
                let _:bool=msg_send![application,sendAction:action,to:responder,from:std::ptr::null::<AnyObject>()];
            }}
        }).map_err(|_|"native_clipboard_unavailable")?;
        return Ok(true);
    }
    let binding=broker.window_binding(label);
    app.emit_to(label,"leaf-menu",serde_json::json!({"command":command,"binding":binding})).map_err(|_|"menu_event_unavailable")?;
    Ok(true)
}

fn create_from_file_manager(app: tauri::AppHandle, target: impl FnOnce() -> Result<PathBuf, String> + Send + 'static) {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let result=target().and_then(|folder|dispatch_os_request(&app,OpenRequest::NewMarkdown(folder)));
        if let Err(error) = result {
            #[cfg(target_os = "windows")]
            show_windows_launcher_if_empty(&app);
            app.dialog().message(i18n::app_error(&app, &error)).title(i18n::app_text(&app, "NA0003")).show(|_| {});
        }
    });
}

#[cfg(target_os = "windows")]
fn open_windows_arguments(app: &tauri::AppHandle, args: Vec<String>, cwd: &str) -> bool {
    use tauri_plugin_dialog::DialogExt;
    if let Some(folder) = new_markdown::argument(&args, std::path::Path::new(cwd)) {
        create_from_file_manager(app.clone(), move || folder);
        return true;
    }
    let paths = document_arguments(args, std::path::Path::new(cwd));
    if paths.is_empty() {
        focus_primary_window(app);
    }
    let opening = !paths.is_empty();
    // Ready and single-instance callbacks run on the event loop. Command
    // attributes do not affect direct Rust calls, so dispatch explicitly.
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        for path in paths {
            if let Err(error) = dispatch_os_request(&app,OpenRequest::Document(path)) {
                app.dialog().message(i18n::app_error(&app, &error)).title("Leaf").show(|_| {});
            }
        }
        if opening { show_windows_launcher_if_empty(&app); }
    });
    opening
}

#[cfg(any(target_os = "windows", test))]
fn document_arguments(args: Vec<String>, cwd: &std::path::Path) -> Vec<PathBuf> {
    if args.get(1).is_some_and(|arg|arg=="--leaf-update-reconcile"){return Vec::new();}
    args.into_iter().skip(1).filter_map(|arg| {
        let path = PathBuf::from(arg);
        let extension = path.extension()?.to_str()?.to_ascii_lowercase();
        if !matches!(extension.as_str(), "md" | "markdown" | "mdown") { return None; }
        Some(if path.is_absolute() { path } else { cwd.join(path) })
    }).collect()
}

#[tauri::command(async)]
fn open_export(app: tauri::AppHandle, window: tauri::WebviewWindow, mut snapshot: ExportSnapshot) -> Result<(), String> {
    let _lease=native_admission(&app,Some(window.label()))?;
    snapshot.base_path = app.state::<Documents>().0.lock().unwrap().get(window.label()).cloned().flatten();
    let label = format!("export-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    app.state::<Exports>().0.lock().unwrap().insert(label.clone(), snapshot);
    let builder = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html?export=1".into()))
        .title(i18n::app_text(&app, "NA0004")).inner_size(950., 800.).min_inner_size(720., 480.);
    let builder = development_window(&app, builder);
    // Export pages have no document-startup reveal step; keep their window visible.
    #[cfg(not(target_os = "macos"))]
    let builder = if let Some(menu) = app.menu() { builder.menu(menu) } else { builder };
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
    exports.0.lock().unwrap().get(window.label()).cloned().ok_or(crate::i18n::error("main.the_export_preview_is_unavailable", serde_json::json!({})).into())
}

fn resource_document(app: &tauri::AppHandle, label: &str) -> Result<PathBuf, String> {
    app.state::<Documents>().0.lock().unwrap().get(label).cloned().flatten()
        .or_else(|| app.state::<Exports>().0.lock().unwrap().get(label).and_then(|s| s.base_path.clone()))
        .ok_or(crate::i18n::error("main.save_the_document_first_to_determine_the", serde_json::json!({})).into())
}
// Every command below that touches the filesystem is `(async)`: Tauri runs a
// command on the UI thread unless told otherwise, and one slow read or write
// there freezes the whole window -- a document kept in iCloud Drive goes
// through the file provider, where an ordinary read, fsync or rename can wait
// on the network. Off-thread, a slow operation delays only its own reply.
// Window-building commands also run off the UI thread: synchronous command
// handlers deadlock WebView2 on Windows. Tauri dispatches native UI work itself.
#[tauri::command(async)]
async fn import_attachment(app: tauri::AppHandle, window: tauri::WebviewWindow, name: String, data: Option<Vec<u8>>, source: Option<String>) -> Result<String, String> {
    #[cfg(feature="native-smoke")]
    update_test_driver::trace("resource_command_enter",window.label());
    let lease=native_admission(&app,Some(window.label()))?;
    // Tauri's async wrapper executes a synchronous command inside a Tokio
    // future. Source reads and resource I/O belong to the blocking pool; the
    // worker owns admission until real completion even if its caller cancels.
    tauri::async_runtime::spawn_blocking(move||import_attachment_io(app,window,name,data,source,lease)).await.map_err(|_|"native_resource_io_failed")?
}
fn import_attachment_io(app:tauri::AppHandle,window:tauri::WebviewWindow,name:String,data:Option<Vec<u8>>,source:Option<String>,lease:OperationLease)->Result<String,String>{
    #[cfg(feature="native-smoke")]
    update_test_driver::trace("resource_io_enter",window.label());
    lease.recheck()?;
    if verified_window_role(window.app_handle(),window.label())!=WindowRole::Document { return Err(crate::i18n::error("main.open_or_create_a_document_first", serde_json::json!({})).into()); }
    let doc = resource_document(&app, window.label())?;
    let data = match (data, source) { (Some(data), None) => data, (None, Some(path)) => resources::bytes(std::path::Path::new(&path))?, _ => return Err(crate::i18n::error("main.invalid_attachment_source", serde_json::json!({})).into()) };
    #[cfg(feature="native-smoke")]
    update_test_driver::pause_io(&app,"resource")?;
    let result=resources::with_admission(&lease,||resources::import_managed(&doc,&name,&data,Some(&application_data(&app).map_err(|e|e.to_string())?.join("removed-images-v1"))));
    #[cfg(feature="native-smoke")]
    update_test_driver::trace(if result.is_ok(){"resource_command_ok"}else{"resource_command_error"},window.label());
    result
}
fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { std::process::Command::new("open").arg("-R").arg(&path).spawn().map_err(|e| e.to_string())?; }
    #[cfg(target_os = "windows")]
    {
        // Quoting the path keeps spaces in folder names from splitting the argument.
        use std::os::windows::process::CommandExt;
        let display = path.to_string_lossy();
        let display = display.strip_prefix("\\\\?\\UNC\\").map(|p| format!("\\\\{p}"))
            .unwrap_or_else(|| display.strip_prefix("\\\\?\\").unwrap_or(&display).to_string());
        // Explorer has its own comma/quote grammar. Command::arg would add a
        // second escaping layer and prevent Explorer from finding this file.
        std::process::Command::new("explorer.exe").raw_arg(format!("/select,\"{display}\""))
            .spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = path; return Err(crate::i18n::error("main.showing_files_in_the_file_manager_is", serde_json::json!({})).into()); }
    Ok(())
}
#[tauri::command(async)]
fn reveal_document(window: tauri::WebviewWindow, docs: tauri::State<Documents>) -> Result<(), String> {
    if verified_window_role(window.app_handle(),window.label())!=WindowRole::Document { return Err(crate::i18n::error("main.open_or_create_a_document_first", serde_json::json!({})).into()); }
    let path = document_location::reveal_target(&docs.0.lock().unwrap(),window.label())
        .map_err(|key|crate::i18n::error(key,serde_json::json!({})))?;
    reveal_in_file_manager(&path)
}
// Shows the attachment in the file manager instead of opening it: a picture the
// webview cannot decode is still a real file the reader may want to find.
#[tauri::command(async)]
fn reveal_resource(app: tauri::AppHandle, window: tauri::WebviewWindow, relative: String) -> Result<(), String> {
    let doc = resource_document(&app, window.label())?;
    let path = resources::resolve(&doc, &relative).map_err(|_| crate::i18n::error("main.could_not_find_an_accessible_local_image", serde_json::json!({})).to_string())?;
    if !path.is_file() { return Err(crate::i18n::error("main.the_image_file_is_no_longer_at", serde_json::json!({})).into()); }
    reveal_in_file_manager(&path)
}
#[tauri::command(async)]
fn read_resource(app: tauri::AppHandle, window: tauri::WebviewWindow, relative: String, prepare_id:Option<update_coordinator::PrepareId>) -> Result<Vec<u8>, String> {
    let doc = resource_document(&app, window.label())?;
    if let Ok(path)=resources::resolve(&doc,&relative){return resources::bytes(&path);}
    let (lease,_)=app.state::<update_coordinator::UpdateCoordinator>().admit_declared_save(&app.state::<AdmissionRegistry>(),window.label(),SaveOperation::Resource,prepare_id.as_ref())?;
    resources::with_admission(&lease,||resources::restore(&application_data(&app).map_err(|e|e.to_string())?.join("removed-images-v1"),&doc,&relative))?;
    resources::bytes(&resources::resolve(&doc, &relative)?)
}
#[tauri::command(async)]
fn copy_pasted_images(window: tauri::WebviewWindow, docs: tauri::State<Documents>, source_label: String, references: Vec<String>) -> Result<Vec<(String,String)>, String> {
    let lease=native_admission(window.app_handle(),Some(window.label()))?;
    if verified_window_role(window.app_handle(),window.label())!=WindowRole::Document || verified_window_role(window.app_handle(),&source_label)!=WindowRole::Document { return Err(crate::i18n::error("main.could_not_copy_the_image_copy_it", serde_json::json!({})).into()); }
    let (source, target) = {
        let documents = docs.0.lock().unwrap();
        let source = documents.get(&source_label).and_then(|path| path.clone()).ok_or(crate::i18n::error("main.the_source_document_has_been_closed_copy", serde_json::json!({})))?;
        let target = documents.get(window.label()).and_then(|path| path.clone()).ok_or(crate::i18n::error("main.save_the_destination_document_first", serde_json::json!({})))?;
        (source, target)
    };
    resources::with_admission(&lease,||resources::copy_selected_images(&source,&target,&references))
}
#[tauri::command(async)]
fn open_link(app: tauri::AppHandle, window: tauri::WebviewWindow, target: String) -> Result<(), String> {
    let lower = target.to_ascii_lowercase();
    let external = app_links::is_supported(&target) || lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:");
    let destination = if external {
        if target.chars().any(|c| c.is_control()) { return Err(crate::i18n::error("main.invalid_link", serde_json::json!({})).into()); }
        target
    } else {
        let doc = resource_document(&app, window.label())?;
        let path = resources::resolve(&doc, &target)?;
        let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
        if matches!(ext.as_str(), "md" | "markdown" | "mdown") { return open_document(app, Some(path.to_string_lossy().into_owned())); }
        if !matches!(ext.as_str(), "pdf" | "txt" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "heif" | "svg") { return Err(crate::i18n::error("main.open_this_type_of_attachment_in_the", serde_json::json!({})).into()); }
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
        if result <= 32 { return Err(crate::i18n::error("main.could_not_open_the_link", serde_json::json!({})).into()); }
    }
    Ok(())
}

#[tauri::command]
fn show_comment_context(window: tauri::WebviewWindow) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let app = window.app_handle();
    let add = MenuItem::with_id(app, "add-comment", i18n::app_text(app, "comments.add"), true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&add, &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
        &PredefinedMenuItem::cut(app, Some(&i18n::app_text(app,"native.cut"))).map_err(|e| e.to_string())?,
        &PredefinedMenuItem::copy(app, Some(&i18n::app_text(app,"native.copy"))).map_err(|e| e.to_string())?,
        &PredefinedMenuItem::paste(app, Some(&i18n::app_text(app,"native.paste"))).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn print_export(window: tauri::WebviewWindow) -> Result<(), String> {
    let lease=native_admission(window.app_handle(),None)?;
    if verified_window_role(window.app_handle(),window.label())!=WindowRole::Export { return Err(crate::i18n::error("main.open_the_pdf_export_preview_first", serde_json::json!({})).into()); }
    #[cfg(target_os = "macos")]
    {
        #[cfg(feature="native-smoke")]
        let handle=window.app_handle().clone();
        return window.with_webview(move|platform| unsafe {
            if lease.recheck().is_err(){return;}
            let webview=&*(platform.inner() as *const objc2::runtime::AnyObject);
            #[cfg(feature="native-smoke")]
            if update_test_driver::admission_enabled(){
                let path=application_data(&handle).expect("isolated admission directory").join("admission.pdf");
                native_print::fixture_pdf(webview,lease,&path,move|success|update_test_driver::report_print(&handle,success));return;
            }
            native_print::show_tracked(webview,lease);
        }).map_err(|e| e.to_string());
    }
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_dialog::DialogExt;
        let name = window.app_handle().state::<Exports>().0.lock().unwrap()
            .get(window.label()).map(|s| pdf_output::file_name(&s.name)).ok_or("Export snapshot unavailable.")?;
        // Only the opt-in native CI probe can bypass the real Save dialog.
        #[cfg(feature = "native-smoke")]
        let probe = std::env::var_os("LEAF_NATIVE_SMOKE_PDF_DIR").map(|p| PathBuf::from(p).join(&name));
        #[cfg(not(feature = "native-smoke"))]
        let probe: Option<PathBuf> = None;
        let target = if let Some(path) = probe { path } else {
            let Some(path) = window.app_handle().dialog().file().set_parent(&window)
                .add_filter("PDF", &["pdf"]).set_file_name(name).blocking_save_file() else { return Ok(()); };
            path.into_path().map_err(|e| e.to_string())?
        };
        lease.recheck()?;
        let temp = pdf_output::prepare(&target)?;
        let output = temp.to_path_buf();
        let (tx, rx) = std::sync::mpsc::channel();
        let completion_lease=lease.clone();
        window.with_webview(move |platform| {
            let lease=completion_lease;
            if let Err(error)=lease.recheck(){let _=tx.send(Err(error));return;}
            let completed = tx.clone();
            let started = unsafe {
                platform.controller().CoreWebView2().and_then(|webview| {
                    windows_pdf::start(platform.environment(), webview, &output, Box::new(move |result| {
                        let _lease=lease;
                        let result = result.map_err(|e| e.to_string()).and_then(|saved| {
                            if saved { Ok(()) } else { Err("The PDF renderer could not save the document.".into()) }
                        });
                        let _ = completed.send(result);
                    }))
                })
            };
            if let Err(error) = started { let _ = tx.send(Err(error.to_string())); }
        }).map_err(|e| e.to_string())?;
        // This command runs on a worker; WebView2 completion stays on the UI thread.
        rx.recv().map_err(|e| e.to_string())??;
        pdf_output::finish(temp, &target)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
    trash::delete(path).map_err(|error| crate::i18n::error("main.could_not_move_the_original_file_to", serde_json::json!({"error": (error).to_string()})))
}

fn create_empty_document_with(path: &std::path::Path, discard: &dyn Fn(&std::path::Path) -> Result<(), String>) -> Result<(), String> {
    if path.exists() { discard(path)?; }
    // create_new still guards the race where another process recreates the
    // name between the discard above and this open.
    let file = fs::OpenOptions::new().write(true).create_new(true).open(path)
        .map_err(|error| if error.kind() == std::io::ErrorKind::AlreadyExists {
            crate::i18n::error("main.a_file_with_this_name_already_exists", serde_json::json!({})).to_string()
        } else { error.to_string() })?;
    file.sync_all().map_err(|error| error.to_string())
}

fn create_empty_document(path: &std::path::Path) -> Result<(), String> {
    create_empty_document_with(path, &discard_replaced_document)
}

#[tauri::command(async)]
fn new_document(app:tauri::AppHandle,path: String) -> Result<(), String> {
    let _lease=native_admission(&app,None)?;
    create_empty_document(std::path::Path::new(&path))
}

#[tauri::command(async)]
fn open_document(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    create_document(app, path, None, None)
}

fn create_document(app: tauri::AppHandle, path: Option<String>, recovered: Option<String>, expected_identity: Option<(u64, u128)>) -> Result<(), String> {
    let label=format!("document-{}",NEXT_WINDOW.fetch_add(1,Ordering::Relaxed));
    let reservation=app.state::<AdmissionRegistry>().reserve_document(&label)?;
    #[cfg(feature="native-smoke")]
    update_test_driver::pause_io(&app,"open")?;
    reservation.recheck()?;
    let path = path.map(|p| fs::canonicalize(p).map_err(|e| e.to_string())).transpose()?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let anchor = path.as_ref().map(|p| document_location::Anchor::open(p).map_err(|e| e.to_string())).transpose()?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Some(expected) = expected_identity {
        if anchor.as_ref().map(document_location::Anchor::token) != Some(expected) {
            return Err(crate::i18n::error("main.the_original_file_has_been_moved_deleted", serde_json::json!({})).into());
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = expected_identity;
    if let Some(ref target) = path {
        let docs = app.state::<Documents>();
        let docs = docs.0.lock().unwrap();
        for (label, existing) in docs.iter() {
            #[cfg(any(target_os="macos",target_os="windows"))]
            let same_identity=anchor.as_ref().is_some_and(|candidate|app.state::<DocumentAnchors>().0.lock().unwrap().get(label).is_some_and(|existing|existing.token()==candidate.token()));
            #[cfg(not(any(target_os="macos",target_os="windows")))]
            let same_identity=false;
            if existing.as_ref() == Some(target) || same_identity {
                if let Some(window) = app.get_webview_window(label) {
                    // Native focus callbacks now verify document registration.
                    // Release the registry before UI dispatch can re-enter it.
                    drop(docs);
                    window.unminimize().map_err(|e| e.to_string())?;
                    window.set_focus().map_err(|e| e.to_string())?;
                    hide_launcher(&app)?;
                    if let Err(error) = app.state::<recent::Recent>().remember(&app, target) { eprintln!("Recent files: {error}"); }
                    return Ok(());
                }
            }
        }
    }
    app.state::<Documents>().0.lock().unwrap().insert(label.clone(), path);
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Some(anchor) = anchor { app.state::<DocumentAnchors>().0.lock().unwrap().insert(label.clone(), anchor); }
    if let Some(content) = recovered { app.state::<RecoveryState>().initial.lock().unwrap().insert(label.clone(), content); }
    let builder = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html?document=1".into()))
        .title("Leaf").inner_size(1100., 800.).min_inner_size(900., 480.);
    let builder = development_window(&app, builder);
    #[cfg(not(target_os = "macos"))]
    let builder = if let Some(menu) = app.menu() { builder.menu(menu) } else { builder };
    #[cfg(all(target_os = "windows", feature = "native-smoke"))]
    let builder = builder.additional_browser_args(&native_smoke_browser_args());
    let result = builder.build();
    if let Err(error) = result {
        app.state::<Documents>().0.lock().unwrap().remove(&label);
        app.state::<DocumentAnchors>().0.lock().unwrap().remove(&label);
        app.state::<RecoveryState>().initial.lock().unwrap().remove(&label);
        return Err(error.to_string());
    }
    // The launcher has done its job once a document window is on screen. Hide it
    // rather than destroy it: the window keeps its own state, and the ordinary
    // "all windows destroyed" exit path stays untouched, so quitting Leaf still
    // runs through the unsaved-document checks.
    hide_launcher(&app)?;
    if let Some(path) = app.state::<Documents>().0.lock().unwrap().get(&label).cloned().flatten() {
        if let Err(error) = app.state::<recent::Recent>().remember(&app, &path) { eprintln!("Recent files: {error}"); }
    }
    reservation.commit();
    Ok(())
}

#[tauri::command(async)]
fn read_document(path: String) -> Result<String, String> { fs::read_to_string(path).map_err(|e| e.to_string()) }

fn anchor_matches(anchors: &DocumentAnchors, label: &str, path: &Path) -> bool {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    { anchors.0.lock().unwrap().get(label).is_some_and(|anchor| anchor.matches_path(path)) }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = (anchors, label, path); true }
}

#[cfg(target_os = "windows")]
fn release_anchor(anchors: &DocumentAnchors, label: &str) -> Option<(u64, u128)> {
    let old = anchors.0.lock().unwrap().remove(label)?;
    let token = old.token();
    drop(old);
    Some(token)
}

#[cfg(target_os = "windows")]
fn restore_anchor(anchors: &DocumentAnchors, label: &str, path: &Path, token: Option<(u64, u128)>) {
    if let (Some(token), Ok(anchor)) = (token, document_location::Anchor::open(path)) {
        if anchor.token() == token { anchors.0.lock().unwrap().insert(label.into(), anchor); }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentObservation { path: String, content: String, moved_images: Vec<String> }

// The UI only supplies images it actually displayed before the move. Recheck
// the two directories here, without restoring, copying or rewriting a file.
fn moved_missing_images(source: &Path, target: &Path, loaded: &[String]) -> Vec<String> {
    if source.parent() == target.parent() { return Vec::new(); }
    let Some(directory) = target.parent() else { return Vec::new(); };
    let mut confirmed = std::collections::BTreeSet::new();
    for relative in loaded {
        if let Ok(old) = resources::resolve(source, relative) {
            let missing = fs::symlink_metadata(directory.join(relative))
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound);
            if missing && resources::bytes(&old).is_ok() { confirmed.insert(relative.clone()); }
        }
    }
    confirmed.into_iter().collect()
}

#[tauri::command(async)]
async fn observe_document(app: tauri::AppHandle, window: tauri::WebviewWindow, docs: tauri::State<'_,Documents>, anchors: tauri::State<'_,DocumentAnchors>, recovery: tauri::State<'_,RecoveryState>, loaded_images: Vec<String>) -> Result<DocumentObservation, String> {
    // Autosave observes before checkpoint/write. A renderer fence permits this
    // pure read, but never a silent relocation or native binding/history write.
    if !app.state::<AdmissionRegistry>().document_mutation_allowed(window.label()) {
        return tauri::async_runtime::spawn_blocking(move||{
            let source=app.state::<Documents>().0.lock().unwrap().get(window.label()).cloned().flatten().ok_or(update_admission::BUSY)?;
            let anchors=app.state::<DocumentAnchors>();let anchors=anchors.0.lock().unwrap();
            #[cfg(any(target_os="macos",target_os="windows"))]
            let located=anchors.get(window.label()).ok_or(update_admission::BUSY)?.locate().map_err(|e|e.to_string())?;
            #[cfg(not(any(target_os="macos",target_os="windows")))]
            let located=document_location::Located{path:source.clone(),content:fs::read_to_string(&source).map_err(|e|e.to_string())?};
            if located.path!=source{return Err(update_admission::BUSY.into());}
            #[cfg(any(target_os="macos",target_os="windows"))]
            if !anchors.get(window.label()).is_some_and(|anchor|anchor.matches_path(&source)){return Err(update_admission::BUSY.into());}
            Ok(DocumentObservation{path:source.to_string_lossy().into_owned(),content:located.content,moved_images:Vec::new()})
        }).await.map_err(|_|"native_read_failed")?;
    }
    let lease=native_admission(&app,Some(window.label()))?;
    let _=(docs,anchors,recovery);
    // The owned task survives cancellation of the invoking command. It retains
    // broker serialization through real I/O and all native result bookkeeping.
    let queue=app.state::<mcp::LeafMcpBroker>().inner.queue.clone();
    update_admission::run_operation(lease,queue,move|lease|async move {
    let broker=app.state::<mcp::LeafMcpBroker>();
    lease.recheck()?;
    let moved={
        let source=app.state::<Documents>().0.lock().unwrap().get(window.label()).cloned().flatten();
        app.state::<DocumentAnchors>().0.lock().unwrap().get(window.label()).and_then(|a|a.locate().ok()).is_some_and(|located|Some(located.path)!=source)
    };
    if moved {broker.identity_boundary_with_lease(&app,window.label(),&lease).await?;}
    let handle=app.clone();let io_lease=lease.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let _lease=io_lease;_lease.recheck()?;
        observe_document_io(handle.clone(),window,handle.state::<Documents>(),handle.state::<DocumentAnchors>(),handle.state::<RecoveryState>(),loaded_images)
    }).await.map_err(|_|"native_io_failed")?
    }).await
}

fn observe_document_io(app: tauri::AppHandle, window: tauri::WebviewWindow, docs: tauri::State<Documents>, anchors: tauri::State<DocumentAnchors>, recovery: tauri::State<RecoveryState>, loaded_images: Vec<String>) -> Result<DocumentObservation, String> {
    let _guard = recovery.gate.lock().unwrap();
    let mut documents = docs.0.lock().unwrap();
    let source = documents.get(window.label()).cloned().flatten().ok_or(crate::i18n::error("main.save_the_document_first_na0010", serde_json::json!({})))?;
    let anchors = anchors.0.lock().unwrap();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let located = anchors.get(window.label()).ok_or(crate::i18n::error("main.could_not_determine_the_current_file_location", serde_json::json!({})))?.locate().map_err(|e| e.to_string())?;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let located = document_location::Located { path: source.clone(), content: fs::read_to_string(&source).map_err(|e| e.to_string())? };
    let target = fs::canonicalize(&located.path).map_err(|e| e.to_string())?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if !anchors.get(window.label()).is_some_and(|anchor| anchor.matches_path(&target)) { return Err(crate::i18n::error("main.the_original_file_could_not_be_found", serde_json::json!({})).into()); }
    let moved_images = if target != source { moved_missing_images(&source, &target, &loaded_images) } else { Vec::new() };
    if target != source {
        if documents.iter().any(|(label, path)| label != window.label() && path.as_ref() == Some(&target)) {
            return Err(crate::i18n::error("main.this_file_is_already_open_in_another", serde_json::json!({})).into());
        }
        recovery_store(&app)?.copy_for_rename(&recovery::file_key(&source), &recovery::file_key(&target), &target.to_string_lossy())?;
        documents.insert(window.label().into(), Some(target.clone()));
    }
    drop(documents);
    drop(anchors);
    drop(_guard);
    if target != source {
        if let Err(error) = app.state::<recent::Recent>().replace(&app, &source, &target) { eprintln!("Recent files: {error}"); }
    }
    Ok(DocumentObservation { path: target.to_string_lossy().into_owned(), content: located.content, moved_images })
}

// This path is supplied by an explicit user choice. An unchanged disk baseline
// is still required before the editor can treat it as the original document.
struct RelocationCandidate { path: PathBuf, content: String, anchor: Option<document_location::Anchor> }

fn verify_relocation(path: &str, expected: &str) -> Result<RelocationCandidate, String> {
    let target = fs::canonicalize(path).map_err(|e| e.to_string())?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let anchor = Some(document_location::Anchor::open(&target).map_err(|e| e.to_string())?);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let anchor: Option<document_location::Anchor> = None;
    let content = if let Some(ref anchor) = anchor {
        anchor.locate().map_err(|e| e.to_string())?.content
    } else { fs::read_to_string(&target).map_err(|e| e.to_string())? };
    if content != expected { return Err(crate::i18n::error("main.the_selected_file_differs_from_the_original", serde_json::json!({})).into()); }
    if anchor.as_ref().is_some_and(|anchor| !anchor.matches_path(&target)) {
        return Err(crate::i18n::error("main.the_selected_file_location_has_changed_select", serde_json::json!({})).into());
    }
    Ok(RelocationCandidate { path: target, content, anchor })
}

#[tauri::command(async)]
async fn relocate_document(app: tauri::AppHandle, window: tauri::WebviewWindow, docs: tauri::State<'_,Documents>, anchors: tauri::State<'_,DocumentAnchors>, recovery: tauri::State<'_,RecoveryState>, path: String, expected: String, loaded_images: Vec<String>) -> Result<DocumentObservation, String> {
    let lease=native_admission(&app,Some(window.label()))?;
    let _=(docs,anchors,recovery);
    let queue=app.state::<mcp::LeafMcpBroker>().inner.queue.clone();
    update_admission::run_operation(lease,queue,move|lease|async move {
    let broker=app.state::<mcp::LeafMcpBroker>();
    lease.recheck()?;
    broker.identity_boundary_with_lease(&app,window.label(),&lease).await?;
    let handle=app.clone();let target_window=window.clone();let io_lease=lease.clone();
    let result=tauri::async_runtime::spawn_blocking(move||{
        let _lease=io_lease;_lease.recheck()?;
        relocate_document_io(handle.clone(),target_window,handle.state::<Documents>(),handle.state::<DocumentAnchors>(),handle.state::<RecoveryState>(),path,expected,loaded_images)
    }).await.map_err(|_|"native_io_failed")?;
    if result.is_ok(){broker.saved_anchor(&app,window.label());}result
    }).await
}

fn relocate_document_io(app: tauri::AppHandle, window: tauri::WebviewWindow, docs: tauri::State<Documents>, anchors: tauri::State<DocumentAnchors>, recovery: tauri::State<RecoveryState>, path: String, expected: String, loaded_images: Vec<String>) -> Result<DocumentObservation, String> {
    let _guard = recovery.gate.lock().unwrap();
    let mut documents = docs.0.lock().unwrap();
    let source = documents.get(window.label()).cloned().flatten().ok_or(crate::i18n::error("main.save_the_document_first_na0010", serde_json::json!({})))?;
    let candidate = verify_relocation(&path, &expected)?;
    let target = &candidate.path;
    if documents.iter().any(|(label, open)| label != window.label() && open.as_ref() == Some(target)) {
        return Err(crate::i18n::error("main.this_file_is_already_open_in_another_na0029", serde_json::json!({})).into());
    }
    if candidate.anchor.as_ref().is_some_and(|anchor| !anchor.matches_path(target)) {
        return Err(crate::i18n::error("main.the_selected_file_location_has_changed_select", serde_json::json!({})).into());
    }
    let moved_images = if target != &source { moved_missing_images(&source, target, &loaded_images) } else { Vec::new() };
    if target != &source {
        recovery_store(&app)?.copy_for_rename(&recovery::file_key(&source), &recovery::file_key(&target), &target.to_string_lossy())?;
        documents.insert(window.label().into(), Some(target.clone()));
    }
    drop(documents);
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Some(anchor) = candidate.anchor { anchors.0.lock().unwrap().insert(window.label().into(), anchor); }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = anchors;
    drop(_guard);
    if target != &source {
        if let Err(error) = app.state::<recent::Recent>().replace(&app, &source, target) { eprintln!("Recent files: {error}"); }
    }
    Ok(DocumentObservation { path: target.to_string_lossy().into_owned(), content: candidate.content, moved_images })
}

fn recovery_store(app: &tauri::AppHandle) -> Result<recovery::Store, String> {
    Ok(recovery::Store::new(application_data(&app).map_err(|e| e.to_string())?.join("recovery-v1")))
}
fn recovery_key(window: &tauri::WebviewWindow, docs: &Documents, recovery: &RecoveryState) -> String {
    if let Some(Some(path)) = docs.0.lock().unwrap().get(window.label()) { return recovery::file_key(path); }
    recovery.drafts.lock().unwrap().entry(window.label().into()).or_insert_with(recovery::draft_key).clone()
}
fn retention_days(app: &tauri::AppHandle) -> Result<u32,String> {
    let path=application_data(&app).map_err(|e|e.to_string())?.join("recovery-retention.json");
    let days:u32=match fs::read(path) {Ok(bytes)=>serde_json::from_slice(&bytes).map_err(|e|crate::i18n::error("main.could_not_read_the_recovery_retention_setting", serde_json::json!({"error": (e).to_string()})))?,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>30,Err(e)=>return Err(e.to_string())};
    if ![7,30,90].contains(&days){return Err(crate::i18n::error("main.invalid_recovery_retention_period", serde_json::json!({})).into());}Ok(days)
}
#[tauri::command(async)]
fn recovery_retention(app:tauri::AppHandle,recovery:tauri::State<RecoveryState>,days:Option<u32>)->Result<u32,String>{
    let _lease=if days.is_some(){Some(native_admission(&app,None)?)}else{None};
    let _guard=recovery.gate.lock().unwrap();
    if let Some(days)=days {
        if ![7,30,90].contains(&days){return Err(crate::i18n::error("main.invalid_recovery_retention_period", serde_json::json!({})).into());}
        let root=application_data(&app).map_err(|e|e.to_string())?;fs::create_dir_all(&root).map_err(|e|e.to_string())?;
        let mut temp=tempfile::NamedTempFile::new_in(&root).map_err(|e|e.to_string())?;
        temp.write_all(days.to_string().as_bytes()).map_err(|e|e.to_string())?;temp.as_file().sync_all().map_err(|e|e.to_string())?;
        temp.persist(root.join("recovery-retention.json")).map_err(|e|e.to_string())?;
        let _=app.emit("leaf-retention-days",days);
    }
    retention_days(&app)
}
#[tauri::command(async)]
fn recovery_expire(app:tauri::AppHandle,recovery:tauri::State<RecoveryState>,docs:tauri::State<Documents>)->Result<usize,String>{
    let lease=match native_admission(&app,None){Ok(lease)=>lease,Err(error) if error==update_admission::BUSY=>return Ok(0),Err(error)=>return Err(error)};
    let _guard=recovery.gate.lock().unwrap();
    let mut active:Vec<String>=docs.0.lock().unwrap().values().filter_map(|path|path.as_ref().map(|p|recovery::file_key(p))).collect();
    active.extend(recovery.drafts.lock().unwrap().values().cloned());
    let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e|e.to_string())?.as_millis() as u64;
    recovery::with_admission(&lease,||recovery_store(&app)?.expire(retention_days(&app)?,now,&active))
}
#[tauri::command]
fn recovery_initial(window: tauri::WebviewWindow, recovery: tauri::State<RecoveryState>) -> Option<String> {
    recovery.initial.lock().unwrap().remove(window.label())
}
#[tauri::command(async)]
async fn recovery_checkpoint(app: tauri::AppHandle, window: tauri::WebviewWindow, docs: tauri::State<'_,Documents>, recovery: tauri::State<'_,RecoveryState>, content: String, preserve: Option<bool>, prepare_id:Option<update_coordinator::PrepareId>) -> Result<(), String> {
    #[cfg(feature="native-smoke")]
    update_test_driver::observe_save_attempt(&app,window.label());
    let _=(docs,recovery);
    app.state::<update_coordinator::UpdateCoordinator>().validate_declared_save(window.label(),prepare_id.as_ref())?;
    if app.state::<AdmissionRegistry>().has_renderer_fence(window.label()){
        app.state::<mcp::LeafMcpBroker>().reconcile_native_checkpoint(&app,window.label(),&content).await?;
    }
    let (lease,prepare_id)=app.state::<update_coordinator::UpdateCoordinator>().admit_declared_save(&app.state::<AdmissionRegistry>(),window.label(),SaveOperation::Checkpoint,prepare_id.as_ref())?;
    tauri::async_runtime::spawn_blocking(move||{
        recovery_checkpoint_io(app.clone(),window,app.state::<Documents>(),app.state::<RecoveryState>(),content,preserve,lease,prepare_id)
    }).await.map_err(|_|"native_checkpoint_failed")?
}
fn recovery_checkpoint_io(app:tauri::AppHandle,window:tauri::WebviewWindow,docs:tauri::State<Documents>,recovery:tauri::State<RecoveryState>,content:String,preserve:Option<bool>,lease:OperationLease,prepare_id:Option<update_coordinator::PrepareId>)->Result<(),String>{
    lease.recheck()?;
    if verified_window_role(window.app_handle(),window.label())!=WindowRole::Document { return Err(crate::i18n::error("main.open_or_create_a_document_first", serde_json::json!({})).into()); }
    let _guard = recovery.gate.lock().unwrap();
    let key = recovery_key(&window, &docs, &recovery);
    let source = docs.0.lock().unwrap().get(window.label()).and_then(|p| p.as_ref()).map(|p| p.to_string_lossy().into_owned());
    let owner = recovery.drafts.lock().unwrap().entry(window.label().into()).or_insert_with(recovery::draft_key).clone();
    #[cfg(feature="native-smoke")]
    update_test_driver::pause_io(&app,"recovery")?;
    app.state::<update_coordinator::UpdateCoordinator>().validate_declared_save(window.label(),prepare_id.as_ref())?;
    recovery::with_admission(&lease,||{
        app.state::<OpenBuffers>().0.lock().unwrap().insert(window.label().into(),content.clone());
        recovery_store(&app)?.checkpoint(&key,source,&content,&owner,preserve.unwrap_or(false))
    })
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
    let lease=native_admission(&app,Some(window.label()))?;
    let _guard = recovery.gate.lock().unwrap();
    for (label, path) in docs.0.lock().unwrap().iter() {
        if label == window.label() { continue; }
        let other = path.as_ref().map(|p| recovery::file_key(p)).or_else(|| recovery.drafts.lock().unwrap().get(label).cloned());
        if other.as_ref() == Some(&key) { return Err(crate::i18n::error("main.this_document_is_being_edited_in_another", serde_json::json!({})).into()); }
    }
    recovery::with_admission(&lease,||recovery_store(&app)?.delete_entry(&key,&id))
}
#[tauri::command(async)]
fn recovery_open(app: tauri::AppHandle, recovery: tauri::State<RecoveryState>, key: String, id: String) -> Result<(), String> {
    let _lease=native_admission(&app,None)?;
    let content = {
        let _guard = recovery.gate.lock().unwrap();
        recovery_store(&app)?.content(&key, &id)?
    };
    // Orphan drafts always open as a new unsaved document, never bind silently
    // to the old disk path (which may have changed since the crash).
    create_document(app, None, Some(content), None)
}
#[tauri::command]
fn finish_title_rename(window:tauri::WebviewWindow,error:Option<String>)->Result<(),String>{
    #[cfg(target_os="macos")]
    {let error=error.map(|value|i18n::app_error(window.app_handle(),&value));let label=window.label().to_owned();window.run_on_main_thread(move||unsafe{native_title::finish_for(&label,error.as_deref())}).map_err(|e|e.to_string())?;}
    Ok(())
}
fn validate_file_name(name: &str) -> Result<(),String> {
    if name.trim().is_empty() || name=="." || name==".." || name.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c)) || name.ends_with([' ','.']) {
        return Err(crate::i18n::error("main.file_names_cannot_contain_path_separators_or", serde_json::json!({})).into());
    }
    Ok(())
}
fn rename_file(source: &std::path::Path, name: &str, expected: &str) -> Result<PathBuf,String> {
    validate_file_name(name)?;
    let target=source.with_file_name(name);
    if target==source { return Ok(target); }
    if fs::read_to_string(source).map_err(|e|e.to_string())?!=expected { return Err(crate::i18n::error("main.the_file_was_changed_by_another_application", serde_json::json!({})).into()); }
    #[cfg(target_os="macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        unsafe extern "C" { fn renamex_np(from:*const std::ffi::c_char,to:*const std::ffi::c_char,flags:u32)->i32; }
        let from=std::ffi::CString::new(source.as_os_str().as_bytes()).map_err(|e|e.to_string())?;
        let to=std::ffi::CString::new(target.as_os_str().as_bytes()).map_err(|e|e.to_string())?;
        if unsafe{renamex_np(from.as_ptr(),to.as_ptr(),4)}!=0 {return Err(crate::i18n::error("main.could_not_rename_the_file_existing_files", serde_json::json!({"error": (std::io::Error::last_os_error()).to_string()})));}
    }
    #[cfg(not(target_os="macos"))]
    {
        fs::hard_link(source,&target).map_err(|e|crate::i18n::error("main.could_not_rename_the_file_existing_files_na0036", serde_json::json!({"error": (e).to_string()})))?;
        if let Err(e)=fs::remove_file(source) {let _=fs::remove_file(&target);return Err(e.to_string());}
    }
    Ok(target)
}
#[derive(serde::Serialize)]
struct ResourceWrite { path: String, content: String, mappings: Vec<(String,String)>, warning: Option<String> }
#[tauri::command(async)]
async fn rename_document(app:tauri::AppHandle,window:tauri::WebviewWindow,docs:tauri::State<'_,Documents>,anchors:tauri::State<'_,DocumentAnchors>,recovery:tauri::State<'_,RecoveryState>,path:String,name:String,expected:String,content:String)->Result<ResourceWrite,String>{
    let lease=native_admission(&app,Some(window.label()))?;
    let _=(docs,anchors,recovery);
    let queue=app.state::<mcp::LeafMcpBroker>().inner.queue.clone();
    update_admission::run_operation(lease,queue,move|lease|async move {
    let broker=app.state::<mcp::LeafMcpBroker>();
    lease.recheck()?;
    broker.identity_boundary_with_lease(&app,window.label(),&lease).await?;
    let handle=app.clone();let target_window=window.clone();let io_lease=lease.clone();
    let result=tauri::async_runtime::spawn_blocking(move||{
        let _lease=io_lease;_lease.recheck()?;
        rename_document_io(handle.clone(),target_window,handle.state::<Documents>(),handle.state::<DocumentAnchors>(),handle.state::<RecoveryState>(),path,name,expected,content)
    }).await.map_err(|_|"native_io_failed")?;
    if result.is_ok(){broker.saved_anchor(&app,window.label());}result
    }).await
}

fn rename_document_io(app:tauri::AppHandle,window:tauri::WebviewWindow,docs:tauri::State<Documents>,anchors:tauri::State<DocumentAnchors>,recovery:tauri::State<RecoveryState>,path:String,name:String,expected:String,content:String)->Result<ResourceWrite,String>{
    let _guard=recovery.gate.lock().unwrap();
    let mut documents=docs.0.lock().unwrap();
    let source=documents.get(window.label()).cloned().flatten().ok_or(crate::i18n::error("main.save_the_document_first_na0010", serde_json::json!({})))?;
    if source!=PathBuf::from(path) {return Err(crate::i18n::error("main.the_document_path_has_changed_try_again", serde_json::json!({})).into());}
    if !anchor_matches(&anchors, window.label(), &source) { return Err(crate::i18n::error("main.the_original_file_could_not_be_found_na0038", serde_json::json!({})).into()); }
    validate_file_name(&name)?;
    let target=source.with_file_name(&name);
    if documents.iter().any(|(label,p)|label!=window.label()&&p.as_ref()==Some(&target)){return Err(crate::i18n::error("main.this_file_is_already_open_in_another", serde_json::json!({})).into());}
    if target!=source && target.exists(){return Err(crate::i18n::error("main.a_file_with_this_name_already_exists_na0039", serde_json::json!({})).into());}
    let store=recovery_store(&app)?;
    store.copy_for_rename(&recovery::file_key(&source),&recovery::file_key(&target),&target.to_string_lossy())?;
    let (_,mappings)=resources::rehome(&source,&target,&format!("{expected}\n{content}"))?;
    let rewritten=resources::rewrite_paths(&expected,&mappings);
    let target=rename_file(&source,&name,&expected)?;
    let replaced = if rewritten!=expected {
        #[cfg(target_os = "windows")]
        let old_token = release_anchor(&anchors, window.label());
        match atomic_save(target.to_str().ok_or(crate::i18n::error("main.invalid_file_path", serde_json::json!({})))?,&rewritten,Some(expected.clone())) {
            Ok(file) => Some(file),
            Err(error) => {
                let rolled_back = rename_file(&target,source.file_name().and_then(|s|s.to_str()).ok_or(crate::i18n::error("main.invalid_file_name", serde_json::json!({})))?,&expected).is_ok();
                #[cfg(target_os = "windows")]
                if rolled_back { restore_anchor(&anchors, window.label(), &source, old_token); }
                #[cfg(not(target_os = "windows"))]
                let _ = rolled_back;
                return Err(error);
            }
        }
    } else { None };
    documents.insert(window.label().into(),Some(target.clone()));
    drop(documents);
    if let Some(file) = replaced { rebind_anchor(&anchors, window.label(), file); }
    else {
        // Windows may retain the deleted hard-link name on the old handle.
        // Track the surviving name through a fresh handle on both platforms.
        let anchor = document_location::Anchor::open(&target).map_err(|e| e.to_string())?;
        anchors.0.lock().unwrap().insert(window.label().into(), anchor);
    }
    drop(_guard);
    if let Err(error) = app.state::<recent::Recent>().replace(&app, &source, &target) { eprintln!("Recent files: {error}"); }
    Ok(ResourceWrite {path:target.to_string_lossy().into_owned(),content:rewritten,mappings,warning:None})
}
#[tauri::command(async)]
fn export_bundle(window:tauri::WebviewWindow,docs:tauri::State<Documents>,directory:String,content:String,resources:Vec<String>)->Result<String,String> {
    let _lease=native_admission(window.app_handle(),Some(window.label()))?;
    let source=docs.0.lock().unwrap().get(window.label()).cloned().flatten().ok_or(crate::i18n::error("main.save_the_document_first_na0010", serde_json::json!({})))?;
    resources::export_bundle_localized(&source,std::path::Path::new(&directory),&content,&resources,&window.app_handle().state::<i18n::Language>().current()).map(|p|p.to_string_lossy().into_owned())
}
#[tauri::command(async)]
async fn write_document(app: tauri::AppHandle, window: tauri::WebviewWindow, docs: tauri::State<'_,Documents>, anchors: tauri::State<'_,DocumentAnchors>, recovery: tauri::State<'_,RecoveryState>, path: String, content: String, expected: Option<String>, resources: Vec<String>, save_binding: Option<serde_json::Value>, prepare_id:Option<update_coordinator::PrepareId>) -> Result<ResourceWrite, String> {
    #[cfg(feature="native-smoke")]
    update_test_driver::observe_save_attempt(&app,window.label());
    app.state::<update_coordinator::UpdateCoordinator>().validate_declared_save(window.label(),prepare_id.as_ref())?;
    if app.state::<AdmissionRegistry>().has_renderer_fence(window.label()){
        app.state::<mcp::LeafMcpBroker>().reconcile_native_save(&app,window.label(),save_binding.as_ref(),&content).await?;
    }
    let (lease,prepare_id)=app.state::<update_coordinator::UpdateCoordinator>().admit_declared_save(&app.state::<AdmissionRegistry>(),window.label(),SaveOperation::Write,prepare_id.as_ref())?;
    let _=(docs,anchors,recovery);
    let queue=app.state::<mcp::LeafMcpBroker>().inner.queue.clone();
    update_admission::run_operation(lease,queue,move|lease|async move {
    let broker=app.state::<mcp::LeafMcpBroker>();
    lease.recheck()?;
    let bound=if let Some(binding)=save_binding {
        let d=broker.window_binding(window.label()).filter(|d|binding["session_id"]==d.session_id && binding["document_id"]==d.document_id).ok_or("stale_save_session")?;
        let snapshot=broker.bridge(&app,window.label(),"snapshot",serde_json::json!({})).await?;
        if binding["revision"]!=snapshot["revision"] || snapshot["content"].as_str()!=Some(content.replace("\r\n","\n").as_str()) {return Err("stale_save_snapshot".into());}
        Some((d.session_id,binding["revision"].as_u64().ok_or("save_revision")?))
    }else{None};
    lease.recheck()?;
    let target=fs::canonicalize(&path).unwrap_or_else(|_|PathBuf::from(&path));
    let changed=app.state::<Documents>().0.lock().unwrap().get(window.label()).cloned().flatten().as_ref()!=Some(&target);
    if changed {broker.identity_boundary_with_lease(&app,window.label(),&lease).await?;}
    app.state::<update_coordinator::UpdateCoordinator>().validate_declared_save(window.label(),prepare_id.as_ref())?;
    let handle=app.clone();let target_window=window.clone();let io_lease=lease.clone();let io_prepare=prepare_id.clone();
    let result=tauri::async_runtime::spawn_blocking(move||{
        let _lease=io_lease;_lease.recheck()?;
        handle.state::<update_coordinator::UpdateCoordinator>().validate_declared_save(target_window.label(),io_prepare.as_ref())?;
        write_document_io(handle.clone(),target_window,handle.state::<Documents>(),handle.state::<DocumentAnchors>(),handle.state::<RecoveryState>(),path,content,expected,resources)
    }).await.map_err(|_|"native_io_failed")?;
    if let Ok(saved)=&result {
        broker.saved_anchor(&app,window.label());
        if let (Some(id),Some((_,revision)),Some(binding))=(&prepare_id,&bound,broker.window_binding(window.label())){
            if let Some(nonce)=app.state::<AdmissionRegistry>().snapshot().instances.get(window.label()).copied(){
                let digest=mcp::source_digest(&saved.content.replace("\r\n","\n"));
                let anchor=app.state::<DocumentAnchors>().0.lock().unwrap().get(window.label()).map(|anchor|anchor.token());
                if let Some(anchor)=anchor{app.state::<update_coordinator::UpdateCoordinator>().record_native_write_for(id,window.label(),
                    update_coordinator::ParticipantIdentity{window_nonce:nonce,document_id:binding.document_id,session_id:binding.session_id,
                        authorization_epoch:binding.authorization_epoch,revision:*revision,content_digest:digest.clone()},
                    PathBuf::from(&saved.path),digest,*revision,anchor);}
            }
        }
        if let Some((session,revision))=&bound {broker.disk_result(session,*revision,Some(&mcp::source_digest(&saved.content.replace("\r\n","\n"))),false,true)?;}
    }else if let Some((session,revision))=&bound {
        broker.disk_result(session,*revision,None,true,true)?;
        if let Some(mut d)=broker.window_binding(window.label()){broker.finalize(&app,&mut d).await?;}
    }result
    }).await
}

fn write_document_io(app: tauri::AppHandle, window: tauri::WebviewWindow, docs: tauri::State<Documents>, anchors: tauri::State<DocumentAnchors>, recovery: tauri::State<RecoveryState>, path: String, content: String, expected: Option<String>, resources: Vec<String>) -> Result<ResourceWrite, String> {
    if verified_window_role(window.app_handle(),window.label())!=WindowRole::Document { return Err(crate::i18n::error("main.open_or_create_a_document_first", serde_json::json!({})).into()); }
    let _guard = recovery.gate.lock().unwrap();
    let old_key = recovery_key(&window, &docs, &recovery);
    let target = match fs::canonicalize(&path) {
        Ok(path) => path,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let path = PathBuf::from(&path);
            fs::canonicalize(path.parent().ok_or(crate::i18n::error("main.could_not_determine_the_save_folder", serde_json::json!({})))?).map_err(|e| e.to_string())?.join(path.file_name().ok_or(crate::i18n::error("main.invalid_file_name_na0043", serde_json::json!({})))?)
        }
        Err(e) => return Err(e.to_string()),
    };
    let mut documents = docs.0.lock().unwrap();
    if documents.iter().any(|(label, p)| label != window.label() && p.as_ref() == Some(&target)) { return Err(crate::i18n::error("main.the_destination_file_is_already_open_in", serde_json::json!({})).into()); }
    if documents.get(window.label()).and_then(|p| p.as_ref()) == Some(&target)
        && !anchor_matches(&anchors, window.label(), &target) {
        return Err(crate::i18n::error("main.the_original_file_could_not_be_found_na0038", serde_json::json!({})).into());
    }
    let (content,mappings)=if let Some(source)=documents.get(window.label()).and_then(|p|p.as_ref()).filter(|p|*p!=&target) {
        resources::copy_references(source,&target,&resources)?;
        resources::rehome(source,&target,&content)?
    } else { (content,Vec::new()) };
    let target_string = target.to_str().ok_or(crate::i18n::error("main.the_file_path_is_not_valid_utf", serde_json::json!({})))?;
    let key = recovery::file_key(&target);
    let store = recovery_store(&app)?;
    // If the local history cannot be protected, do not silently overwrite disk.
    store.before_save(&key, target_string.into(), expected.as_deref())?;
    let image_store = application_data(&app).map_err(|e| e.to_string())?.join("removed-images-v1");
    resources::restore_references(&image_store, &target, &content)?;
    let mut previous = expected.clone();
    // Seed cleanup from this exact file's retained history, so a removal
    // skipped by an older version can still be completed on the next save.
    if let Ok(record)=store.read(&key) {
        let text=previous.get_or_insert_with(String::new);
        for version in record.versions { text.push('\n'); text.push_str(&version.content); }
    }
    let mut cleanup_warning=None;
    #[cfg(target_os = "windows")]
    let old_token = if documents.get(window.label()).and_then(|p| p.as_ref()) == Some(&target) {
        release_anchor(&anchors, window.label())
    } else { None };
    let saved_file = match atomic_save(target_string, &content, expected) {
        Ok(file) => file,
        Err(error) => {
            #[cfg(target_os = "windows")]
            restore_anchor(&anchors, window.label(), &target, old_token);
            return Err(error);
        }
    };
    let buffers: Vec<String> = app.state::<OpenBuffers>().0.lock().unwrap().iter().filter(|(label,_)| label.as_str()!=window.label()).map(|(_,content)|content.clone()).collect();
    if let Some(before) = previous {
        if let Err(error) = resources::collect_removed_protected(&image_store, &target, &before, &content, &buffers) { cleanup_warning=Some(crate::i18n::error("main.the_document_was_saved_but_unused_images", serde_json::json!({"error": (error).to_string()}))); }
    }
    documents.insert(window.label().to_owned(), Some(target.clone()));
    drop(documents);
    refresh_reveal_menu_on_main(&app);
    rebind_anchor(&anchors, window.label(), saved_file);
    // Disk is already saved. A cleanup failure must not be reported as a failed
    // write, since that would leave the editor's comparison baseline stale.
    if let Err(error) = store.saved(&old_key, &content) { eprintln!("Recovery cleanup: {error}"); }
    if key != old_key { if let Err(error) = store.saved(&key, &content) { eprintln!("Recovery cleanup: {error}"); } }
    drop(_guard);
    if let Err(error) = app.state::<recent::Recent>().remember(&app, &target) { eprintln!("Recent files: {error}"); }
    Ok(ResourceWrite {path:target.to_string_lossy().into_owned(),content,mappings,warning:cleanup_warning})
}

fn rebind_anchor(anchors: &DocumentAnchors, label: &str, file: fs::File) {
    let mut bound = anchors.0.lock().unwrap();
    match document_location::Anchor::from_file(file) {
        Ok(anchor) => { bound.insert(label.into(), anchor); }
        Err(error) => { bound.remove(label); eprintln!("Document tracking unavailable after save: {error}"); }
    }
}

fn atomic_save(path: &str, content: &str, expected: Option<String>) -> Result<fs::File, String> {
    let target = PathBuf::from(&path);
    // Compare immediately before writing; do not overwrite an external edit silently.
    let current = match fs::read_to_string(&target) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    if current != expected { return Err(crate::i18n::error("main.the_file_was_changed_by_another_application_na0047", serde_json::json!({})).into()); }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let original_identity = if current.is_some() {
        Some(document_location::Anchor::open(&target).map_err(|e| e.to_string())?.token())
    } else { None };
    let parent = target.parent().ok_or(crate::i18n::error("main.could_not_determine_the_save_folder", serde_json::json!({})))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    if let Ok(meta) = fs::metadata(&target) {
        if meta.permissions().readonly() { return Err(crate::i18n::error("main.the_file_is_read_only_use_save", serde_json::json!({})).into()); }
        temp.as_file().set_permissions(meta.permissions()).map_err(|e| e.to_string())?;
    }
    temp.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    #[cfg(feature="native-smoke")]
    update_test_driver::pause_write(&target)?;
    // Recheck after preparing the temporary file, reducing the external-write race.
    let latest = match fs::read_to_string(&target) { Ok(text) => Some(text), Err(e) if e.kind() == std::io::ErrorKind::NotFound => None, Err(e) => return Err(e.to_string()) };
    if latest != current { return Err(crate::i18n::error("main.the_file_was_changed_by_another_application_na0049", serde_json::json!({})).into()); }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Some(token) = original_identity {
        if document_location::Anchor::open(&target).map_err(|e| e.to_string())?.token() != token {
            return Err(crate::i18n::error("main.the_file_location_changed_while_saving_locate", serde_json::json!({})).into());
        }
    }
    if expected.is_none() {
        temp.persist_noclobber(&target).map_err(|e| if e.error.kind() == std::io::ErrorKind::AlreadyExists {
            crate::i18n::error("main.a_file_with_this_name_already_exists_na0051", serde_json::json!({})).into()
        } else { e.to_string() })
    } else {
        temp.persist(&target).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn moved_image_reason_requires_a_previously_loaded_file_left_behind() {
        let root = tempfile::tempdir().unwrap();
        let before = root.path().join("before");
        let after = root.path().join("after");
        fs::create_dir_all(before.join("assets")).unwrap();
        fs::create_dir_all(after.join("assets")).unwrap();
        let old_doc = before.join("note.md");
        let new_doc = after.join("note.md");
        fs::write(&new_doc, "![photo](assets/photo.png)").unwrap();
        fs::write(before.join("assets/photo.png"), b"picture").unwrap();
        let loaded = vec!["assets/photo.png".into(), "assets/never.png".into(), "../private.png".into()];
        assert_eq!(moved_missing_images(&old_doc, &new_doc, &loaded), vec!["assets/photo.png"]);
        fs::write(after.join("assets/photo.png"), b"destination picture").unwrap();
        assert!(moved_missing_images(&old_doc, &new_doc, &loaded).is_empty());
        fs::remove_file(after.join("assets/photo.png")).unwrap();
        fs::remove_file(before.join("assets/photo.png")).unwrap();
        assert!(moved_missing_images(&old_doc, &new_doc, &loaded).is_empty());
        assert_eq!(fs::read_to_string(&new_doc).unwrap(), "![photo](assets/photo.png)");
        assert!(!before.join("note.md").exists());
    }

    #[test]
    fn same_folder_rename_does_not_claim_document_moved_away_from_images() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("photo.png"), b"picture").unwrap();
        assert!(moved_missing_images(&root.path().join("old.md"), &root.path().join("new.md"), &["photo.png".into()]).is_empty());
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn saving_rebinds_the_identity_used_for_later_external_renames() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("draft.md");
        fs::write(&path, "first").unwrap();
        let anchors = DocumentAnchors::default();
        anchors.0.lock().unwrap().insert("document-test".into(), document_location::Anchor::open(&path).unwrap());
        #[cfg(target_os = "windows")]
        let original = release_anchor(&anchors, "document-test");
        let saved = atomic_save(path.to_str().unwrap(), "second", Some("first".into())).unwrap();
        #[cfg(target_os = "windows")]
        assert!(original.is_some());
        #[cfg(not(target_os = "windows"))]
        assert!(!anchor_matches(&anchors, "document-test", &path));
        rebind_anchor(&anchors, "document-test", saved);
        assert!(anchor_matches(&anchors, "document-test", &path));
        let renamed = dir.path().join("renamed.md");
        fs::rename(&path, &renamed).unwrap();
        assert_eq!(anchors.0.lock().unwrap()["document-test"].locate().unwrap().path, fs::canonicalize(renamed).unwrap());
    }
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
        assert!(document_arguments(vec!["Leaf".into(),"--leaf-update-reconcile".into(),"plan.md".into(),"digest.md".into(),"transaction.md".into()],&cwd).is_empty());
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
    fn explicit_relocation_requires_the_original_disk_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chosen.md");
        fs::write(&path, "different document").unwrap();
        let selected = path.to_str().unwrap();
        assert!(verify_relocation(selected, "original baseline").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "different document");
        fs::write(&path, "original baseline").unwrap();
        let verified = verify_relocation(selected, "original baseline").unwrap();
        assert_eq!(verified.path, fs::canonicalize(&path).unwrap());
        assert_eq!(verified.content, "original baseline");
    }
    #[test]
    fn creating_a_new_save_never_replaces_a_same_name_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("existing.md");
        fs::write(&path, "someone else's file").unwrap();
        assert!(atomic_save(path.to_str().unwrap(), "my edits", None).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "someone else's file");
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

#[cfg(target_os = "macos")]
const DEVELOPMENT_STORE: [u8; 16] = *b"leaf-dev-store01";

fn configure_development(config: &mut tauri::utils::config::Config) {
    if config.identifier != "studio.leaf.editor.dev" { return; }
    // The pinned Tauri code generator emits a Vec for this array field, and
    // automatic window construction omits it. Build dev startup windows
    // explicitly with the builder API, as we do for document/PDF windows.
    #[cfg(target_os = "macos")]
    for window in &mut config.app.windows {
        window.data_store_identifier = Some(DEVELOPMENT_STORE);
        window.create = false;
    }
}

fn development_window<'a>(app: &tauri::AppHandle, builder: tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>) -> tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle> {
    #[cfg(feature="native-smoke")]
    if update_test_driver::enabled() {
        #[cfg(target_os="macos")]
        if update_preservation_test_driver::enabled(){return builder.title("Leaf Preservation Test").incognito(false).data_store_identifier(update_preservation_test_driver::store_id().expect("isolated persistent fixture store"));}
        let builder=builder.title("Leaf Update Test").incognito(true);
        #[cfg(target_os="macos")]
        let builder=builder.data_store_identifier([37;16]);
        return builder;
    }
    #[cfg(all(feature="native-smoke",target_os="macos"))]
    if mcp_test_driver::enabled(app) {return builder.title("Leaf MCP Test").incognito(true).data_store_identifier(app.config().app.windows[0].data_store_identifier.unwrap());}
    if app.config().identifier != "studio.leaf.editor.dev" { return builder; }
    let builder = builder.title("Leaf Dev");
    // Dynamic document and PDF windows must use the same isolated store as
    // the launcher, rather than WKWebView's default production store.
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(DEVELOPMENT_STORE);
    builder
}

mod chatgpt_tunnel;
mod tunnel_proxy;
fn main() {
    crate::leaf_update_binary_identity!("leaf");
    #[cfg(all(target_os="macos",feature="native-smoke"))]
    if update_preservation_test_driver::enabled(){
        if let Err(code)=update_preservation_test_driver::root(){eprintln!("{code}");std::process::exit(1);}
    }
    #[cfg(all(target_os="macos",feature="native-smoke"))]
    if std::env::args().nth(1).as_deref()==Some("--mac-update-fixture"){
        if let Err(code)=update_macos_test_driver::run(){eprintln!("mac_fixture_failed:{code}");std::process::exit(1);}return;
    }
    #[cfg(feature="native-smoke")]
    {update_test_driver::service_probe();update_test_driver::official_probe();}
    if std::env::args().nth(1).as_deref()==Some("--leaf-build-identity") {println!("{}",mcp::ai_credentials::native_build_identity());return;}
    #[cfg(feature="native-smoke")]
    if std::env::var("LEAF_MCP_TEST_PROCESS_ROLE").ok().as_deref()==Some("chatgpt-tunnel-fixture") {
        std::process::exit(chatgpt_tunnel::synthetic_fixture_main());
    }
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    configure_development(context.config_mut());
    #[cfg(feature="native-smoke")]
    update_test_driver::configure(context.config_mut());
    #[cfg(feature = "native-smoke")]
    mcp_test_driver::configure(context.config_mut());
    #[cfg(all(target_os = "windows", feature = "native-smoke"))]
    for window in &mut context.config_mut().app.windows {
        window.additional_browser_args = Some(native_smoke_browser_args());
    }
    let builder = tauri::Builder::default();
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        open_windows_arguments(app, args, &cwd);
    }));
    #[cfg(target_os = "macos")]
    let builder = builder.manage(OpenRequests::default());
    let update_trust=context.config().plugins.0.get("leafUpdater").cloned().unwrap_or(serde_json::Value::Null);
    let builder=builder.manage(updates::Updates::with_trust_config(update_trust)).manage(Mutex::new(window_role::OrdinaryQuit::default()));
    #[cfg(all(any(target_os="macos",target_os="windows"),feature="legacy-updater-tests"))]
    let builder=builder.manage(update_install_gui::Handoff::default());
    #[cfg(feature="native-smoke")]
    let builder=builder.manage(update_test_driver::Driver::default());
    builder.manage(update_coordinator::UpdateCoordinator::default()).manage(AdmissionRegistry::default()).manage(mcp::LeafMcpBroker::default()).manage(OpenBuffers::default()).manage(Documents::default()).manage(DocumentAnchors::default()).manage(Exports::default()).manage(RecoveryState::default()).manage(MenuFocus::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler({
            let production: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> = Box::new(tauri::generate_handler![update_coordinator::update_close_disposition,update_coordinator::update_close_complete,ordinary_quit_cancelled,updates::update_status,updates::update_check,updates::update_close,updates::update_open_releases,updates::update_open_download,i18n::language_get, i18n::language_set, recovery_retention, recovery_expire, import_attachment, reveal_document, reveal_resource, export_bundle, read_resource, observe_document, relocate_document, copy_pasted_images, open_link, initial_path, new_document, open_document, read_document, write_document, rename_document, finish_title_rename, open_export, export_snapshot, print_export, show_comment_context, recovery_initial, recovery_checkpoint, recovery_list, recovery_read, recovery_delete, recovery_open, recent::recent_list, recent::recent_import, recent::recent_clear_missing, recent::recent_open]);
            move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
                let role=verified_window_role(invoke.message.webview_ref().app_handle(),invoke.message.webview_ref().label());
                let allowed=window_role::allows_command(role,invoke.message.command())
                    || (role==WindowRole::Document&&matches!(invoke.message.command(),"update_close_disposition"|"update_close_complete"));
                #[cfg(feature="native-smoke")]
                let allowed=allowed || (update_test_driver::enabled() && matches!(invoke.message.command(),"update_test_observe"|"update_test_role_report"|"update_test_prepare_mode"|"update_test_prepare_select"));
                if !allowed {invoke.resolver.reject("window_role_denied");return true;}
                if invoke.message.command().starts_with("mcp_") && !invoke.message.command().starts_with("mcp_test_") {
                    let mcp: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> = Box::new(tauri::generate_handler![mcp::mcp_register, mcp::mcp_authorize, mcp::mcp_retire_authorization, mcp::mcp_renderer_reply, mcp::mcp_profiles, mcp::mcp_configure_client, mcp::mcp_enable_client, mcp::mcp_revoke_client, mcp::mcp_set_enabled, mcp::mcp_export_stdio,mcp::mcp_add_client, mcp::mcp_stop_edit, mcp::mcp_save_result, mcp_document_boundary,mcp::mcp_tunnel_status,mcp::mcp_configure_tunnel,mcp::mcp_start_tunnel,mcp::mcp_stop_tunnel]);
                    if invoke.message.command()=="mcp_connection_platform" {
                        let platform: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> = Box::new(tauri::generate_handler![mcp::mcp_connection_platform]);
                        return platform(invoke);
                    }
                    return mcp(invoke);
                }
                #[cfg(feature = "native-smoke")]
                if invoke.message.command().starts_with("mcp_test_") {
                    let test: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> = Box::new(tauri::generate_handler![mcp_test_driver::mcp_test_mode, mcp_test_driver::mcp_test_report, mcp_test_driver::mcp_test_run]);
                    return test(invoke);
                }
                #[cfg(feature="native-smoke")]
                if matches!(invoke.message.command(),"update_test_observe"|"update_test_role_report"|"update_test_prepare_mode"|"update_test_prepare_select") {
                    let test: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> = Box::new(tauri::generate_handler![update_test_driver::update_test_observe,update_test_driver::update_test_role_report,update_test_driver::update_test_prepare_mode,update_test_driver::update_test_prepare_select]);
                    return test(invoke);
                }
                production(invoke)
            }
        })
        .setup(|app| {
            #[cfg(all(any(target_os="macos",target_os="windows"),feature="legacy-updater-tests"))] update_install_gui::reconcile_launch(app.handle());
            let handle=app.handle().clone();
            app.state::<AdmissionRegistry>().set_reopen_hook(std::sync::Arc::new(move||{resume_os_requests(handle.clone());refresh_document_menu_on_main(&handle);}));
            app.state::<mcp::LeafMcpBroker>().initialize(app.handle()).map_err(std::io::Error::other)?;
            let handle=app.handle().clone();
            tauri::async_runtime::spawn(async move {handle.state::<mcp::LeafMcpBroker>().restore_connections(&handle).await;});
            app.manage(i18n::Language::load(application_data(app.handle())?.join("language-v1.json")));
            let recent_path = application_data(app.handle())?.join("recent-files-v1.json");
            app.manage(recent::Recent::load(recent_path));
            #[cfg(target_os = "macos")]
            native_shortcuts::install(app.handle().clone());
            use tauri::menu::{Menu, Submenu, MenuItem, PredefinedMenuItem};
            let handle = app.handle();
            let update=MenuItem::with_id(handle,"check-updates","检查更新…",true,None::<&str>)?;
            let new = MenuItem::with_id(handle, "new", "新建", true, Some("CmdOrCtrl+N"))?;
            let open = MenuItem::with_id(handle, "open", "打开…", true, Some("CmdOrCtrl+O"))?;
            let save = MenuItem::with_id(handle, "save", "保存", true, Some("CmdOrCtrl+S"))?;
            let save_as = MenuItem::with_id(handle, "save-as", "另存为…", true, Some("CmdOrCtrl+Shift+S"))?;
            let reveal_key=if cfg!(target_os="macos"){"resources.show_in_finder"}else{"native.show_in_explorer"};
            let reveal = MenuItem::with_id(handle,"reveal-document",i18n::text("zh-Hans",reveal_key),false,None::<&str>)?;
            let export = MenuItem::with_id(handle, "export-pdf", "导出 PDF…", true, Some("CmdOrCtrl+E"))?;
            let recovery_menu = MenuItem::with_id(handle, "recovery", "历史版本与草稿…", true, None::<&str>)?;
            let find = MenuItem::with_id(handle, "find", "查找与替换", true, Some("CmdOrCtrl+F"))?;
            // The native predefined Quit terminates through AppKit directly.
            // Route it through the same unsaved-document checks as window close.
            let quit = MenuItem::with_id(handle, "quit", "退出 Leaf", true, Some("CmdOrCtrl+Q"))?;
            let settings = MenuItem::with_id(handle, "settings", "设置…", true, Some("CmdOrCtrl+Alt+,"))?;
            let copy_rich = MenuItem::with_id(handle, "copy-rich", "复制为富文本", true, Some("CmdOrCtrl+Shift+C"))?;
            let paste_plain = MenuItem::with_id(handle, "paste-plain", "粘贴为纯文本", true, Some("CmdOrCtrl+T"))?;
            // Windows' predefined About does nothing when metadata is absent.
            #[cfg(target_os = "windows")]
            let about_metadata = Some(tauri::menu::AboutMetadata {
                name: Some("Leaf".into()), version: Some(env!("CARGO_PKG_VERSION").into()),
                ..Default::default()
            });
            #[cfg(not(target_os = "windows"))]
            let about_metadata = None;
            #[cfg(target_os="macos")]
            let app_menu = Submenu::with_items(handle, "Leaf", true, &[&PredefinedMenuItem::about(handle, Some("关于 Leaf"), about_metadata)?, &settings, &update, &quit])?;
            #[cfg(not(target_os="macos"))]
            let app_menu = Submenu::with_items(handle, "Leaf", true, &[&PredefinedMenuItem::about(handle, Some("关于 Leaf"), about_metadata)?, &settings, &quit])?;
            let recent_menu = Submenu::new(handle, "最近打开", true)?;
            let file = Submenu::with_items(handle, "文件", true, &[&new, &open, &recent_menu, &PredefinedMenuItem::separator(handle)?, &save, &save_as, &reveal, &PredefinedMenuItem::separator(handle)?, &recovery_menu, &export, &PredefinedMenuItem::separator(handle)?, &PredefinedMenuItem::close_window(handle, Some("关闭窗口"))?])?;
            // Undo and redo are deliberately not PredefinedMenuItem: on macOS
            // those bind Cmd-Z to the webview's native undo stack, which cannot
            // see changes the editor applies programmatically (formatting,
            // superscript, list conversion), so undo silently stops working
            // after them. Keep the standard shortcuts but route them through
            // the menu event channel into the editor's own history.
            let undo = MenuItem::with_id(handle, "undo", "撤销", true, Some("CmdOrCtrl+Z"))?;
            let redo = MenuItem::with_id(handle, "redo", "重做", true, Some("CmdOrCtrl+Shift+Z"))?;
            let cycle_mode = MenuItem::with_id(handle, "cycle-mode", "切换视图模式", true, Some("CmdOrCtrl+R"))?;
            let comment_shortcut = if cfg!(target_os="macos") { "Cmd+Alt+A" } else { "Ctrl+Alt+M" };
            let add_comment = MenuItem::with_id(handle, "add-comment", "添加批注", true, Some(comment_shortcut))?;
            let cut=MenuItem::with_id(handle,"cut","Cut",true,Some("CmdOrCtrl+X"))?;
            let paste=MenuItem::with_id(handle,"paste","Paste",true,Some("CmdOrCtrl+V"))?;
            let edit = Submenu::with_items(handle, "编辑", true, &[&undo, &redo, &cut, &PredefinedMenuItem::copy(handle, None)?, &paste, &PredefinedMenuItem::select_all(handle, None)?, &find, &copy_rich, &paste_plain, &add_comment, &cycle_mode])?;
            #[cfg(target_os="macos")]
            let menu = Menu::with_items(handle, &[&app_menu, &file, &edit])?;
            #[cfg(not(target_os="macos"))]
            let menu = {let help=Submenu::with_items(handle,"帮助",true,&[&update])?;Menu::with_items(handle,&[&app_menu,&file,&edit,&help])?};
            app.state::<i18n::Language>().attach_menu(&menu)?;
            app.set_menu(menu)?;
            #[cfg(target_os = "macos")]
            if !app.config().identifier.starts_with("studio.leaf.editor.dev") { native_services::install(app.handle().clone()); }
            app.state::<recent::Recent>().set_menu(handle, recent_menu).map_err(std::io::Error::other)?;
            #[cfg(target_os = "macos")]
            if app.config().identifier.starts_with("studio.leaf.editor.dev") {
                for config in &app.config().app.windows {
                    let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), config)?;
                    development_window(app.handle(), builder).build()?;
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if role_for_label(window.label())==WindowRole::Document {
                if let tauri::WindowEvent::CloseRequested {api,..}=event {
                    let app=window.app_handle();
                    let nonce=app.state::<AdmissionRegistry>().snapshot().instances.get(window.label()).copied();
                    let action=nonce.and_then(|nonce|app.state::<update_coordinator::UpdateCoordinator>().begin_native_close(&app.state::<AdmissionRegistry>(),window.label(),nonce).ok());
                    let Some(action)=action else{api.prevent_close();return;};
                    update_coordinator::publish_close_action(app,&action);
                    let _=app.emit_to(window.label(),"leaf-update-close-action",&action);
                    if !action.allowed{api.prevent_close();let _=app.emit("leaf-update-admission-interrupted",());return;}
                }
            }
            if window.label()==updates::LABEL {
                if let tauri::WindowEvent::CloseRequested {api,..}=event {api.prevent_close();let _=updates::hide_update_window(window.app_handle());}
                if !matches!(event,tauri::WindowEvent::Focused(_)) {return;}
            }
            #[cfg(target_os="macos")]
            if matches!(event, tauri::WindowEvent::Focused(false)|tauri::WindowEvent::Destroyed) {
                let label=window.label().to_owned();let _=window.run_on_main_thread(move||unsafe{native_title::blur(&label)});
            }
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                *window.app_handle().state::<MenuFocus>().0.lock().unwrap() = Some(window.label().into());
                refresh_document_menu(window.app_handle());
            }
            // AppKit can return focus to an open panel's parent after the document
            // has opened. Enforce the same rule on that later focus transition.
            if role_for_label(window.label())==WindowRole::Launcher && matches!(event, tauri::WindowEvent::Focused(true)) {
                let app = window.app_handle();
                if let Some(document) = document_window(app) {
                    if let Err(error) = hide_launcher(app) { eprintln!("{error}"); }
                    let _ = document.unminimize();
                    let _ = document.set_focus();
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let app=window.app_handle();let label=window.label();
                #[cfg(feature="native-smoke")] update_test_driver::coordinator_destroyed(app,label);
                match role_for_label(label) {
                    WindowRole::Document=>{
                        if let Some((id,labels))=app.state::<update_coordinator::UpdateCoordinator>().participant_lost(label){
                            update_coordinator::release(app,&id,labels,"update_prepare_disconnected");
                        }
                        app.state::<AdmissionRegistry>().document_destroyed(label);
                        let registered=app.state::<Documents>().0.lock().unwrap().remove(label).is_some();
                        if registered {
                        app.state::<mcp::LeafMcpBroker>().unregister(label);
                        app.state::<OpenBuffers>().0.lock().unwrap().remove(label);
                        app.state::<DocumentAnchors>().0.lock().unwrap().remove(label);
                        app.state::<RecoveryState>().drafts.lock().unwrap().remove(label);
                        app.state::<RecoveryState>().initial.lock().unwrap().remove(label);
                        let quit_complete=app.state::<Mutex<window_role::OrdinaryQuit>>().lock().unwrap().destroyed(label);
                        let remaining=app.state::<Documents>().0.lock().unwrap().len();
                        if quit_complete && remaining==0 {app.exit(0);}
                        else if close_auxiliary_windows(label,remaining) {last_document_closed(app);}
                        }
                    },
                    WindowRole::Export=>{app.state::<Exports>().0.lock().unwrap().remove(label);},
                    _=>{}
                }
                #[cfg(feature="native-smoke")]
                update_test_driver::notify_window_change(app);
            }
        })
        .on_menu_event(|app, event| {
            let id=event.id().as_ref();
            if !matches!(id,"check-updates"|"quit") && menu_window(app).is_none_or(|window|!matches!(verified_window_role(app,window.label()),WindowRole::Launcher|WindowRole::Document)) {return;}
            if id=="check-updates" {
                let caller=menu_window(app).map(|w|w.label().to_owned()).unwrap_or_else(||LAUNCHER.into());
                let _=dispatch_update_menu(app,&caller);
            }
            else if event.id().as_ref() == "quit" {request_ordinary_quit(app);}
            else if event.id().as_ref() == "recent-clear-missing" {
                use tauri_plugin_dialog::DialogExt;
                let message = match app.state::<recent::Recent>().clear_missing(app) {
                    Ok(count) => i18n::render(&app.state::<i18n::Language>().current(), "NA0071", &serde_json::json!({"count":count})),
                    Err(error) => i18n::render(&app.state::<i18n::Language>().current(), "NA0072", &serde_json::json!({"error":error})),
                };
                app.dialog().message(i18n::app_error(app, &message)).title("Leaf").show(|_| {});
            }
            else if let Some(id) = event.id().as_ref().strip_prefix("recent-") {
                use tauri_plugin_dialog::DialogExt;
                if let Some(entry) = app.state::<recent::Recent>().for_id(id) {
                    if let Err(error) = recent::open(app, &entry.path) {
                        app.dialog().message(i18n::render(&app.state::<i18n::Language>().current(), "NA0073", &serde_json::json!({"error":error})))
                            .title("Leaf").show(|_| {});
                    }
                }
            }
            else if event.id().as_ref() == "new" {
                let target=menu_window(app).or_else(||document_window(app)).or_else(||app.get_webview_window(LAUNCHER));
                if let Some(window)=target {let _=dispatch_document_menu(app,window.label(),"new");}
            }
            else if let Some(window) = menu_window(app) {
                let _ = dispatch_document_menu(app,window.label(),event.id().as_ref());
            }
        })
        .build(context).expect("Leaf could not start")
        .run(|app, event| match event {
            tauri::RunEvent::Ready => {
                #[cfg(feature="native-smoke")]
                update_test_driver::start(app);
                #[cfg(feature = "native-smoke")]
                if let Err(_) = mcp_test_driver::start(app) { eprintln!("MCP test startup failed"); app.exit(1); }
                #[cfg(target_os = "macos")]
                if app.state::<OpenRequests>().mark_ready() { drain_open_requests(app.clone()); }
                #[cfg(target_os = "windows")]
                let opening_document = open_windows_arguments(app, std::env::args().collect(), &std::env::current_dir().unwrap_or_default().to_string_lossy());
                // macOS can deliver a document before Tauri creates its configured
                // welcome window. Do not let that later window cover the document:
                // hide the launcher, exactly as opening a file from it does.
                let label = app.state::<Documents>().0.lock().unwrap().keys().next().cloned();
                if let Some(window) = label.and_then(|label| app.get_webview_window(&label)) {
                    if let Err(error) = hide_launcher(app) { eprintln!("{error}"); }
                    let _ = window.set_focus();
                }
                else {
                    #[cfg(target_os = "windows")]
                    if !opening_document { show_windows_launcher_if_empty(app); }
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                let paths = urls.into_iter().filter_map(|url| url.to_file_path().ok());
                if app.state::<OpenRequests>().enqueue(paths) { drain_open_requests(app.clone()); }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                focus_primary_window(app);
            }
            tauri::RunEvent::ExitRequested { api, .. } if !app.webview_windows().is_empty() => {
                let coordinator=app.state::<update_coordinator::UpdateCoordinator>();
                #[cfg(feature="legacy-updater-tests")]
                if coordinator.committed(){
                    let accepted=coordinator.take_update_exit();
                    #[cfg(feature="native-smoke")] update_test_driver::coordinator_exit_requested(app,accepted);
                    #[cfg(all(target_os="macos",feature="native-smoke"))] update_preservation_test_driver::accepted_exit(accepted);
                    if !accepted{api.prevent_exit();}
                    return;
                }
                #[cfg(feature="native-smoke")]
                if mcp_test_driver::enabled(app)||update_test_driver::enabled(){return;}
                if !app.state::<Documents>().0.lock().unwrap().is_empty() {
                    api.prevent_exit();request_ordinary_quit(app);
                }
            }
            tauri::RunEvent::Exit => {
                #[cfg(all(any(target_os="macos",target_os="windows"),feature="legacy-updater-tests"))] update_install_gui::application_exited(app);
                #[cfg(all(target_os="macos",feature="native-smoke"))] update_preservation_test_driver::exited(app);
                #[cfg(feature="native-smoke")] update_test_driver::coordinator_exited(app);
                let _=app.state::<mcp::LeafMcpBroker>().inner.tunnel.lock().unwrap().stop();
            }
            _ => {}
        });
}

#[cfg(all(target_os="macos",any(test,feature="legacy-updater-tests")))]
mod update_install_gui {
    use super::*;
    use crate::update_install::macos::{self,BundleIdentity,MacInstallPlan,NativePlatform,InstallResult,InstallState,ChannelMessage};
    use std::{io::{BufRead,Read,Write},os::unix::fs::{MetadataExt,OpenOptionsExt,PermissionsExt},process::{Child,ChildStdin,Stdio},sync::mpsc};
    #[derive(Default)]
    pub(crate) struct Handoff(Mutex<Option<ReadyHelper>>);
    struct ReadyHelper {
        child:Child,input:Option<ChildStdin>,root:Option<tempfile::TempDir>,plan:MacInstallPlan,digest:String,detached:bool,
    }
    impl Drop for ReadyHelper {
        fn drop(&mut self){if !self.detached{self.input.take();let _=self.child.kill();let _=self.child.wait();}}
    }
    impl ReadyHelper {
        fn send(&mut self,kind:&str)->Result<(),String>{
            let input=self.input.as_mut().ok_or("update_helper_channel")?;
            serde_json::to_writer(&mut *input,&macos::channel_message(kind,&self.plan,&self.digest)).map_err(|_|"update_helper_channel")?;
            input.write_all(b"\n").and_then(|_|input.flush()).map_err(|_|"update_helper_channel".into())
        }
    }
    fn write_private(path:&Path,bytes:&[u8])->Result<(),String>{
        let mut file=fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path).map_err(|_|"update_install_journal")?;
        file.write_all(bytes).and_then(|_|file.sync_all()).map_err(|_|"update_install_journal")?;
        fs::File::open(path.parent().ok_or("update_install_journal")?).and_then(|file|file.sync_all()).map_err(|_|"update_install_journal".into())
    }
    fn expected_inventory(package:&crate::update_package::VerifiedPackage)->Result<BundleIdentity,String>{
        let metadata=package.authenticated_metadata();let prefix=format!("{}/",metadata.root);let mut inventory=std::collections::BTreeMap::new();
        for entry in &metadata.inventory{
            if entry.path==metadata.root{continue;}
            let path=entry.path.strip_prefix(&prefix).ok_or("update_install_inventory")?;
            let value=match entry.kind.as_str(){"directory"=>"directory".into(),"symlink"=>format!("link:{}",entry.target.as_deref().ok_or("update_install_inventory")?),
                "file"=>entry.sha256.clone().ok_or("update_install_inventory")?,_=>return Err("update_install_inventory".into())};
            if inventory.insert(path.into(),value).is_some(){return Err("update_install_inventory".into());}
        }
        Ok(BundleIdentity{identifier:metadata.identifier.clone(),version:metadata.version.clone(),arch:metadata.arch.clone(),inventory})
    }
    fn stage_and_arm(package:std::sync::Arc<crate::update_package::VerifiedPackage>,id:update_coordinator::PrepareId,binding:update_coordinator::PackageBinding)->Result<ReadyHelper,String>{
        let target=PathBuf::from(&binding.target).canonicalize().map_err(|_|"update_target_unavailable")?;
        if target.extension().is_none_or(|extension|extension!="app"){return Err("update_target_unavailable".into());}
        let parent=target.parent().ok_or("update_target_unavailable")?;
        let bytes=package.authenticated_metadata().inventory.iter().try_fold(0u64,|sum,entry|sum.checked_add(entry.size).ok_or("update_install_capacity"))?;
        if macos::available_bytes(parent)?<bytes.saturating_add(16*1024*1024){return Err("update_install_insufficient_space".into());}
        let root=tempfile::Builder::new().prefix(".leaf-update-").permissions(fs::Permissions::from_mode(0o700)).tempdir_in(parent).map_err(|_|"update_install_target_not_writable")?;
        let staged=root.path().join("Prepared.app");
        let status=std::process::Command::new("/usr/bin/ditto").arg(package.staged_root()).arg(&staged).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_|"update_install_stage")?;
        if !status.success(){return Err("update_install_stage".into());}
        let helper=root.path().join("leaf-update-helper");
        fs::copy(staged.join("Contents/MacOS/leaf-update-helper"),&helper).map_err(|_|"update_install_helper_missing")?;
        let new=expected_inventory(&package)?;let old=macos::capture_identity(&target)?;
        if new.identifier!=binding.bundle||package.digest()!=binding.digest{return Err("update_install_package_binding".into());}
        let metadata=fs::metadata(&target).map_err(|_|"update_target_unavailable")?;
        let mut token=[0u8;32];getrandom::fill(&mut token).map_err(|_|"update_instance_entropy")?;
        let plan=MacInstallPlan{transaction:id.0,target:target.clone(),staged,helper:helper.clone(),journal:root.path().join("result.json"),
            gui_pid:std::process::id(),gui_executable:std::env::current_exe().and_then(fs::canonicalize).map_err(|_|"update_target_unavailable")?,
            target_anchor:(metadata.dev(),metadata.ino()),package_digest:binding.digest,token:token.iter().map(|byte|format!("{byte:02x}")).collect(),
            created_unix:std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|"update_install_clock")?.as_secs(),old,new};
        let path=root.path().join("plan.json");let encoded=serde_json::to_vec(&plan).map_err(|_|"update_install_plan")?;let digest=macos::hash(&encoded);
        write_private(&path,&encoded)?;write_private(&root.path().join("plan.sha256"),digest.as_bytes())?;
        // Authenticate executable code in the GUI before it can become a process.
        // The independent helper repeats this full check before acknowledging ready.
        let platform=NativePlatform{gui_executable:plan.gui_executable.clone(),plan_path:path.clone(),plan_digest:digest.clone(),transaction:plan.transaction.clone()};
        macos::check_ready(&plan,&platform)?;
        let mut command=std::process::Command::new(&helper);
        #[cfg(feature="native-smoke")]
        let preservation=crate::update_preservation_test_driver::enabled();
        #[cfg(not(feature="native-smoke"))]
        let preservation=false;
        if preservation{command.arg("--mac-update-preservation-helper");}else{command.arg("--install-plan");}
        command.arg(&path).arg(&digest);
        #[cfg(feature="native-smoke")]
        if preservation{command.arg(std::env::var("LEAF_UPDATE_PRESERVATION_SCENARIO").map_err(|_|"preservation_scenario")?);}
        let error=Stdio::null();
        #[cfg(feature="native-smoke")]
        let error=if preservation{
            use std::os::unix::fs::OpenOptionsExt;
            let path=crate::update_preservation_test_driver::root()?.join("actual-helper-stderr.log");
            Stdio::from(fs::OpenOptions::new().create_new(true).write(true).mode(0o600).open(path).map_err(|_|"preservation_helper_log")?)
        }else{error};
        let mut child=command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(error).spawn().map_err(|_|"update_helper_start")?;
        let input=child.stdin.take();let output=child.stdout.take().ok_or("update_helper_channel")?;
        let mut ready=ReadyHelper{child,input,root:Some(root),plan,digest,detached:false};
        let (sender,receiver)=mpsc::sync_channel(2);
        std::thread::spawn(move||{let mut output=std::io::BufReader::new(output);for _ in 0..2{
            let mut line=String::new();let read=(&mut output).take(8193).read_line(&mut line);
            let message=if read.is_ok()&&line.len()<=8192&&line.ends_with('\n'){serde_json::from_str::<ChannelMessage>(&line).ok()}else{None};
            let valid=message.is_some();let _=sender.send(message);if !valid{break;}
        }});
        let receive=|kind:&str,ready:&ReadyHelper|->Result<(),String>{
            let message=receiver.recv_timeout(std::time::Duration::from_secs(30)).map_err(|_|"update_helper_ready_timeout")?.ok_or("update_helper_channel")?;
            if !macos::valid_message(&message,kind,&ready.plan,&ready.digest){return Err("update_helper_authority".into());}Ok(())
        };
        receive("ready",&ready)?;ready.send("arm")?;receive("armed",&ready)?;
        if ready.child.try_wait().map_err(|_|"update_helper_channel")?.is_some(){return Err("update_helper_exited".into());}
        Ok(ready)
    }
    pub(crate) async fn handoff(app:&tauri::AppHandle,id:&update_coordinator::PrepareId,op:u64,candidate:&str,binding:&update_coordinator::PackageBinding,package:std::sync::Arc<crate::update_package::VerifiedPackage>)->Result<(),String>{
        if app.state::<Handoff>().0.lock().unwrap().is_some(){return Err("update_install_busy".into());}
        let(_,current)=app.state::<updates::Updates>().preparation_authority(app,op,candidate)?;
        if &current!=binding{return Err("update_install_package_binding".into());}
        let owner=id.clone();let target=binding.clone();let staged_package=package.clone();
        let(permit,mut ready)=update_coordinator::run_preparation_with_ready(app,id,binding,package,op,candidate,move||async move{
            tauri::async_runtime::spawn_blocking(move||stage_and_arm(staged_package,owner,target)).await.map_err(|_|"update_helper_start".to_owned())?
        }).await?;
        if ready.child.try_wait().map_err(|_|"update_helper_channel")?.is_some(){return Err("update_helper_exited".into());}
        let handoff=app.state::<Handoff>();let mut pending=handoff.0.lock().unwrap();
        if pending.is_some(){return Err("update_install_busy".into());}
        // All fallible channel work precedes this irreversible authority consume.
        app.state::<updates::Updates>().commit_preparation(app,op,candidate,binding,permit,true)?;
        *pending=Some(ready);drop(pending);
        app.exit(0);Ok(())
    }
    pub(crate) fn application_exited(app:&tauri::AppHandle){
        let Some(mut ready)=app.state::<Handoff>().0.lock().unwrap().take()else{return;};
        if !app.state::<update_coordinator::UpdateCoordinator>().update_exit_for(&update_coordinator::PrepareId(ready.plan.transaction.clone())){return;}
        // The directory must outlive the GUI and retain the old app/recovery log.
        if let Some(root)=ready.root.take(){let _=root.keep();}
        let marker=macos::hash(format!("{}:{}:{}",ready.plan.transaction,ready.digest,ready.plan.token).as_bytes());
        let authorized=write_private(&ready.plan.journal.with_file_name("commit-authorized"),marker.as_bytes());
        if authorized.is_err()||ready.send("commit").is_err(){macos::abort_result(&ready.plan,"update_helper_final_token_failed");return;}
        ready.detached=true;ready.input.take();
    }
    fn read_private(root:&Path,path:&Path,max:u64)->Result<Vec<u8>,String>{
        let root_metadata=fs::symlink_metadata(root).map_err(|_|"update_install_reconcile_invalid")?;
        let metadata=fs::symlink_metadata(path).map_err(|_|"update_install_reconcile_invalid")?;
        if path.parent()!=Some(root)||!metadata.is_file()||metadata.file_type().is_symlink()
            ||metadata.uid()!=root_metadata.uid()||metadata.nlink()!=1||metadata.mode()&0o077!=0||metadata.len()>max{
            return Err("update_install_reconcile_invalid".into());
        }
        fs::read(path).map_err(|_|"update_install_reconcile_invalid".into())
    }
    fn stored_plan(path:&Path,digest:&str)->Result<MacInstallPlan,String>{
        extern "C"{fn geteuid()->u32;}
        let parent=path.parent().ok_or("update_install_reconcile_invalid")?;let metadata=fs::symlink_metadata(path).map_err(|_|"update_install_reconcile_invalid")?;
        let root=fs::symlink_metadata(parent).map_err(|_|"update_install_reconcile_invalid")?;
        if !root.is_dir()||root.file_type().is_symlink()||root.mode()&0o077!=0||root.uid()!=unsafe{geteuid()}||parent.canonicalize().ok().as_deref()!=Some(parent)
            ||!parent.file_name().is_some_and(|name|name.to_string_lossy().starts_with(".leaf-update-"))
            ||!metadata.is_file()||metadata.file_type().is_symlink()||metadata.mode()&0o077!=0||metadata.uid()!=root.uid()||metadata.nlink()!=1||metadata.len()>32*1024*1024{return Err("update_install_reconcile_invalid".into());}
        let bytes=fs::read(path).map_err(|_|"update_install_reconcile_invalid")?;if macos::hash(&bytes)!=digest{return Err("update_install_reconcile_invalid".into());}
        let plan:MacInstallPlan=serde_json::from_slice(&bytes).map_err(|_|"update_install_reconcile_invalid")?;
        if plan.journal!=parent.join("result.json")||plan.helper!=parent.join("leaf-update-helper")||plan.staged!=parent.join("Prepared.app")
            ||plan.target.parent()!=parent.parent()||plan.target.extension().is_none_or(|extension|extension!="app")
            ||plan.gui_executable!=plan.target.join("Contents/MacOS/leaf"){return Err("update_install_reconcile_invalid".into());}Ok(plan)
    }
    fn reconcile_one(app:&tauri::AppHandle,bundle:&Path,path:&Path,digest:&str,transaction:Option<&str>)->Result<(),String>{
        let plan=stored_plan(path,digest)?;
        if transaction.is_some_and(|value|value!=plan.transaction){return Err("update_install_reconcile_invalid".into());}
        let marker=macos::hash(format!("{}:{}:{}",plan.transaction,digest,plan.token).as_bytes());
        let root=path.parent().ok_or("update_install_reconcile_invalid")?;
        if read_private(root,&plan.journal.with_file_name("commit-authorized"),64)?!=marker.as_bytes(){return Err("update_install_reconcile_invalid".into());}
        let result:InstallResult=serde_json::from_slice(&read_private(root,&plan.journal,32*1024)?).map_err(|_|"update_install_reconcile_invalid")?;
        if (bundle!=plan.target&&bundle!=plan.staged)
            ||!((result.old_location==plan.target&&result.new_location==plan.staged)
                ||(result.old_location==plan.staged&&result.new_location==plan.target)){return Err("update_install_reconcile_invalid".into());}
        if result.transaction!=plan.transaction||result.old_bundle_digest!=macos::hash(&serde_json::to_vec(&plan.old).map_err(|_|"update_install_reconcile_invalid")?)
            ||result.new_bundle_digest!=macos::hash(&serde_json::to_vec(&plan.new).map_err(|_|"update_install_reconcile_invalid")?){return Err("update_install_reconcile_invalid".into());}
        let platform=NativePlatform{gui_executable:plan.gui_executable.clone(),plan_path:path.into(),plan_digest:digest.into(),transaction:plan.transaction.clone()};
        let current=macos::capture_identity(bundle)?;
        let recovery=if macos::validate_bundle(&result.old_location,&plan.old,&platform).is_ok(){Some(result.old_location.to_string_lossy().into_owned())}else{None};
        let state=match result.state{
            InstallState::Installed if bundle==plan.target&&current==plan.new&&result.restart_count==1&&read_private(root,&plan.journal.with_extension("restart-claim"),0).is_ok()=>{macos::validate_bundle(bundle,&plan.new,&platform)?;updates::UpdateState::Installed},
            InstallState::RolledBack if bundle==plan.target&&current==plan.old=>{macos::validate_bundle(bundle,&plan.old,&platform)?;updates::UpdateState::RolledBack},
            InstallState::RollbackFailed if recovery.is_some()=>updates::UpdateState::RollbackFailed,
            InstallState::InstallFailed if current==plan.old||current==plan.new=>{macos::validate_bundle(bundle,&current,&platform)?;updates::UpdateState::InstallFailed},
            _=>return Err("update_install_reconcile_invalid".into()),
        };
        app.state::<updates::Updates>().reconcile_install_result(state,current.version,plan.new.version,result.error,
            if matches!(result.state,InstallState::InstallFailed|InstallState::RollbackFailed){recovery}else{None})
    }
    pub(crate) fn reconcile_launch(app:&tauri::AppHandle){
        let Ok(executable)=std::env::current_exe().and_then(fs::canonicalize)else{return;};
        let Some(bundle)=executable.parent().and_then(Path::parent).and_then(Path::parent).filter(|path|path.extension().is_some_and(|extension|extension=="app"))else{return;};
        let args=std::env::args().skip(1).collect::<Vec<_>>();
        if args.first().is_some_and(|arg|arg=="--leaf-update-reconcile"){
            if args.len()!=4{return;}
            let path=Path::new(&args[1]);let deadline=std::time::Instant::now()+std::time::Duration::from_secs(5);
            loop{if reconcile_one(app,bundle,path,&args[2],Some(&args[3])).is_ok(){break;}if std::time::Instant::now()>=deadline{break;}std::thread::sleep(std::time::Duration::from_millis(25));}
            return;
        }
        let Some(parent)=bundle.parent()else{return;};let Ok(entries)=fs::read_dir(parent)else{return;};
        let mut candidates=entries.filter_map(Result::ok).filter(|entry|entry.file_name().to_string_lossy().starts_with(".leaf-update-")).take(32).map(|entry|entry.path()).collect::<Vec<_>>();
        candidates.sort_by_key(|path|std::cmp::Reverse(fs::metadata(path).and_then(|metadata|metadata.modified()).ok()));
        for root in candidates{
            let path=root.join("plan.json");let sha=root.join("plan.sha256");
            if let Ok(bytes)=read_private(&root,&sha,64){if bytes.len()==64{if let Ok(digest)=String::from_utf8(bytes){if reconcile_one(app,bundle,&path,&digest,None).is_ok(){break;}}}}
        }
    }
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
        let identity=document_location::Anchor::open(&old).unwrap().token();
        let new=rename_file(&old,"新名字.md","original").unwrap();
        assert!(!old.exists());assert_eq!(fs::read_to_string(&new).unwrap(),"original");
        let rebound=document_location::Anchor::open(&new).unwrap();
        assert_eq!(rebound.token(),identity);
        assert_eq!(rebound.locate().unwrap().path,fs::canonicalize(&new).unwrap());
    }
}

#[cfg(all(test, target_os = "macos"))]
mod development_tests {
    use super::*;

    #[test]
    fn isolated_store_is_applied_to_every_startup_window_and_production_is_unchanged() {
        let mut config: tauri::utils::config::Config = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let production = serde_json::to_value(&config).unwrap();
        configure_development(&mut config);
        assert_eq!(serde_json::to_value(&config).unwrap(), production);
        config.identifier = "studio.leaf.editor.dev".into();
        config.app.windows.push(config.app.windows[0].clone());
        configure_development(&mut config);
        assert!(config.app.windows.iter().all(|window| window.data_store_identifier == Some(DEVELOPMENT_STORE)));
        assert!(config.app.windows.iter().all(|window| !window.create));
        assert!(!config.app.windows[0].incognito);
    }
}

#[cfg(test)]
mod document_menu_tests {
    use super::*;
    #[test]
    fn prepare_barrier_disables_native_mutating_menu_items_until_reopened(){
        let registry=AdmissionRegistry::default();registry.reserve_document("document-menu").unwrap().commit();registry.document_ready("document-menu");
        let barrier=registry.close().unwrap();
        for command in ["new","open","save","save-as","export-pdf","cycle-mode","cut","paste","undo","redo","recovery","add-comment"]{
            assert!(!document_menu_allowed(WindowRole::Document,command,registry.document_mutation_allowed("document-menu"),false),"{command} enabled under prepare");
        }
        for command in ["find","settings","copy-rich","reveal-document"]{
            assert!(document_menu_allowed(WindowRole::Document,command,false,false));
        }
        assert!(!document_menu_allowed(WindowRole::Launcher,"new",false,false));
        barrier.abort();
        assert!(document_menu_allowed(WindowRole::Document,"save",registry.document_mutation_allowed("document-menu"),false));
    }
    #[test]
    fn native_menu_policy_preserves_existing_mcp_settlement_and_role_rules(){
        assert!(!document_menu_allowed(WindowRole::Document,"cut",true,true));
        assert!(document_menu_allowed(WindowRole::Document,"save",true,true));
        assert!(document_menu_allowed(WindowRole::Document,"find",true,true));
        assert!(!document_menu_allowed(WindowRole::Update,"save",true,false));
        assert!(document_menu_allowed(WindowRole::Document,"reveal-document",false,true));
        assert!(!document_menu_allowed(WindowRole::Update,"reveal-document",true,false));
        assert!(!document_menu_allowed(WindowRole::Launcher,"reveal-document",true,false));
    }
}
