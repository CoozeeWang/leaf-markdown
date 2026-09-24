use std::cell::RefCell;
use objc2::{class,msg_send,rc::Retained,runtime::AnyObject};
use objc2_foundation::{NSString,NSRect,NSPoint,NSSize};
use tauri::{Emitter,Manager};
struct Edit { field:Retained<AnyObject>,window:Retained<AnyObject>,label:String,pending:bool }
thread_local! { static EDIT:RefCell<Option<Edit>>=const {RefCell::new(None)}; }

pub unsafe fn begin(window:&tauri::WebviewWindow) {
    finish(None);
    let native=window.ns_window().unwrap() as *mut AnyObject;
    let close:*mut AnyObject=msg_send![native,standardWindowButton:0usize];
    let parent:*mut AnyObject=msg_send![close,superview];
    if parent.is_null(){return;}
    let bounds:NSRect=msg_send![parent,bounds];
    let width=(bounds.size.width-180.0).clamp(100.0,360.0);
    let rect=NSRect::new(NSPoint::new((bounds.size.width-width)/2.0,(bounds.size.height-22.0)/2.0),NSSize::new(width,22.0));
    let field:objc2::rc::Allocated<AnyObject>=msg_send![class!(NSTextField),alloc];
    let field:Retained<AnyObject>=msg_send![field,initWithFrame:rect];
    let name=window.app_handle().state::<crate::Documents>().0.lock().unwrap().get(window.label()).cloned().flatten().and_then(|p|p.file_stem().map(|n|n.to_string_lossy().into_owned())).unwrap_or_else(||"未命名".into());
    let _:()=msg_send![&*field,setStringValue:&*NSString::from_str(&name)];
    let _:()=msg_send![&*field,setBezeled:false];let _:()=msg_send![&*field,setBordered:false];
    let _:()=msg_send![&*field,setDrawsBackground:true];
    let color:*mut AnyObject=msg_send![class!(NSColor),windowBackgroundColor];
    let _:()=msg_send![&*field,setBackgroundColor:color];
    let _:()=msg_send![&*field,setFocusRingType:1usize];
    let _:()=msg_send![&*field,setAlignment:1usize];
    let font:*mut AnyObject=msg_send![class!(NSFont),systemFontOfSize:13.0f64];let _:()=msg_send![&*field,setFont:font];
    let _:()=msg_send![&*field,setAutoresizingMask:5usize];
    let _:()=msg_send![&*field,setToolTip:&*NSString::from_str("回车确认，Esc 取消")];
    let _:()=msg_send![native,setTitleVisibility:1isize];
    let _:()=msg_send![parent,addSubview:&*field];
    let _:bool=msg_send![native,makeFirstResponder:&*field];let _:()=msg_send![&*field,selectText:std::ptr::null::<AnyObject>()];
    let label=window.label().to_owned();let window=Retained::retain(native).unwrap();
    EDIT.with(|slot|*slot.borrow_mut()=Some(Edit{field,window,label,pending:false}));
}

pub unsafe fn finish(error:Option<&str>) {
    EDIT.with(|slot|{
        if let Some(message)=error {
            if let Some(edit)=slot.borrow_mut().as_mut(){edit.pending=false;let _:()=msg_send![&*edit.field,setToolTip:&*NSString::from_str(message)];let _:()=msg_send![&*edit.field,selectText:std::ptr::null::<AnyObject>()];}
        }else if let Some(edit)=slot.borrow_mut().take(){let _:bool=msg_send![&*edit.window,makeFirstResponder:std::ptr::null::<AnyObject>()];let _:()=msg_send![&*edit.field,removeFromSuperview];let _:()=msg_send![&*edit.window,setTitleVisibility:0isize];}
    });
}
// Return true for clicks inside the editor, so a double click selects text
// instead of replacing the native input. Outside clicks cancel, like the page.
pub unsafe fn mouse(event:*mut AnyObject)->bool {
    let (inside,cancel)=EDIT.with(|slot|{
        let slot=slot.borrow();let Some(edit)=slot.as_ref() else{return (false,false)};
        let window:*mut AnyObject=msg_send![event,window];
        let point:NSPoint=msg_send![event,locationInWindow];
        let local:NSPoint=msg_send![&*edit.field,convertPoint:point,fromView:std::ptr::null::<AnyObject>()];
        let bounds:NSRect=msg_send![&*edit.field,bounds];
        let inside=window==(&*edit.window as *const AnyObject).cast_mut() && local.x>=0.0 && local.y>=0.0 && local.x<=bounds.size.width && local.y<=bounds.size.height;
        (inside,!inside&&!edit.pending)
    });
    if cancel {finish(None);}inside
}
pub unsafe fn blur(label:&str){
    let cancel=EDIT.with(|slot|slot.borrow().as_ref().is_some_and(|edit|edit.label==label&&!edit.pending));
    if cancel{finish(None);}
}
pub unsafe fn finish_for(label:&str,error:Option<&str>){
    if EDIT.with(|slot|slot.borrow().as_ref().is_some_and(|edit|edit.label==label)){finish(error);}
}
pub unsafe fn key(app:&tauri::AppHandle,event:*mut AnyObject)->bool {
    let code:u16=msg_send![event,keyCode];
    if code==53 {let (active,pending)=EDIT.with(|slot|slot.borrow().as_ref().map(|e|(true,e.pending)).unwrap_or((false,false)));if active&&!pending {finish(None);}return active;}
    EDIT.with(|slot|{
        let mut slot=slot.borrow_mut();let Some(edit)=slot.as_mut() else{return false};
        if code!=36 && code!=76{return false;}
        let editor:*mut AnyObject=msg_send![&*edit.field,currentEditor];
        if !editor.is_null(){let marked:bool=msg_send![editor,hasMarkedText];if marked{return false;}}
        if edit.pending{return true;}
        let text:Retained<NSString>=if editor.is_null(){msg_send![&*edit.field,stringValue]}else{msg_send![editor,string]};
        if text.to_string().trim().is_empty(){return true;}
        if let Some(window)=app.get_webview_window(&edit.label){edit.pending=window.emit_to(window.label(),"leaf-native-rename",text.to_string()).is_ok();}
        true
    })
}
