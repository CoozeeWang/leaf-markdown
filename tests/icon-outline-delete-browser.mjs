import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const meta=await sharp('public/leaf-icon.png').metadata();
assert.equal(meta.width,1024);assert.equal(meta.height,1024);assert.ok(meta.hasAlpha);
const pixels=await sharp('public/leaf-icon.png').raw().toBuffer();
assert.equal(pixels[3],0);assert.equal(pixels[(500*1024+500)*4+3],255);
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1200,height:850}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');
 assert.ok(await page.locator('.welcome-mark').evaluate(el=>el.complete&&el.naturalWidth===1024));
 await page.click('#welcomeNewButton');
 assert.ok(await page.locator('.brand-mark').evaluate(el=>el.complete&&el.naturalWidth===1024));
 await page.evaluate(async()=>{
  const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
  window.isolateHistory=(await import('/node_modules/@codemirror/commands/dist/index.js')).isolateHistory;
  window.testView=EditorView.findFromDOM(document.querySelector('.cm-content'));
 });
 const setup=(source,head)=>page.evaluate(({source,head})=>{
  testView.dispatch({changes:{from:0,to:testView.state.doc.length,insert:source},selection:{anchor:head},scrollIntoView:true,annotations:isolateHistory.of('full')});testView.focus();
 },{source,head});
 const value=()=>page.evaluate(()=>testView.state.doc.toString());
 await setup('上段\n\n\n\n下段',6);
 await page.waitForTimeout(650); // Separate fixture creation from the user's deletion history.
 // One Backspace takes away one blank line: a run is unwound one press per blank.
 await page.keyboard.press('Backspace');assert.equal(await value(),'上段\n\n\n下段');
 assert.equal(await page.evaluate(()=>testView.state.selection.main.head),5);
 await page.keyboard.press('ControlOrMeta+z');assert.equal(await value(),'上段\n\n\n\n下段');
 await setup('上段',2);await page.keyboard.press('Enter');assert.equal(await value(),'上段\n');
 await page.keyboard.press('Enter');assert.equal(await value(),'上段\n\n');
 await page.keyboard.press('Backspace');assert.equal(await value(),'上段\n');
 await page.keyboard.press('Backspace');assert.equal(await value(),'上段');
 await setup('上段\n\n\n下段',2);await page.keyboard.press('Delete');assert.equal(await value(),'上段\n\n下段');
 await page.keyboard.press('Delete');assert.equal(await value(),'上段\n下段');
 // Turning the blank-line marks on must not change any of that.
 await setup('上段\n\n\n下段',5);await page.keyboard.press('ControlOrMeta+Shift+Backslash');
 await page.keyboard.press('Backspace');assert.equal(await value(),'上段\n\n下段');
 await page.keyboard.press('ControlOrMeta+Shift+Backslash');
 await setup('# 长标题测试\n\n正文\n\n## 第二节',0);
 await page.click('#outlineButton');await page.waitForTimeout(250);
 const drawer=page.locator('#outlineDrawer'),handle=page.locator('.outline-resizer');
 const start=await drawer.boundingBox(),box=await handle.boundingBox();
 assert.equal(start.x,0);
 await page.mouse.move(box.x+3,box.y+80);await page.mouse.down();
 await page.mouse.move(box.x+143,box.y+80,{steps:10});await page.mouse.up();
 await page.waitForTimeout(250);
 assert.ok(Math.abs((await drawer.boundingBox()).width-start.width-140)<3);
 const saved=await page.evaluate(()=>localStorage.getItem('leaf-outline-width'));
 await page.reload();await page.click('#welcomeNewButton');await page.click('#outlineButton');await page.waitForTimeout(250);
 assert.ok(Math.abs((await drawer.boundingBox()).width-Number(saved))<2);
 await handle.focus();await page.keyboard.press('ArrowLeft');
 assert.equal(Number(await handle.getAttribute('aria-valuenow')),Number(saved)-10);
 await handle.dblclick();await page.waitForTimeout(250);
 assert.ok(Math.abs((await drawer.boundingBox()).width-280)<2);
 await page.screenshot({path:artifactPath('leaf-icon-outline.png')});
 assert.deepEqual(errors,[]);
 console.log('PASS: transparent L icon, welcome/editor branding, paragraph Backspace/Delete/undo, inspection mode, outline drag/keyboard/reset/persistence');
}finally{await browser.close()}
