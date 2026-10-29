import Cocoa
import WebKit
let app=NSApplication.shared
let foreground=CommandLine.arguments.contains("--foreground")
let previous=NSWorkspace.shared.frontmostApplication
app.setActivationPolicy(foreground ? .accessory : .prohibited)
let window=NSWindow(contentRect:NSRect(x:0,y:0,width:1100,height:900),styleMask:foreground ? [.titled,.closable] : .borderless,backing:.buffered,defer:false)
let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent()
let web=WKWebView(frame:window.contentView!.bounds,configuration:config)
window.contentView=web;window.title="Leaf — synthetic callout blink test"
if foreground {app.finishLaunching();window.makeKeyAndOrderFront(nil);app.activate(ignoringOtherApps:true)}
window.makeFirstResponder(web)
web.load(URLRequest(url:URL(string:CommandLine.arguments[1])!))
let output=URL(fileURLWithPath:CommandLine.arguments[2]);try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
var started=false;var pending=false;var frame=0;var last=Date.distantPast;var rows:[String]=[]
let deadline=Date().addingTimeInterval(55)
while Date()<deadline && frame<100 {
 if foreground {
  if let event=app.nextEvent(matching:.any,until:Date().addingTimeInterval(0.01),inMode:.default,dequeue:true) {app.sendEvent(event)}
  app.updateWindows()
 }
 RunLoop.current.run(until:Date().addingTimeInterval(0.02))
 if foreground && !window.isVisible {break}
 if !started {if web.title == "LeafBlink READY" {started=true};continue}
 if foreground && frame>0 && (!window.isKeyWindow || !app.isActive) {print("focus lost; capture stopped");break}
 if pending || Date().timeIntervalSince(last)<0.1 {continue}
 pending=true;last=Date()
 if frame==25 || frame==50 || frame==75 {web.evaluateJavaScript("blinkStep(\(frame/25))",completionHandler:nil)}
 web.evaluateJavaScript("blinkState()") {value,error in
  if let value=value as? String {rows.append(value)} else {rows.append("{\"error\":\"state unavailable\"}")}
  let settings=WKSnapshotConfiguration();settings.afterScreenUpdates=true
  web.takeSnapshot(with:settings) {image,error in
   if let image=image,let tiff=image.tiffRepresentation,let rep=NSBitmapImageRep(data:tiff),let bytes=rep.representation(using:.png,properties:[:]) {try? bytes.write(to:output.appendingPathComponent(String(format:"%03d.png",frame)))}
   else {print("snapshot failed \(String(describing:error))")}
   frame+=1;pending=false
  }
 }
}
try ("["+rows.joined(separator:",")+"]").write(to:output.appendingPathComponent("states.json"),atomically:true,encoding:.utf8)
print("frames=\(frame) visible=\(window.isVisible) key=\(window.isKeyWindow) active=\(app.isActive)")

window.close()
if foreground && app.isActive {previous?.activate(options:[])}
if frame != 100 {exit(2)}
