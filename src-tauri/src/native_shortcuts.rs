use block2::RcBlock;
use objc2::{class, msg_send, runtime::AnyObject};
use tauri::Emitter;
use objc2_foundation::{NSPoint,NSRect,NSSize};

const SHIFT: usize = 1 << 17;
const CONTROL: usize = 1 << 18;
const OPTION: usize = 1 << 19;
const COMMAND: usize = 1 << 20;

fn command(key: u16, modifiers: usize) -> Option<&'static str> {
    if modifiers & (SHIFT | CONTROL | OPTION | COMMAND) != COMMAND { return None; }
    match key { 14 => Some("export-pdf"), 15 => Some("cycle-mode"), _ => None }
}

/// Install once on AppKit's main thread. This local monitor handles only the
/// document export chord, before the input method or WebKit consumes it.
pub fn install(app: tauri::AppHandle) {
    let handler = RcBlock::new(move |event: *mut AnyObject| -> *mut AnyObject {
        if event.is_null() { return event; }
        unsafe {
            let event_type:usize=msg_send![event,type];
            if event_type==1 {
                if crate::native_title::mouse(event){return event;}
                let clicks:isize=msg_send![event,clickCount];
                if clicks!=2{return event;}
                let native:*mut AnyObject=msg_send![event,window];
                if native.is_null(){return event;}
                let point:NSPoint=msg_send![event,locationInWindow];
                let layout:NSRect=msg_send![native,contentLayoutRect];
                let frame:NSRect=msg_send![native,frame];
                let title:*mut AnyObject=msg_send![native,title];
                let size:NSSize=msg_send![title,sizeWithAttributes:std::ptr::null::<AnyObject>()];
                let half=(size.width/2.0+12.0).min((frame.size.width-180.0).max(0.0)/2.0);
                if point.y>=layout.origin.y+layout.size.height && point.y<frame.size.height && (point.x-frame.size.width/2.0).abs()<=half {
                    if let Some(window)=crate::menu_window(&app).filter(|w|w.label().starts_with("document-")) {
                        if window.ns_window().ok()==Some(native.cast()){crate::native_title::begin(&window);return std::ptr::null_mut();}
                    }
                }
                return event;
            }
            if crate::native_title::key(&app,event){return std::ptr::null_mut();}
            let key: u16 = msg_send![event, keyCode];
            let modifiers: usize = msg_send![event, modifierFlags];
            if let Some(action) = command(key, modifiers) {
                if let Some(window) = crate::menu_window(&app).filter(|w| w.label().starts_with("document-")) {
                    let repeat: bool = msg_send![event, isARepeat];
                    if repeat || window.emit_to(window.label(),"leaf-menu", action).is_ok() {
                        return std::ptr::null_mut();
                    }
                }
            }
        }
        event
    });
    // AppKit owns the monitor and copies its block until removeMonitor:. This
    // app-lifetime monitor intentionally remains registered until termination.
    let monitor: *mut AnyObject = unsafe {
        msg_send![class!(NSEvent), addLocalMonitorForEventsMatchingMask: (1usize << 10) | (1usize << 1), handler: &*handler]
    };
    if monitor.is_null() { eprintln!("Could not install document export shortcut"); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn export_chord_leaves_text_and_other_shortcuts_alone() {
        assert_eq!(command(14, COMMAND), Some("export-pdf"));
        assert_eq!(command(15, COMMAND), Some("cycle-mode"));
        assert_eq!(command(14, COMMAND | (1 << 16)), Some("export-pdf"));
        for modifiers in [0, SHIFT, COMMAND | SHIFT, COMMAND | OPTION, COMMAND | CONTROL] {
            assert_eq!(command(14, modifiers), None);
            assert_eq!(command(15, modifiers), None);
        }
        assert_eq!(command(16, COMMAND), None);
    }
}
