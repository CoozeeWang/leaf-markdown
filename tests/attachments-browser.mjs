import {chromium,launchOptions} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/attachments-fixture',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><body><nav class="format-toolbar"><span class="toolbar-spacer"></span></nav><section id="insertPopover"></section><div id="clipboardMenu"></div><div id="editor"></div></body>'}));
 await page.goto('http://127.0.0.1:41732/attachments-fixture');
 await page.evaluate(async()=>{
  const {createLeafEditor}=await import('/src/editor.js'),{setupWriting}=await import('/src/writing-tools.js');
  window.ed=createLeafEditor({parent:document.querySelector('#editor'),doc:'abc'});ed.view.dispatch({selection:{anchor:3}});
  window.imports=[];window.saveOK=false;window.failImport=false;window.statuses=[];
  window.writing=setupWriting({editor:ed,desktop:true,icon:()=>'',status:s=>statuses.push(s),editable:()=>true,toggleSource:()=>{},choose:async()=>['/source/photo.png'],save:async()=>saveOK,serialized:async f=>f(),invoke:async(cmd,args)=>{
    if(cmd==='import_attachment'){if(failImport)throw Error('disk full');imports.push(args);if(window.delay)await new Promise(r=>window.resume=r);return 'assets/photo.png';}
    throw Error('missing');
  }});
 });
 await page.evaluate(()=>writing.attachments(['/source/photo.png']));
 assert.equal(await page.evaluate(()=>ed.getValue()),'abc');assert.equal(await page.evaluate(()=>imports.length),0,'cancelled initial save never writes an attachment');
 await page.evaluate(()=>{saveOK=true;failImport=true;});await page.evaluate(()=>writing.attachments(['/source/photo.png']));
 assert.equal(await page.evaluate(()=>ed.getValue()),'abc','failed imports never insert broken references');
 await page.evaluate(()=>{failImport=false;window.delay=true;window.pending=writing.attachments(['/source/photo.png']);});
 await page.waitForFunction(()=>typeof resume==='function');
 await page.evaluate(()=>{ed.view.dispatch({changes:{from:0,insert:'X'}});resume();});await page.evaluate(()=>pending);
 assert.equal(await page.evaluate(()=>ed.getValue()),'Xabc\n\n![photo](assets/photo.png)','pending insertion follows edits while import waits');
 await page.evaluate(()=>ed.undo());assert.equal(await page.evaluate(()=>ed.getValue()),'Xabc','one undo removes only attachment reference');
 assert.equal(await page.evaluate(()=>imports.length),1,'undo never deletes imported files');
 assert.deepEqual(errors,[]);console.log('PASS attachment initial save cancellation, write failure, pending edits and undo preserving files');
}finally{await browser.close();}
