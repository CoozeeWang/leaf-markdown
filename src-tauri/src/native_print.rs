use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
use objc2_foundation::NSSize;

// AppKit's modal sheet returns before rendering/writing ends. Retain both the
// operation and its native admission ticket until the documented didRun callback.
struct TrackedPrint {
    _lease:Box<dyn std::any::Any+Send>,
    _operation:Retained<AnyObject>,
    _delegate:Retained<AnyObject>,
    done:Option<Box<dyn FnOnce(bool)+Send>>,
}
extern "C-unwind" fn did_run(_this:&AnyObject,_cmd:objc2::runtime::Sel,_operation:*mut AnyObject,success:objc2::runtime::Bool,context:*mut std::ffi::c_void) {
    if context.is_null(){return;}
    // AppKit may invoke didRun on its print worker. Transfer the unique opaque
    // context back to the main queue; no retained AppKit object is released on
    // that worker and no !Send object receives an unsafe Send implementation.
    let address=context as usize;let success=success.as_bool();
    let finish=block2::RcBlock::new(move||unsafe{
        let mut print=Box::from_raw(address as *mut TrackedPrint);
        if let Some(done)=print.done.take(){done(success);}
        drop(print);
    });
    unsafe{let queue:*mut AnyObject=msg_send![class!(NSOperationQueue),mainQueue];
        let _:()=msg_send![queue,addOperationWithBlock:&*finish];}
}
fn completion_class()->&'static objc2::runtime::AnyClass {
    static CLASS:std::sync::OnceLock<&'static objc2::runtime::AnyClass>=std::sync::OnceLock::new();
    CLASS.get_or_init(||{
        let mut builder=objc2::runtime::ClassBuilder::new(c"LeafPrintAdmissionCompletion",class!(NSObject)).expect("unique print completion class");
        unsafe{builder.add_method(objc2::sel!(printOperationDidRun:success:contextInfo:),did_run as extern "C-unwind" fn(_,_,_,_,_));}
        builder.register()
    })
}
pub unsafe fn show_tracked(webview:&AnyObject,lease:impl Send+'static) {
    let op=operation(webview);
    run_tracked(webview,op,lease,None);
}
unsafe fn run_tracked(webview:&AnyObject,op:Retained<AnyObject>,lease:impl Send+'static,done:Option<Box<dyn FnOnce(bool)+Send>>) {
    let _:()=msg_send![&*op,setCanSpawnSeparateThread:true];
    let window:*mut AnyObject=msg_send![webview,window];
    let delegate:Retained<AnyObject>=msg_send![completion_class(),new];
    let context=Box::into_raw(Box::new(TrackedPrint{_lease:Box::new(lease),_operation:op.clone(),_delegate:delegate.clone(),done}));
    let _:()=msg_send![&*op,runOperationModalForWindow:window,
        delegate:&*delegate,didRunSelector:Some(objc2::sel!(printOperationDidRun:success:contextInfo:)),
        contextInfo:context.cast::<std::ffi::c_void>()];
}

#[cfg(feature="native-smoke")]
pub unsafe fn fixture_pdf(webview:&AnyObject,lease:impl Send+'static,path:&std::path::Path,done:impl FnOnce(bool)+Send+'static) {
    use objc2_foundation::NSString;
    unsafe extern "C" {static NSPrintSaveJob:*const AnyObject;static NSPrintJobSavingURL:*const AnyObject;}
    let op=operation(webview);let info:Retained<AnyObject>=msg_send![&*op,printInfo];
    let _:()=msg_send![&*info,setJobDisposition:NSPrintSaveJob];
    let dict:Retained<AnyObject>=msg_send![&*info,dictionary];
    let url:Retained<AnyObject>=msg_send![class!(NSURL),fileURLWithPath:&*NSString::from_str(&path.to_string_lossy())];
    let _:()=msg_send![&*dict,setObject:&*url,forKey:NSPrintJobSavingURL];
    let _:()=msg_send![&*op,setShowsPrintPanel:false];let _:()=msg_send![&*op,setShowsProgressPanel:false];
    run_tracked(webview,op,lease,Some(Box::new(done)));
}

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
