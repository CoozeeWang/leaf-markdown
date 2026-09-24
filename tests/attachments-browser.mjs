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
  window.imports=[];window.reveals=[];window.saveOK=false;window.failImport=false;window.statuses=[];
  window.writing=setupWriting({editor:ed,desktop:true,icon:()=>'',status:s=>statuses.push(s),editable:()=>true,toggleSource:()=>{},choose:async()=>['/source/photo.png'],save:async()=>saveOK,serialized:async f=>f(),invoke:async(cmd,args)=>{
    if(cmd==='import_attachment'){if(failImport)throw Error('disk full');imports.push(args);if(window.delay)await new Promise(r=>window.resume=r);return 'assets/'+args.name;}
    if(cmd==='reveal_resource'){reveals.push(args);return 'ok';}
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
 // An iPhone photo is a picture, so it arrives as one -- the old whitelist made
 // it a bare link. HEIC only decodes on some platforms, but how it is written
 // does not depend on where it is opened.
 // The import above left the mock waiting on a resume that will never come.
 await page.evaluate(()=>{window.delay=false;return writing.attachments(['/source/IMG_1234.HEIC']);});
 assert.match(await page.evaluate(()=>ed.getValue()),/!\[IMG_1234\]\(assets\/IMG_1234\.HEIC\)/,'HEIC is inserted as an image, not a link');
 // The same placeholder has to appear when the file itself cannot be read:
 // move the caret off the line first, or the editor shows the source instead.
 await page.evaluate(()=>ed.view.dispatch({selection:{anchor:0}}));
 await page.waitForSelector('.leaf-image-status[data-kind="missing"]');
 assert.match(await page.evaluate(()=>document.querySelector('.leaf-image-status-head').textContent),/找不到图片/,'an unreadable file explains itself instead of vanishing');
 // The card is a button: pressing it asks the desktop to show the file. The
 // press must not reach the preview widget, which would drop the caret into
 // the line and swap the card for source text before the click ever landed.
 await page.evaluate(()=>{
   const card=document.querySelector('.leaf-image-status[data-kind="missing"]');
   card.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));
 });
 assert.equal(await page.evaluate(()=>reveals.length),1,'pressing the card asks the desktop to reveal the file');
 assert.equal(await page.evaluate(()=>reveals[0].relative),'assets/IMG_1234.HEIC','the reveal names the card\'s own file');
 assert.ok(await page.$('.leaf-image-status[data-kind="missing"]'),'pressing the card keeps the card instead of switching to source');
 assert.deepEqual(errors,[]);console.log('PASS attachment initial save cancellation, write failure, pending edits and undo preserving files');
}finally{await browser.close();}
