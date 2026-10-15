//! Isolated real WebView2 output, using the same reservation and renderer as Leaf.
#[cfg(target_os = "windows")]
#[path = "../src/windows_pdf.rs"]
mod windows_pdf;
#[cfg(target_os = "windows")]
#[path = "../src/pdf_output.rs"]
mod pdf_output;

#[cfg(target_os = "windows")]
fn main() {
    use std::{path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}}};
    use tauri::Manager;
    let mut args = std::env::args().skip(1);
    let target = PathBuf::from(args.next().expect("absolute synthetic output path"));
    let long = args.next().as_deref() == Some("long");
    let body = if long { "<p>Synthetic pagination text.</p>".repeat(180) } else { "<p>One synthetic line.</p>".into() };
    let html = format!("<html><head><meta charset='utf-8'><title>中文標題-é-😀</title></head><body><h1>FIRST</h1>{body}<p>FINAL-CONTENT-END</p></body></html>");
    let url = tauri::Url::parse(&format!("data:text/html;charset=utf-8,{html}")).unwrap();
    let profile = tempfile::tempdir().unwrap();
    let profile_dir = profile.path().to_owned();
    let started = Arc::new(AtomicBool::new(false));
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "studio.leaf.pdf-probe".into();
    std::thread::spawn(|| { std::thread::sleep(std::time::Duration::from_secs(60)); eprintln!("PDF probe timeout"); std::process::exit(2); });
    tauri::Builder::default().manage(profile).setup(move |app| {
        tauri::WebviewWindowBuilder::new(app, "pdf-probe", tauri::WebviewUrl::External(url))
            .data_directory(profile_dir).title("Leaf synthetic PDF check").inner_size(950., 800.).visible(true)
            .on_page_load(move |window, payload| {
                if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) || started.swap(true, Ordering::SeqCst) { return; }
                let temp = pdf_output::prepare(&target).unwrap();
                let output = temp.to_path_buf();
                let target = target.clone();
                let app = window.app_handle().clone();
                let failed = app.clone();
                window.with_webview(move |platform| {
                    let result = unsafe { platform.controller().CoreWebView2().and_then(|webview| {
                        windows_pdf::start(platform.environment(), webview, &output, Box::new(move |result| {
                            let result = result.map_err(|e| e.to_string()).and_then(|saved| {
                                if saved { pdf_output::finish(temp, &target) } else { Err("PDF renderer returned false".into()) }
                            });
                            match result { Ok(()) => { println!("PASS: actual WebView2 PDF written"); app.exit(0); }, Err(error) => { eprintln!("PDF probe failed: {error}"); app.exit(1); } }
                        }))
                    }) };
                    if let Err(error) = result { eprintln!("PDF start failed: {error}"); failed.exit(1); }
                }).unwrap();
            }).build()?;
        Ok(())
    }).run(context).expect("isolated Windows PDF probe");
}

#[cfg(not(target_os = "windows"))]
fn main() { eprintln!("This real WebView2 check requires Windows."); }
