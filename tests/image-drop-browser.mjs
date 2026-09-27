import {chromium,launchOptions} from './browser-runtime.mjs';
import {desktopImageFixture} from './fixtures/desktop-image.mjs';
import assert from 'node:assert/strict';
const source='---\ntitle: Image drop\n---\n\n'+Array.from({length:45},(_,i)=>`Paragraph ${i+1}: a distinct insertion target.`).join('\n\n');
const browser=await chromium.launch(launchOptions);
try {
  // Wry 0.55 macOS payloads contain AppKit points, not backing pixels;
  // Windows payloads contain client physical pixels. Do not make a single
  // synthetic pixel convention silently stand in for both implementations.
  for(const platform of ['macOS','Windows']) for(const scale of [2,1,1.5]) {
    const page=await browser.newPage({viewport:{width:1100,height:800},deviceScaleFactor:scale}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await desktopImageFixture(page,source,{platform});
    await page.evaluate(()=>{const at=v.state.doc.toString().indexOf('Paragraph 25:');v.dispatch({selection:{anchor:at},effects:v.constructor.scrollIntoView(at,{y:'center'})});v.focus();});
    await page.waitForTimeout(200);
    const caret=await page.evaluate(()=>v.state.selection.main.head);
    const point=await page.evaluate(platform=>{const at=v.state.doc.toString().indexOf('Paragraph 26:');const r=v.coordsAtPos(at),factor=platform==='macOS'?1:devicePixelRatio;return {x:r.left*factor,y:(r.top+r.bottom)/2*factor};},platform);
    await page.evaluate(position=>emitNative('tauri://drag-enter',{paths:['/fixture/dropped.svg'],position}),point);
    assert.equal(await page.locator('#dropOverlay').isVisible(),false,'image drag leaves the document visible');
    await page.waitForSelector('.leaf-file-drop-cursor');
    assert.equal(await page.evaluate(()=>v.state.selection.main.head),caret,'hover does not move the typing caret');
    const first=await page.locator('.leaf-file-drop-cursor').boundingBox();
    const factor=platform==='macOS'?1:scale;
    assert.ok(Math.abs(first.x-point.x/factor)<2&&point.y/factor>=first.y&&point.y/factor<=first.y+first.height,`${platform} scale ${scale}: marker matches the mouse point`);
    assert.ok(await page.evaluate(()=>{
      const layer=document.querySelector('.cm-cursorLayer');
      return getComputedStyle(layer).visibility==='hidden'||getComputedStyle(layer).display==='none';
    }),'the original typing caret is hidden while dragging');
    const second=await page.evaluate(platform=>{const r=v.coordsAtPos(v.state.doc.toString().indexOf('Paragraph 27:')),factor=platform==='macOS'?1:devicePixelRatio;return {x:r.left*factor,y:(r.top+r.bottom)/2*factor};},platform);
    await page.evaluate(position=>emitNative('tauri://drag-over',{position}),second);
    await page.waitForFunction(y=>Math.abs(document.querySelector('.leaf-file-drop-cursor').getBoundingClientRect().top-y)>10,first.y);
    await page.evaluate(()=>emitNative('tauri://drag-leave',{}));
    assert.equal(await page.locator('.leaf-file-drop-cursor').count(),0,'leaving clears the insertion marker');
    assert.equal(await page.evaluate(()=>v.state.selection.main.head),caret,'cancel retains the old caret position');
    assert.equal(await page.evaluate(()=>v.dom.classList.contains('leaf-file-dragging')),false,'cancel restores the typing caret');
    await page.evaluate(position=>emitNative('tauri://drag-enter',{paths:['/fixture/dropped.svg'],position}),point);
    await page.evaluate(position=>emitNative('tauri://drag-drop',{paths:['/fixture/dropped.svg'],position}),point);
    await page.waitForFunction(()=>v.state.doc.toString().includes('![dropped]'));
    const result=await page.evaluate(()=>v.state.doc.toString());
    assert.ok(result.indexOf('Paragraph 25:')<result.indexOf('![dropped]')&&result.indexOf('![dropped]')<result.indexOf('Paragraph 26:'),'drop uses the shown target, not the old caret');
    assert.ok(result.startsWith('---\ntitle: Image drop\n---\n'),'properties remain intact');
    assert.equal(await page.locator('.leaf-file-drop-cursor').count(),0,'drop clears the insertion marker');
    await page.evaluate(position=>emitNative('tauri://drag-enter',{paths:['/fixture/open.md'],position}),point);
    assert.equal(await page.locator('#dropOverlay').isVisible(),true,'Markdown document drag still offers opening');
    await page.evaluate(()=>emitNative('tauri://drag-leave',{}));
    assert.deepEqual(errors,[]);
    await page.close();
  }
  console.log('PASS macOS/Windows native coordinate contracts at scale 1/1.5/2, aligned single marker, cancel and exact image drop');
}finally{await browser.close();}
