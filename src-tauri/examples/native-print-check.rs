//! Background-only WKWebView regression: no visible window or print dialog.
#[cfg(target_os = "macos")]
#[path = "../src/native_print.rs"]
mod native_print;
#[cfg(target_os = "macos")]
mod macos {
use super::native_print;
use objc2::{class, msg_send, rc::{Allocated, Retained}, runtime::AnyObject};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use std::time::{Duration, Instant};
#[link(name = "WebKit", kind = "framework")]
unsafe extern "C" {}
#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {
    static NSPrintSaveJob: *const AnyObject;
    static NSPrintJobSavingURL: *const AnyObject;
}
pub fn run() {
    std::thread::spawn(|| { std::thread::sleep(Duration::from_secs(20)); eprintln!("Native print timeout"); std::process::exit(2); });
    let args: Vec<_> = std::env::args().collect();
    let web_check = args[1].starts_with("http://127.0.0.1:");
    let html = if web_check { String::new() } else { std::fs::read_to_string(&args[1]).unwrap() };
    unsafe {
        let app: Retained<AnyObject> = msg_send![class!(NSApplication), sharedApplication];
        let _: bool = msg_send![&*app, setActivationPolicy: 2isize];
        let rect = NSRect::new(NSPoint::new(0., 0.), NSSize::new(794., 1123.));
        let allocated: Allocated<AnyObject> = msg_send![class!(NSWindow), alloc];
        let window: Retained<AnyObject> = msg_send![allocated, initWithContentRect: rect, styleMask: 0usize, backing: 2usize, defer: false];
        let allocated: Allocated<AnyObject> = msg_send![class!(WKWebView), alloc];
        let webview: Retained<AnyObject> = msg_send![allocated, initWithFrame: rect];
        let _: () = msg_send![&*window, setContentView: &*webview];
        if web_check {
            let url: Retained<AnyObject> = msg_send![class!(NSURL), URLWithString: &*NSString::from_str(&args[1])];
            let request: Retained<AnyObject> = msg_send![class!(NSURLRequest), requestWithURL: &*url];
            let _: *mut AnyObject = msg_send![&*webview, loadRequest: &*request];
        } else {
            let _: *mut AnyObject = msg_send![&*webview, loadHTMLString: &*NSString::from_str(&html), baseURL: std::ptr::null::<AnyObject>()];
        }
        let runloop: Retained<AnyObject> = msg_send![class!(NSRunLoop), currentRunLoop];
        let start = Instant::now();
        loop {
            let until: Retained<AnyObject> = msg_send![class!(NSDate), dateWithTimeIntervalSinceNow: 0.05f64];
            let _: () = msg_send![&*runloop, runUntilDate: &*until];
            let loading: bool = msg_send![&*webview, isLoading];
            if web_check {
                let title: Option<Retained<NSString>> = msg_send![&*webview, title];
                if let Some(title) = title {
                    let text = title.to_string();
                    if text.starts_with("LeafTest") { assert!(text.contains("PASS"), "{text}"); println!("{text}"); return; }
                }
                continue;
            }
            if !loading && start.elapsed() > Duration::from_secs(2) { break; }
            assert!(start.elapsed() < Duration::from_secs(20), "WebKit load timed out");
        }
        let op = native_print::operation(&webview);
        let info: Retained<AnyObject> = msg_send![&*op, printInfo];
        let left: f64 = msg_send![&*info, leftMargin];
        assert!((left - native_print::MARGIN_POINTS).abs() < 0.01);
        let _: () = msg_send![&*info, setJobDisposition: NSPrintSaveJob];
        let dict: Retained<AnyObject> = msg_send![&*info, dictionary];
        let url: Retained<AnyObject> = msg_send![class!(NSURL), fileURLWithPath: &*NSString::from_str(&args[2])];
        let _: () = msg_send![&*dict, setObject: &*url, forKey: NSPrintJobSavingURL];
        let _: () = msg_send![&*op, setShowsPrintPanel: false];
        let _: () = msg_send![&*op, setShowsProgressPanel: false];
        // WKWebView requires the asynchronous operation used by the real app;
        // a synchronous runOperation can stall its pagination callbacks.
        let _: () = msg_send![&*op, runOperationModalForWindow: &*window,
            delegate: std::ptr::null::<AnyObject>(),
            didRunSelector: Option::<objc2::runtime::Sel>::None,
            contextInfo: std::ptr::null_mut::<std::ffi::c_void>()];
        loop {
            let until: Retained<AnyObject> = msg_send![class!(NSDate), dateWithTimeIntervalSinceNow: 0.05f64];
            let _: () = msg_send![&*runloop, runUntilDate: &*until];
            if let Ok(bytes) = std::fs::read(&args[2]) {
                if bytes.ends_with(b"%%EOF\n") { break; }
                assert!(bytes.len() < 10_000_000, "Unexpectedly large native PDF");
            }
        }
        println!("Native WKWebView PDF generated with {left:.2}pt margins");
    }
}

}

#[cfg(target_os = "macos")]
fn main() { macos::run(); }

#[cfg(not(target_os = "macos"))]
fn main() { eprintln!("This native WebKit fixture requires macOS."); }
