import {chromium,launchOptions} from './browser-runtime.mjs';
import {desktopImageFixture} from './fixtures/desktop-image.mjs';
import assert from 'node:assert/strict';
import {webkit} from 'playwright';
const source='---\ntitle: Image drop\n---\n\n'+Array.from({length:45},(_,i)=>`Paragraph ${i+1}: a distinct insertion target.`).join('\n\n');
for(const [engine,options] of [[chromium,launchOptions],[webkit,{headless:true}]]) {
const browser=await engine.launch(options);
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
    // Use the rendered text row, not the editor's default caret rectangle:
    // at a soft wrap, one source position belongs to two different rows.
    await page.evaluate(()=>{
      const doc='---\ntitle: Wrapped drop\n---\n\nWrapped target: '+('图片拖放位置应与鼠标所在的视觉行一致。'.repeat(16));
      v.dispatch({changes:{from:0,to:v.state.doc.length,insert:doc},selection:{anchor:doc.indexOf('Wrapped target:')},scrollIntoView:true});v.focus();
    });
    await page.waitForTimeout(150);
    const wrapPoint=await page.evaluate(platform=>{
      const line=Array.from(v.contentDOM.querySelectorAll('.cm-line')).find(el=>el.textContent.startsWith('Wrapped target:'));
      const range=document.createRange();range.selectNodeContents(line);
      const rects=Array.from(range.getClientRects()).filter(r=>r.height>0);
      if(!rects.some(r=>r.top>rects[0].top+10))throw Error('fixture must wrap across visual rows');
      const first=rects[0],bounds=line.getBoundingClientRect(),factor=platform==='macOS'?1:devicePixelRatio;
      return {x:(bounds.right-8)*factor,y:(first.top+first.bottom)/2*factor};
    },platform);
    await page.evaluate(position=>emitNative('tauri://drag-enter',{paths:['/fixture/dropped.svg'],position}),wrapPoint);
    await page.waitForSelector('.leaf-file-drop-cursor');
    const wrappedMarker=await page.locator('.leaf-file-drop-cursor').boundingBox();
    assert.ok(wrapPoint.y/factor>=wrappedMarker.y&&wrapPoint.y/factor<=wrappedMarker.y+wrappedMarker.height,`${engine.name()}/${platform}/${scale}: a wrapped-row end must not draw the marker on the next row`);
    const nextRow=await page.evaluate(platform=>{
      const line=Array.from(v.contentDOM.querySelectorAll('.cm-line')).find(el=>el.textContent.startsWith('Wrapped target:'));
      const range=document.createRange();range.selectNodeContents(line);
      const rects=Array.from(range.getClientRects()).filter(r=>r.height>0),second=rects.find(r=>r.top>rects[0].top+10);
      const factor=platform==='macOS'?1:devicePixelRatio;
      return {x:second.left*factor,y:(second.top+second.bottom)/2*factor};
    },platform);
    await page.evaluate(position=>emitNative('tauri://drag-over',{position}),nextRow);
    await page.waitForFunction(y=>{
      const r=document.querySelector('.leaf-file-drop-cursor').getBoundingClientRect();return y>=r.top&&y<=r.bottom;
    },nextRow.y/factor);
    await page.evaluate(()=>emitNative('tauri://drag-leave',{}));
    assert.deepEqual(errors,[]);
    await page.close();
  }
  console.log(`PASS ${engine.name()}: macOS/Windows native coordinate contracts at scale 1/1.5/2, aligned single marker including both sides of soft wraps, cancel and exact image drop`);
}finally{await browser.close();}
}
