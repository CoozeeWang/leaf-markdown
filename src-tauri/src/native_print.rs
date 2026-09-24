use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
use objc2_foundation::NSSize;

pub const MARGIN_POINTS: f64 = 18.0 * 72.0 / 25.4;

// Called on the AppKit main thread with a live WKWebView. Do not use
// WebviewWindow::print(): Wry's default PrintOptions overwrites all margins
// with zero. A private print-info copy also avoids changing other documents.
pub unsafe fn operation(webview: &AnyObject) -> Retained<AnyObject> {
    let shared: Retained<AnyObject> = msg_send![class!(NSPrintInfo), sharedPrintInfo];
    let info: Retained<AnyObject> = msg_send![&*shared, copy];
    let _: () = msg_send![&*info, setPaperSize: NSSize::new(210.0 * 72.0 / 25.4, 297.0 * 72.0 / 25.4)];
    let _: () = msg_send![&*info, setTopMargin: MARGIN_POINTS];
    let _: () = msg_send![&*info, setBottomMargin: MARGIN_POINTS];
    let _: () = msg_send![&*info, setLeftMargin: MARGIN_POINTS];
    let _: () = msg_send![&*info, setRightMargin: MARGIN_POINTS];
    msg_send![webview, printOperationWithPrintInfo: &*info]
}

pub unsafe fn show(webview: &AnyObject) {
    let op = operation(webview);
    let _: () = msg_send![&*op, setCanSpawnSeparateThread: true];
    let window: *mut AnyObject = msg_send![webview, window];
    let _: () = msg_send![&*op, runOperationModalForWindow: window,
        delegate: std::ptr::null::<AnyObject>(),
        didRunSelector: Option::<objc2::runtime::Sel>::None,
        contextInfo: std::ptr::null_mut::<std::ffi::c_void>()];
}
