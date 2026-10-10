//! Real AppKit keyDown events in an isolated WKWebView, no system-wide keys.
#[cfg(target_os = "macos")]
mod macos {
use objc2::{class, msg_send, rc::{Allocated, Retained}, runtime::AnyObject};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use std::time::{Duration, Instant};
#[link(name="WebKit",kind="framework")] unsafe extern "C" {}
#[link(name="AppKit",kind="framework")] unsafe extern "C" {}
pub fn run(){
 let args:Vec<_>=std::env::args().collect();
 let foreground=args.iter().any(|arg|arg=="--foreground");
 let source=std::fs::read_to_string(&args[1]).unwrap();
 let escaped:String=source.encode_utf16().map(|c|format!("\\u{c:04x}")).collect();
 unsafe {
  let app:Retained<AnyObject>=msg_send![class!(NSApplication),sharedApplication];
  let _:bool=msg_send![&*app,setActivationPolicy:if foreground{0isize}else{2isize}];
  let rect=NSRect::new(NSPoint::new(0.,0.),NSSize::new(1000.,800.));
  let alloc:Allocated<AnyObject>=msg_send![class!(NSWindow),alloc];
  let window:Retained<AnyObject>=msg_send![alloc,initWithContentRect:rect,styleMask:if foreground{1usize}else{0usize},backing:2usize,defer:false];
  let alloc:Allocated<AnyObject>=msg_send![class!(WKWebView),alloc];
  let web:Retained<AnyObject>=msg_send![alloc,initWithFrame:rect];
  let _:()=msg_send![&*window,setContentView:&*web];
  // Layout tests that follow the focused caret require a genuine key window;
  // background keyboard-only fixtures keep their existing non-activating mode.
  if foreground {
   let _:()=msg_send![&*app,finishLaunching];
   let _:()=msg_send![&*window,makeKeyAndOrderFront:std::ptr::null::<AnyObject>()];
   let _:()=msg_send![&*app,activateIgnoringOtherApps:true];
  } else {
   let _:()=msg_send![&*window,orderBack:std::ptr::null::<AnyObject>()];
  }
  let _:bool=msg_send![&*window,makeFirstResponder:&*web];
  let test_url=args.get(2).map(String::as_str).unwrap_or("http://127.0.0.1:41732/tests/native-long-table.html");
  let url:Retained<AnyObject>=msg_send![class!(NSURL),URLWithString:&*NSString::from_str(test_url)];
  let request:Retained<AnyObject>=msg_send![class!(NSURLRequest),requestWithURL:&*url];
  let _:*mut AnyObject=msg_send![&*web,loadRequest:&*request];
  let runloop:Retained<AnyObject>=msg_send![class!(NSRunLoop),currentRunLoop];
  let start=Instant::now();let mut previous=String::new();
  loop {
   assert!(start.elapsed()<Duration::from_secs(25),"Native keyboard test timed out at {previous}");
   let date:Retained<AnyObject>=msg_send![class!(NSDate),dateWithTimeIntervalSinceNow:0.05f64];
   if foreground {
    let event:Option<Retained<AnyObject>>=msg_send![&*app,nextEventMatchingMask:usize::MAX,
     untilDate:&*date,inMode:&*NSString::from_str("kCFRunLoopDefaultMode"),dequeue:true];
    if let Some(event)=event {let _:()=msg_send![&*app,sendEvent:&*event];}
    let _:()=msg_send![&*app,updateWindows];
   }
   let _:()=msg_send![&*runloop,runUntilDate:&*date];
   let title:Option<Retained<NSString>>=msg_send![&*web,title];
   let Some(title)=title else{continue};let title=title.to_string();
   if title==previous{continue} previous=title.clone();
   if title=="LeafSource" {
    let script=NSString::from_str(&format!("window.startTest(\"{escaped}\")"));
    let _:()=msg_send![&*web,evaluateJavaScript:&*script,completionHandler:std::ptr::null::<AnyObject>()];
   } else if title.starts_with("LeafKey ") {
    let shift_tab=title=="LeafKey ShiftTab";
    let command_a=title=="LeafKey CmdA";
    let chars=NSString::from_str(if command_a{"a"}else if shift_tab{"\u{19}"}else{"\u{7f}"});
    let plain=NSString::from_str(if command_a{"a"}else if shift_tab{"\t"}else{"\u{7f}"});
    let number:isize=msg_send![&*window,windowNumber];
    let event:Retained<AnyObject>=msg_send![class!(NSEvent),keyEventWithType:10usize,
     location:NSPoint::new(0.,0.),modifierFlags:if command_a{1usize<<20}else if shift_tab{1usize<<17}else{0usize},timestamp:0f64,windowNumber:number,
     context:std::ptr::null::<AnyObject>(),characters:&*chars,charactersIgnoringModifiers:&*plain,
     isARepeat:false,keyCode:if command_a{0u16}else if shift_tab{48u16}else{51u16}];
    let responder:Retained<AnyObject>=msg_send![&*window,firstResponder];
    let _:()=msg_send![&*responder,keyDown:&*event];
   } else if title.starts_with("LeafTest ") {
    println!("{title}"); assert!(title.contains("PASS")); break;
   }
  }
 }
}

}

#[cfg(target_os = "macos")]
fn main() { macos::run(); }

#[cfg(not(target_os = "macos"))]
fn main() { eprintln!("This native WebKit fixture requires macOS."); }
