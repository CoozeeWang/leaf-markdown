import {chromium,launchOptions} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const source='---\nversion: v1\n---\n\nBody';
const floor='---\nversion: v1\n---\n'.length;
const browser=await chromium.launch(launchOptions);
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/properties-guard-fixture',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><body><nav class="format-toolbar"><span class="toolbar-spacer"></span></nav><section id="insertPopover"></section><div id="clipboardMenu"></div><div id="editor"></div></body>'}));
 await page.goto('http://127.0.0.1:41732/properties-guard-fixture');
 await page.evaluate(async doc=>{
  const {createLeafEditor}=await import('/src/editor.js'),{setupWriting}=await import('/src/writing-tools.js');
  window.source=doc;
  window.ed=createLeafEditor({parent:document.querySelector('#editor'),doc:source});
  window.statuses=[];
  window.writing=setupWriting({editor:ed,desktop:true,icon:()=>'',status:s=>statuses.push(s),editable:()=>true,choose:async()=>[],save:async()=>true,serialized:async f=>f(),invoke:async(cmd,args)=>{
    if(cmd==='import_attachment')return 'assets/'+args.name;
    throw Error('missing');
  }});
 },source);
 await page.waitForSelector('.leaf-yaml');
 // A document created with properties has not dispatched a selection yet.
 await page.evaluate(()=>ed.view.focus());
 await page.keyboard.type('I');
 assert.equal(await page.evaluate(()=>ed.getValue()),'---\nversion: v1\n---\nI\nBody','the very first edit cannot precede the properties');
 await page.evaluate(text=>ed.setValue(text),source);
 // The caret is never parked inside the property block: it is where the next
 // keystroke, paste or drop would write.
 await page.evaluate(()=>ed.view.dispatch({selection:{anchor:0}}));
 assert.equal(await page.evaluate(()=>ed.view.state.selection.main.from),floor,'a caret aimed at the block starts in the body');
 await page.evaluate(()=>ed.view.focus());
 await page.keyboard.type('X');
 assert.equal(await page.evaluate(()=>ed.getValue()),'---\nversion: v1\n---\nX\nBody','typing at the top writes into the body, never into the YAML');
 await page.evaluate(()=>ed.view.dispatch({changes:{from:20,to:21}}));
 assert.equal(await page.evaluate(()=>ed.getValue()),source,'the typed character is removed again');
 // A file dropped on the block lands after it, and says so.
 const point=await page.evaluate(()=>{const r=document.querySelector('.leaf-yaml').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+4};});
 await page.evaluate(p=>writing.attachments(['/source/photo.png'],true,p),point);
 const dropped=await page.evaluate(()=>ed.getValue());
 assert.ok(dropped.startsWith('---\nversion: v1\n---\n'),`dropping on the block keeps it a property block: ${dropped}`);
 assert.ok(dropped.includes('![photo](assets/photo.png)')&&dropped.indexOf('![photo]')>dropped.indexOf('---\nversion'),
   `the dropped file goes into the body: ${dropped}`);
 assert.ok(await page.evaluate(()=>statuses.some(s=>s.includes('正文开头'))),'a relocated drop says where the file went');
 // The same drop over ordinary body text stays where it was aimed.
 await page.evaluate(p=>writing.attachments(['/source/second.png'],true,p),
   await page.evaluate(()=>{const r=ed.view.coordsAtPos(ed.view.state.doc.length-1);return {x:r.left,y:r.top+4};}));
 assert.ok(await page.evaluate(()=>ed.getValue().endsWith('![second](assets/second.png)\n\n')),'a drop in the body is not moved');
 // Dragging over the block offers no insertion point; the body still does.
 const over=p=>page.evaluate(p=>{
   ed.view.contentDOM.dispatchEvent(new DragEvent('dragover',{clientX:p.x,clientY:p.y,bubbles:true,cancelable:true}));
   return ed.view.scrollDOM.classList.contains('cm-leaf-no-drop');
 },p);
 assert.equal(await over(point),true,'a drag over the property block shows no drop cursor');
 const body=await page.evaluate(()=>{const r=ed.view.coordsAtPos(ed.view.state.doc.length-1);return {x:r.left,y:r.top+4};});
 assert.equal(await over(body),false,'a drag over the body still shows one');
 await page.evaluate(()=>ed.view.contentDOM.dispatchEvent(new DragEvent('dragleave',{bubbles:true})));
 assert.equal(await page.evaluate(()=>ed.view.scrollDOM.classList.contains('cm-leaf-no-drop')),false,'leaving the editor clears it');
 // Selecting across the whole document and retyping still rewrites the block:
 // only a caret is moved, never a selection.
 await page.evaluate(()=>ed.view.dispatch({selection:{anchor:0,head:ed.view.state.doc.length}}));
 assert.equal(await page.evaluate(()=>ed.view.state.selection.main.from),0,'selecting into the block stays possible');
 await page.evaluate(()=>ed.view.dispatch({changes:{from:0,to:ed.view.state.doc.length,insert:'# 重写\n'},selection:{anchor:5}}));
 assert.equal(await page.evaluate(()=>ed.getValue()),'# 重写\n','rewriting from the top removes the block as before');
 await page.evaluate(text=>ed.setValue(text),source);
 // CodeMirror text drops carry a change and a selection in ONE transaction.
 // Moving the selection after that change is too late to protect the YAML.
 await page.evaluate(()=>ed.view.dispatch({changes:{from:0,insert:'Dropped'},selection:{anchor:7},userEvent:'input.drop'}));
 assert.equal(await page.evaluate(()=>ed.getValue()),'---\nversion: v1\n---\nDropped\nBody','a text drop is redirected before the change destroys the properties');
 await page.evaluate(()=>ed.undo());
 assert.equal(await page.evaluate(()=>ed.getValue()),source,'undo removes only the redirected drop');
 await page.evaluate(()=>ed.redo());
 assert.equal(await page.evaluate(()=>ed.getValue()),'---\nversion: v1\n---\nDropped\nBody','redo retains the legal insertion position');
 await page.evaluate(text=>ed.setValue(text),source);
 await page.evaluate(()=>ed.view.focus());
 await page.keyboard.press('Backspace');
 assert.equal(await page.evaluate(()=>ed.getValue()),source,'Backspace at the first body position cannot remove the closing delimiter newline');
 const propertiesOnly='---\nversion: v1\n---';
 await page.evaluate(text=>ed.setValue(text),propertiesOnly);
 await page.evaluate(()=>ed.view.focus());
 await page.keyboard.type('Body');
 assert.equal(await page.evaluate(()=>ed.getValue()),propertiesOnly+'\nBody','a property-only document gains a body line before typing');
 const crlf=source.replace(/\n/g,'\r\n');
 await page.evaluate(text=>ed.setValue(text),crlf);
 assert.equal(await page.evaluate(()=>ed.getValue()),crlf,'loading CRLF does not rewrite the source');
 assert.equal(await page.evaluate(()=>ed.view.state.selection.main.head),floor,'CRLF carets use normalized editor offsets');
 await page.evaluate(text=>ed.restoreValue(text),propertiesOnly.replace(/\n/g,'\r\n'));
 await page.keyboard.type('Body');
 assert.equal(await page.evaluate(()=>ed.getValue()),propertiesOnly.replace(/\n/g,'\r\n')+'\r\nBody','restoration and typing preserve CRLF endings');
 await page.evaluate(text=>ed.setValue(text),source);
 // Source mode shows the YAML as text, so the caret is free to go anywhere.
 await page.evaluate(()=>ed.setSource(true));
 await page.evaluate(()=>ed.view.dispatch({selection:{anchor:0}}));
 assert.equal(await page.evaluate(()=>ed.view.state.selection.main.from),0,'source mode still edits the block itself');
 await page.evaluate(()=>writing.attachments(['/source/source-mode.png']));
 assert.ok((await page.evaluate(()=>ed.getValue())).startsWith('---\nversion: v1\n---\n'),'image insertion in source mode still preserves properties');
 await page.evaluate(f=>{ed.setSource(false);ed.setValue(source);ed.view.dispatch({selection:{anchor:0,head:f}});},floor);
 await page.evaluate(()=>writing.attachments(['/source/selection.png']));
 assert.ok((await page.evaluate(()=>ed.getValue())).startsWith('---\nversion: v1\n---\n'),'an attachment cannot replace a selection of the properties');

 // Exercise the real desktop listener -> main -> writing pipeline, with the
 // native IPC mocked. Native file dragover is NOT a contentDOM DragEvent.
 const native=await browser.newPage({deviceScaleFactor:2});
 native.on('pageerror',e=>errors.push(e.message));
 await native.addInitScript(doc=>{
  const callbacks=new Map(),listeners=new Map();let id=0;
  window.isTauri=true;window.writes=[];window.imports=[];
  window.emitNative=(event,payload)=>callbacks.get(listeners.get(event))({event,payload});
  window.__TAURI_INTERNALS__={
   metadata:{currentWindow:{label:'document-test'},currentWebview:{label:'document-test'}},
   transformCallback:fn=>{callbacks.set(++id,fn);return id;},
   invoke:async(command,args)=>{
    if(command==='plugin:event|listen'){listeners.set(args.event,args.handler);return args.handler;}
    if(command==='initial_path')return '/fixture/document.md';
    if(command==='observe_document')return {path:'/fixture/document.md',content:doc};
    if(command==='read_document')return doc;
    if(command==='recovery_list')return [];
    if(command==='recovery_retention')return 30;
    if(command==='import_attachment'){imports.push(args);return 'assets/'+args.name;}
    if(command==='write_document'){writes.push(args.content);return null;}
    return null;
   },
  };
 },source);
 await native.goto('http://127.0.0.1:41732');
 await native.waitForSelector('.leaf-yaml');
 await native.waitForFunction(()=>document.querySelector('#welcomeScreen').hidden);
 await native.evaluate(async()=>{
  const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
  window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));
 });
 const nativePoint=await native.evaluate(()=>{const r=document.querySelector('.leaf-yaml').getBoundingClientRect(),scale=/^win/i.test(navigator.userAgentData?.platform||navigator.platform)?devicePixelRatio:1;return {x:(r.left+r.width/2)*scale,y:(r.top+4)*scale};});
 await native.evaluate(p=>emitNative('tauri://drag-over',{position:p}),nativePoint);
 assert.equal(await native.evaluate(()=>v.scrollDOM.classList.contains('cm-leaf-no-drop')),true,'native drag feedback protects the property region at Retina scale');
 await native.evaluate(()=>emitNative('tauri://drag-leave',{}));
 assert.equal(await native.evaluate(()=>v.scrollDOM.classList.contains('cm-leaf-no-drop')),false,'native leave clears the feedback');
 await native.evaluate(p=>emitNative('tauri://drag-drop',{paths:['/fixture/native.png'],position:p}),nativePoint);
 await native.waitForFunction(()=>v.state.doc.toString().includes('![native]'));
 assert.ok((await native.evaluate(()=>v.state.doc.toString())).startsWith('---\nversion: v1\n---\n'),'native image drop preserves property bytes');
 assert.equal(await native.evaluate(()=>imports.length),1,'the native drop imports the image once');
 await native.waitForFunction(()=>writes.some(text=>text.includes('![native]')));
 assert.ok((await native.evaluate(()=>writes.at(-1))).startsWith('---\nversion: v1\n---\n'),'autosave receives intact properties');
 await native.close();
 assert.deepEqual(errors,[]);console.log('PASS property block keeps drops, typing and paste out of the YAML');
}finally{await browser.close();}
