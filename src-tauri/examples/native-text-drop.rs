//! Construct a hidden, nonpersistent real Wry WebView and verify the selective
//! drag shim installs once. No documents, clipboard contents or protocol launch.
#[cfg(target_os="macos")]
#[path="../src/native_text_drop.rs"]
mod native_text_drop;
#[cfg(target_os="macos")]
fn main() {
    let mut context=tauri::generate_context!();
    context.config_mut().identifier="studio.leaf.editor.dev.textdrop-probe".into();
    context.config_mut().app.windows.clear();
    tauri::Builder::default().setup(|app| {
        app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        let window=tauri::WebviewWindowBuilder::new(app,"textdrop-probe",tauri::WebviewUrl::External("about:blank".parse().unwrap()))
            .visible(false).incognito(true).data_store_identifier(*b"leaf-drop-probe1").build()?;
        let handle=app.handle().clone();
        window.with_webview(move|platform|unsafe {
            let view=&*(platform.inner() as *const objc2::runtime::AnyObject);
            let original=view.class();
            assert!(native_text_drop::install(view));
            assert_eq!(view.class(),original);
            assert!(native_text_drop::install(view));
            assert_eq!(view.class(),original);
            println!("PASS real hidden Wry WebView: text-drop hooks preserve native class identity");
            handle.exit(0);
        })?;
        Ok(())
    }).run(context).expect("isolated native text-drop probe");
}
#[cfg(not(target_os="macos"))]
fn main() {}
