//! Tauri's Wry file-drag callback consumes non-file drags. Hook only the
//! known Wry drag methods in this process; keep each object's class/KVO identity
//! and forward files to the original implementation, text to WKWebView.
use objc2::{msg_send, sel, runtime::{AnyClass, AnyObject, Bool, Imp, Sel}};
use objc2::rc::Retained;
use objc2_foundation::{NSArray, NSString};
use std::sync::{Once, OnceLock};
struct Originals { entered: Imp, updated: Imp, dropped: Imp, exited: Imp, webkit: &'static AnyClass }
static ORIGINALS: OnceLock<Originals> = OnceLock::new();
static INSTALL: Once = Once::new();
unsafe fn has_files(info: &AnyObject) -> bool {
    let board: *mut AnyObject = msg_send![info, draggingPasteboard];
    if board.is_null() { return false; }
    let types: Option<Retained<NSArray<NSString>>> = msg_send![board, types];
    types.is_some_and(|types| types.iter().any(|kind| matches!(kind.to_string().as_str(), "NSFilenamesPboardType" | "public.file-url")))
}
unsafe extern "C-unwind" fn entered(this: &AnyObject, selector: Sel, info: &AnyObject) -> usize {
    let original=ORIGINALS.get().expect("installed drag hooks");
    if has_files(info) {
        let call: unsafe extern "C-unwind" fn(&AnyObject,Sel,&AnyObject)->usize=std::mem::transmute(original.entered);
        call(this,selector,info)
    } else { msg_send![super(this, original.webkit), draggingEntered: info] }
}
unsafe extern "C-unwind" fn updated(this: &AnyObject, selector: Sel, info: &AnyObject) -> usize {
    let original=ORIGINALS.get().expect("installed drag hooks");
    if has_files(info) {
        let call: unsafe extern "C-unwind" fn(&AnyObject,Sel,&AnyObject)->usize=std::mem::transmute(original.updated);
        call(this,selector,info)
    } else { msg_send![super(this, original.webkit), draggingUpdated: info] }
}
unsafe extern "C-unwind" fn dropped(this: &AnyObject, selector: Sel, info: &AnyObject) -> Bool {
    let original=ORIGINALS.get().expect("installed drag hooks");
    if has_files(info) {
        let call: unsafe extern "C-unwind" fn(&AnyObject,Sel,&AnyObject)->Bool=std::mem::transmute(original.dropped);
        call(this,selector,info)
    } else { msg_send![super(this, original.webkit), performDragOperation: info] }
}
unsafe extern "C-unwind" fn exited(this: &AnyObject, selector: Sel, info: &AnyObject) {
    let original=ORIGINALS.get().expect("installed drag hooks");
    if has_files(info) {
        let call: unsafe extern "C-unwind" fn(&AnyObject,Sel,&AnyObject)=std::mem::transmute(original.exited);
        call(this,selector,info)
    } else { let _: ()=msg_send![super(this, original.webkit), draggingExited: info]; }
}
/// Main-thread-only installation, limited to the pinned Wry class. Never change
/// WKWebView or KVO classes and never read pasteboard contents/general clipboard.
pub unsafe fn install(view: &AnyObject) -> bool {
    let mut base=view.class();
    while base.name().to_bytes()!=b"wry::wkwebview::class::wry_web_view::WryWebView0.55.1" {
        let Some(parent)=base.superclass() else {return false}; base=parent;
    }
    if base.superclass().map(|c|c.name().to_bytes())!=Some(b"WKWebView".as_slice()) {return false;}
    install_class(base);
    true
}
unsafe fn install_class(base: &'static AnyClass) {
    INSTALL.call_once(|| {
        let enter=base.instance_method(sel!(draggingEntered:)).expect("Wry drag entered");
        let update=base.instance_method(sel!(draggingUpdated:)).expect("Wry drag updated");
        let drop=base.instance_method(sel!(performDragOperation:)).expect("Wry drop");
        let exit=base.instance_method(sel!(draggingExited:)).expect("Wry drag exited");
        let _=ORIGINALS.set(Originals{entered:enter.implementation(),updated:update.implementation(),dropped:drop.implementation(),exited:exit.implementation(),webkit:base.superclass().unwrap()});
        enter.set_implementation(std::mem::transmute(entered as unsafe extern "C-unwind" fn(&AnyObject,Sel,&AnyObject)->usize));
        update.set_implementation(std::mem::transmute(updated as unsafe extern "C-unwind" fn(&AnyObject,Sel,&AnyObject)->usize));
        drop.set_implementation(std::mem::transmute(dropped as unsafe extern "C-unwind" fn(&AnyObject,Sel,&AnyObject)->Bool));
        exit.set_implementation(std::mem::transmute(exited as unsafe extern "C-unwind" fn(&AnyObject,Sel,&AnyObject)));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::{class, runtime::ClassBuilder};
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
        install_class(view.class());
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
