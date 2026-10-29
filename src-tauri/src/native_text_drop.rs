//! Wry 0.55 routes every drag to Tauri's file-only handler, whose return value
//! suppresses WKWebView even when no files exist. Keep that handler for files;
//! let WebKit deliver text/internal-selection drags to the editor's DOM.
use objc2::{msg_send, sel, runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel}};
use objc2::rc::Retained;
use objc2_foundation::{NSArray, NSString};
use std::ffi::CString;

unsafe fn has_files(info: &AnyObject) -> bool {
    let board: *mut AnyObject = msg_send![info, draggingPasteboard];
    if board.is_null() { return false; }
    let types: Option<Retained<NSArray<NSString>>> = msg_send![board, types];
    types.is_some_and(|types| types.iter().any(|kind| matches!(kind.to_string().as_str(), "NSFilenamesPboardType" | "public.file-url")))
}
unsafe fn destination(this: &AnyObject, info: &AnyObject) -> &'static AnyClass {
    let original = this.class().superclass().expect("installed subclass");
    if has_files(info) { original } else {
        let mut base=original;
        loop {
            if base.name().to_bytes()==b"WKWebView" {return base;}
            #[cfg(test)]
            if base.name().to_bytes()==b"LeafDropTestWebKit" {return base;}
            base=base.superclass().expect("verified WebKit ancestor");
        }
    }
}
unsafe extern "C-unwind" fn entered(this: &AnyObject, _: Sel, info: &AnyObject) -> usize {
    msg_send![super(this, destination(this, info)), draggingEntered: info]
}
unsafe extern "C-unwind" fn updated(this: &AnyObject, _: Sel, info: &AnyObject) -> usize {
    msg_send![super(this, destination(this, info)), draggingUpdated: info]
}
unsafe extern "C-unwind" fn dropped(this: &AnyObject, _: Sel, info: &AnyObject) -> Bool {
    msg_send![super(this, destination(this, info)), performDragOperation: info]
}
unsafe extern "C-unwind" fn exited(this: &AnyObject, _: Sel, info: &AnyObject) {
    let _: () = msg_send![super(this, destination(this, info)), draggingExited: info];
}
/// Called on the WebView/main thread; no global method swizzling or clipboard content reads.
/// The subclass adds no ivars, preserves Wry's lifecycle, and changes only this view.
pub unsafe fn install(view: &AnyObject) {
    let original = view.class();
    if original.name().to_bytes().starts_with(b"LeafTextDrop_") { return; }
    // Fail closed on an upstream class change: never skip an unknown superclass.
    let mut base=original;
    while base.name().to_bytes()!=b"wry::wkwebview::class::wry_web_view::WryWebView0.55.1" {
        let Some(parent)=base.superclass() else {return}; base=parent;
    }
    if base.superclass().map(|c|c.name().to_bytes())!=Some(b"WKWebView".as_slice()) {return;}
    install_subclass(view);
}
unsafe fn install_subclass(view: &AnyObject) {
    let original = view.class();
    let name = CString::new(format!("LeafTextDrop_{}",original.name().to_string_lossy())).unwrap();
    let subclass = AnyClass::get(&name).unwrap_or_else(|| {
        let mut builder = ClassBuilder::new(&name, original).expect("unique view subclass");
        builder.add_method(sel!(draggingEntered:), entered as unsafe extern "C-unwind" fn(_,_,_) -> _);
        builder.add_method(sel!(draggingUpdated:), updated as unsafe extern "C-unwind" fn(_,_,_) -> _);
        builder.add_method(sel!(performDragOperation:), dropped as unsafe extern "C-unwind" fn(_,_,_) -> _);
        builder.add_method(sel!(draggingExited:), exited as unsafe extern "C-unwind" fn(_,_,_));
        builder.register()
    });
    assert_eq!(subclass.instance_size(),original.instance_size());
    AnyObject::set_class(view, subclass);
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::class;
    use std::sync::atomic::{AtomicPtr, AtomicUsize, Ordering};
    static BOARD: AtomicPtr<AnyObject> = AtomicPtr::new(std::ptr::null_mut());
    static EXIT: AtomicUsize = AtomicUsize::new(0);
    unsafe extern "C-unwind" fn board(_: &AnyObject, _: Sel) -> *mut AnyObject { BOARD.load(Ordering::SeqCst) }
    unsafe extern "C-unwind" fn web_enter(_: &AnyObject, _: Sel, _: &AnyObject) -> usize { 1 }
    unsafe extern "C-unwind" fn file_enter(_: &AnyObject, _: Sel, _: &AnyObject) -> usize { 2 }
    unsafe extern "C-unwind" fn web_over(_: &AnyObject, _: Sel, _: &AnyObject) -> usize { 4 }
    unsafe extern "C-unwind" fn file_over(_: &AnyObject, _: Sel, _: &AnyObject) -> usize { 8 }
    unsafe extern "C-unwind" fn web_drop(_: &AnyObject, _: Sel, _: &AnyObject) -> Bool { Bool::NO }
    unsafe extern "C-unwind" fn file_drop(_: &AnyObject, _: Sel, _: &AnyObject) -> Bool { Bool::YES }
    unsafe extern "C-unwind" fn web_exit(_: &AnyObject, _: Sel, _: &AnyObject) { EXIT.store(1,Ordering::SeqCst); }
    unsafe extern "C-unwind" fn file_exit(_: &AnyObject, _: Sel, _: &AnyObject) { EXIT.store(2,Ordering::SeqCst); }
    #[test]
    fn text_reaches_webkit_and_files_keep_the_original_handler() { unsafe {
        // Unique named pasteboard, never the user's general clipboard.
        let pb: Retained<AnyObject> = msg_send![class!(NSPasteboard), pasteboardWithUniqueName];
        BOARD.store((&*pb as *const AnyObject).cast_mut(),Ordering::SeqCst);
        let mut info = ClassBuilder::new(c"LeafDropTestInfo",class!(NSObject)).unwrap();
        info.add_method(sel!(draggingPasteboard),board as unsafe extern "C-unwind" fn(_,_) -> _);
        let info: Retained<AnyObject> = msg_send![info.register(), new];
        let mut web = ClassBuilder::new(c"LeafDropTestWebKit",class!(NSObject)).unwrap();
        web.add_method(sel!(draggingEntered:),web_enter as unsafe extern "C-unwind" fn(_,_,_) -> _);
        web.add_method(sel!(draggingUpdated:),web_over as unsafe extern "C-unwind" fn(_,_,_) -> _);
        web.add_method(sel!(performDragOperation:),web_drop as unsafe extern "C-unwind" fn(_,_,_) -> _);
        web.add_method(sel!(draggingExited:),web_exit as unsafe extern "C-unwind" fn(_,_,_));
        let mut wry = ClassBuilder::new(c"LeafDropTestWry",web.register()).unwrap();
        wry.add_method(sel!(draggingEntered:),file_enter as unsafe extern "C-unwind" fn(_,_,_) -> _);
        wry.add_method(sel!(draggingUpdated:),file_over as unsafe extern "C-unwind" fn(_,_,_) -> _);
        wry.add_method(sel!(performDragOperation:),file_drop as unsafe extern "C-unwind" fn(_,_,_) -> _);
        wry.add_method(sel!(draggingExited:),file_exit as unsafe extern "C-unwind" fn(_,_,_));
        let view: Retained<AnyObject> = msg_send![wry.register(), new];
        install_subclass(&view);
        for (kind,file) in [("public.utf8-plain-text",false),("public.html",false),("public.file-url",true),("NSFilenamesPboardType",true)] {
        let types=NSArray::from_retained_slice(&[NSString::from_str(kind)]);
            let _: isize = msg_send![&*pb, declareTypes:&*types owner:std::ptr::null::<AnyObject>()];
        let enter: usize = msg_send![&*view,draggingEntered:&*info];
            let over: usize = msg_send![&*view,draggingUpdated:&*info];
            let drop: Bool = msg_send![&*view,performDragOperation:&*info];
            let _: () = msg_send![&*view,draggingExited:&*info];
            assert_eq!(enter,if file {2}else{1});assert_eq!(over,if file {8}else{4});
            assert_eq!(drop.as_bool(),file);assert_eq!(EXIT.load(Ordering::SeqCst),if file {2}else{1});
        }
        let _: () = msg_send![&*pb, releaseGlobally];
        BOARD.store(std::ptr::null_mut(),Ordering::SeqCst);
    }}
}
