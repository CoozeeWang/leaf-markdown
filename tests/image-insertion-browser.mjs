import {chromium,launchOptions} from './browser-runtime.mjs';
import {desktopImageFixture} from './fixtures/desktop-image.mjs';
import assert from 'node:assert/strict';
const source='---\ntitle: Image preview\n---\n\n'+Array.from({length:45},(_,i)=>`Paragraph ${i+1}: text stays in this document.`).join('\n\n');
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:800},deviceScaleFactor:2}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await desktopImageFixture(page,source);
 await page.evaluate(()=>{const at=v.state.doc.toString().indexOf('Paragraph 25:');v.dispatch({selection:{anchor:at},effects:v.constructor.scrollIntoView(at,{y:'center'})});v.focus();});
 await page.click('#imageInsert');
 await page.waitForFunction(()=>v.state.doc.toString().includes('![toolbar]'));
 const result=await page.evaluate(()=>({source:v.state.doc.toString(),head:v.state.selection.main.head,line:v.state.doc.lineAt(v.state.selection.main.head).text,scroll:v.scrollDOM.scrollTop}));
 assert.equal(result.line,'','the caret is in a new empty paragraph, not the image source or existing body');
 assert.ok(result.source.slice(0,result.head).endsWith('![toolbar](assets/toolbar.svg)\n\n'),'one blank line separates the image and new paragraph');
 assert.ok(result.source.slice(result.head).startsWith('\n\nParagraph 25:'),'existing body stays after the new paragraph');
 assert.ok(result.scroll>300,'insertion does not jump to the document top');
 await page.waitForSelector('img[data-resource="assets/toolbar.svg"][data-loaded="yes"]');
 await page.waitForTimeout(150);
 const geometry=await page.evaluate(()=>{
  const viewport=v.scrollDOM.getBoundingClientRect(),caret=v.coordsAtPos(v.state.selection.main.head),image=document.querySelector('img[data-resource="assets/toolbar.svg"]').getBoundingClientRect();
  return {caretVisible:caret.top>=viewport.top&&caret.bottom<=viewport.bottom,imageVisible:image.bottom>viewport.top&&image.top<viewport.bottom};
 });
 assert.ok(geometry.caretVisible&&geometry.imageVisible,'the preview and continuation point remain visible');
 await page.keyboard.type('Continue here');
 assert.ok((await page.evaluate(()=>v.state.doc.toString())).includes('![toolbar](assets/toolbar.svg)\n\nContinue here\n\nParagraph 25:'),'typing continues without altering the image or following body');
 await page.keyboard.press('ControlOrMeta+z');
 await page.keyboard.press('ControlOrMeta+z');
 assert.equal(await page.evaluate(()=>v.state.doc.toString()),source,'one image undo restores the original body and properties');
 // Clipboard files use the same insertion contract at the end of the document.
 await page.evaluate(async()=>{
  const {setResourceReader}=await import('/src/resources.js');
  setResourceReader(async()=>{
   await new Promise(resolve=>setTimeout(resolve,400));
   return Array.from(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="600"><rect width="120" height="600" fill="#607b68"/></svg>'));
  });
  v.dispatch({selection:{anchor:v.state.doc.length},scrollIntoView:true});v.focus();
  const clipboard=new DataTransfer();clipboard.items.add(new File(['fixture'],'pasted.svg',{type:'image/svg+xml'}));
  v.dom.dispatchEvent(new ClipboardEvent('paste',{clipboardData:clipboard,bubbles:true,cancelable:true}));
 });
 await page.waitForFunction(()=>v.state.doc.toString().includes('![pasted]'));
 assert.equal(await page.evaluate(()=>v.state.doc.lineAt(v.state.selection.main.head).text),'','pasted image also leaves an empty continuation paragraph');
 await page.waitForSelector('img[data-resource="assets/pasted.svg"][data-loaded="yes"]');
 await page.waitForTimeout(200);
 assert.ok(await page.evaluate(()=>{
  const viewport=v.scrollDOM.getBoundingClientRect(),caret=v.coordsAtPos(v.state.selection.main.head);
  return caret.top>=viewport.top&&caret.bottom<=viewport.bottom;
 }),'a delayed tall image does not push the continuation caret out of view');
 // Source-mode insertion keeps the user's selected mode, but not the caret
 // inside the image source. It remains the same one-step undo operation.
 await page.click('#readingToggle');await page.locator('[data-mode=source]').click();
 const beforeSourceInsert=await page.evaluate(()=>v.state.doc.toString());
 await page.click('#imageInsert');
 await page.waitForFunction(()=>v.state.doc.toString().includes('![toolbar]'));
 assert.ok(await page.evaluate(async()=>{const {sourceMode}=await import('/src/view-mode.js');return v.state.field(sourceMode);}), 'insertion preserves source mode');
 assert.equal(await page.evaluate(()=>v.state.doc.lineAt(v.state.selection.main.head).text),'');
 await page.keyboard.press('ControlOrMeta+z');
 assert.equal(await page.evaluate(()=>v.state.doc.toString()),beforeSourceInsert);
 await page.click('#readingToggle');await page.locator('[data-mode=edit]').click();
 await page.click('#imageInsert');
 await page.waitForFunction(()=>v.state.doc.toString().includes('![toolbar]'));
 // Let the insertion's initial scroll finish before the user scrolls away,
 // while the delayed reader is still pending.
 await page.waitForTimeout(120);
 await page.evaluate(()=>{
  v.scrollDOM.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-800}));
  v.scrollDOM.scrollTop=0;
 });
 await page.waitForTimeout(800);
 assert.equal(await page.evaluate(()=>v.scrollDOM.scrollTop),0,'image loading does not take over after the user scrolls away');
 assert.deepEqual(errors,[]);
 console.log('PASS immediate image preview, blank continuation paragraph, long-document scroll, typing, undo and image paste');
}finally{await browser.close();}
