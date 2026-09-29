//! Finder Services delivers selected file URLs; never interpret pasteboard text
//! as a command or ask Finder to disclose its front window through automation.
use std::{cell::RefCell, path::PathBuf, sync::OnceLock};
use objc2::{class, msg_send, sel, rc::Retained, runtime::{AnyClass, AnyObject, ClassBuilder, Sel}};
use objc2_foundation::NSString;

thread_local! {
    static PROVIDER: RefCell<Option<(Retained<AnyObject>, tauri::AppHandle)>> = const { RefCell::new(None) };
}

unsafe fn folder(pasteboard: &AnyObject) -> Result<PathBuf, String> {
    let classes: Retained<AnyObject> = msg_send![class!(NSArray), arrayWithObject: class!(NSURL)];
    let objects: Option<Retained<AnyObject>> = msg_send![pasteboard, readObjectsForClasses: &*classes, options: std::ptr::null::<AnyObject>()];
    let objects = objects.ok_or("请选择一个文件夹或文件，再使用 Leaf 新建文档。")?;
    let count: usize = msg_send![&*objects, count];
    if count != 1 { return Err("请只选择一个文件夹或文件，再使用 Leaf 新建文档。".into()); }
    let url: *mut AnyObject = msg_send![&*objects, objectAtIndex: 0usize];
    let local: bool = msg_send![url, isFileURL];
    if !local { return Err("只能在本机文件夹中新建文档。".into()); }
    let path: Option<Retained<NSString>> = msg_send![url, path];
    let path = PathBuf::from(path.ok_or("无法读取所选文件的位置。")?.to_string());
    if path.is_dir() { Ok(path) }
    else if path.is_file() { path.parent().map(PathBuf::from).ok_or("无法确定目标文件夹。".into()) }
    else { Err("所选文件或文件夹已不存在，或无法访问。".into()) }
}

extern "C-unwind" fn new_markdown(_this: &AnyObject, _cmd: Sel, pasteboard: &AnyObject, _data: *mut AnyObject, _error: *mut *mut AnyObject) {
    let target = unsafe { folder(pasteboard) };
    // Return promptly to Services; creation and window building must not block
    // AppKit. Failures are reported by Leaf's native dialog after dispatch.
    PROVIDER.with(|provider| {
        if let Some((_, app)) = provider.borrow().as_ref() {
            crate::create_from_file_manager(app.clone(), target);
        }
    });
}

fn provider_class() -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| {
        let mut builder = ClassBuilder::new(c"LeafMarkdownServices", class!(NSObject)).expect("unique service class");
        unsafe { builder.add_method(sel!(leafNewMarkdown:userData:error:), new_markdown as extern "C-unwind" fn(_, _, _, _, _)); }
        builder.register()
    })
}

pub fn install(app: tauri::AppHandle) {
    unsafe {
        let provider: Retained<AnyObject> = msg_send![provider_class(), new];
        let application: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![application, setServicesProvider: &*provider];
        PROVIDER.with(|slot| *slot.borrow_mut() = Some((provider, app)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_pasteboard_resolves_folder_and_file_without_decoding_loss() {
        objc2::rc::autoreleasepool(|_| unsafe {
            let dir = tempfile::tempdir().unwrap();
            let child = dir.path().join("sample space # 中文");
            std::fs::create_dir(&child).unwrap();
            let file = child.join("sample.md");
            std::fs::write(&file, "keep").unwrap();
            let board: Retained<AnyObject> = msg_send![class!(NSPasteboard), pasteboardWithUniqueName];
            for selected in [&child, &file] {
                let _: isize = msg_send![&*board, clearContents];
                let url: Retained<AnyObject> = msg_send![class!(NSURL), fileURLWithPath: &*NSString::from_str(selected.to_str().unwrap())];
                let array: Retained<AnyObject> = msg_send![class!(NSArray), arrayWithObject: &*url];
                let ok: bool = msg_send![&*board, writeObjects: &*array];
                assert!(ok);
                assert_eq!(folder(&board).unwrap(), child);
            }
            let _: isize = msg_send![&*board, clearContents];
            assert!(folder(&board).is_err());
            let _: () = msg_send![&*board, releaseGlobally];
            assert!(provider_class().instance_method(sel!(leafNewMarkdown:userData:error:)).is_some());
        });
    }
}
