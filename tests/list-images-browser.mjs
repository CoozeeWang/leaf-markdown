import {chromium, launchOptions, artifactPath} from './browser-runtime.mjs';
import {webkit} from 'playwright';
import {desktopImageFixture} from './fixtures/desktop-image.mjs';
import assert from 'node:assert/strict';

for (const [name, engine, options] of [['chromium',chromium,launchOptions],['webkit',webkit,{headless:true}]]) {
 const browser=await engine.launch(options);
 try {
  let page=await browser.newPage({viewport:{width:1100,height:800}});const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await desktopImageFixture(page,'- First\n- Second');
  const set=async source=>page.evaluate(source=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source},selection:{anchor:Math.max(0,source.indexOf('!['))}});v.focus();},source);
  const get=()=>page.evaluate(()=>v.state.doc.toString());
  const belongs=()=>page.evaluate(async()=>{
   const {imageLines}=await import('/src/image-list-indent.js');
   return [...imageLines(v.state).values()].map(image=>Boolean(image.item));
  });
  const verifyViews=async expected=>{
   assert.deepEqual(await belongs(),[expected]);
   // Move the caret out of the image source to display its preview.
   await page.evaluate(()=>v.dispatch({selection:{anchor:v.state.doc.length}}));
   await page.waitForSelector('img[data-loaded=yes]');
   assert.equal(await page.locator('.cm-line:has(.leaf-image)').evaluate(line=>line.classList.contains('cm-leaf-nested-list')),expected,'preview indentation matches source list membership');
   assert.equal(await page.evaluate(async()=>{
    const {renderPrintDocument}=await import('/src/print-document.js');
    const root=document.createElement('div');renderPrintDocument(root,v.state.doc.toString(),{fallbackTitle:false});
    return Boolean(root.querySelector('.leaf-image').closest('li'));
   }),expected,'reading and export match editor membership');
  };
  for(const source of [
   '- First\n![photo](assets/photo.svg)\n- Second',
   '- First\n  ![photo](assets/photo.svg)\n- Second',
   '- First\n![photo](assets/photo.svg)\n\nBody',
   '- First\n  ![photo](assets/photo.svg)\nBody\n- Second',
   '1. First\n   ![photo](assets/photo.svg)\n2. Second',
   '- Parent\n  - First\n    ![photo](assets/photo.svg)\n  - Second',
  ]) {
   await set(source);
   await verifyViews(true);
   await page.evaluate(()=>{const at=v.state.doc.toString().indexOf('![');v.dispatch({selection:{anchor:at}});v.focus();});
   // Outdent all source whitespace, including nested and wider ordered markers.
   const steps=Math.max(1,Math.ceil(/^\s*/.exec(source.split('\n').find(line=>line.includes('![')))[0].length/2));
   for(let i=0;i<steps;i++)await page.keyboard.press('Shift+Tab');
   const detached=await get();
   assert.match(detached,/\n\n!\[photo\]/,'fully outdented image has a real paragraph boundary');
   assert.equal(detached.replace(/\s*!\[photo\]\(assets\/photo.svg\)/,'\nIMAGE'),source.replace(/\s*!\[photo\]\(assets\/photo.svg\)/,'\nIMAGE'),'neighboring text and list markers stay unchanged');
   await verifyViews(false);
   await page.keyboard.press('ControlOrMeta+z');
   if(steps===1)assert.equal(await get(),source,'one undo restores indentation and inserted separator together');
   await page.keyboard.press('ControlOrMeta+Shift+z');
   assert.equal(await get(),detached);
   await page.evaluate(()=>{const at=v.state.doc.toString().indexOf('![');v.dispatch({selection:{anchor:at}});v.focus();});
   await page.keyboard.press('Shift+Tab');
   assert.equal(await get(),detached,'repeated outdent adds no blank lines');
  }
  // Real users click the rendered image before pressing Shift+Tab. A direct
  // dispatch to the image source misses focus and widget event problems.
  await set('- First\n![photo](assets/photo.svg)\n- Second');
  await verifyViews(true);
  await page.locator('.cm-line .leaf-image').click();
  const clicked=await page.evaluate(()=>({focus:v.hasFocus,line:v.state.doc.lineAt(v.state.selection.main.head).text}));
  assert.equal(clicked.focus,true,'clicking the preview focuses the editor');
  assert.match(clicked.line,/!\[photo\]/);
  await page.keyboard.press('Shift+Tab');
  assert.match(await get(),/^- First\n\n!\[photo\]/,'Shift+Tab after clicking the preview detaches it');
  await set('- First\n![photo](assets/photo.svg)\n- Second');
  await page.click('#readingToggle');await page.locator('[data-mode=source]').click();
  await page.evaluate(()=>{v.dispatch({selection:{anchor:v.state.doc.toString().indexOf('![')}});v.focus();});
  await page.keyboard.press('Shift+Tab');
  assert.equal(await get(),'- First\n\n![photo](assets/photo.svg)\n- Second','source mode can also exit a lazy continuation');
  assert.ok(await page.evaluate(async()=>{const {sourceMode}=await import('/src/view-mode.js');return v.state.field(sourceMode);}), 'outdent preserves source mode');
  await page.click('#readingToggle');await page.locator('[data-mode=edit]').click();
  // Editing the separator explicitly follows normal Markdown semantics.
  await page.evaluate(()=>{v.dispatch({changes:{from:8,to:9,insert:''}});});
  await verifyViews(true);
  await page.evaluate(()=>{v.dispatch({selection:{anchor:8}});v.focus();});
  await page.keyboard.press('Shift+Tab');
  await verifyViews(false);
  await set('- First\n  ![photo](assets/photo.svg)\n  ![other](assets/other.svg)\n- Second');
  await page.evaluate(()=>{const source=v.state.doc.toString();v.dispatch({selection:{anchor:source.indexOf('  !['),head:source.indexOf('\n- Second')}});v.focus();});
  await page.keyboard.press('Shift+Tab');
  assert.deepEqual(await belongs(),[false,false],'selected image lines can leave the list together');
  assert.match(await get(),/^- First\n\n!\[photo\].*\n\n!\[other\].*\n- Second$/);
  // Current insertion defaults to an independent paragraph between list items.
  await set('- First\n- Second');
  await page.evaluate(()=>{v.dispatch({selection:{anchor:v.state.doc.toString().indexOf('- Second')}});v.focus();});
  await page.click('#imageInsert');
  await page.waitForFunction(()=>v.state.doc.toString().includes('![toolbar]'));
  const inserted=await get();
  await verifyViews(false);
  await page.evaluate(()=>{v.dispatch({selection:{anchor:v.state.doc.toString().indexOf('![toolbar]')}});v.focus();});
  await page.keyboard.press('Tab');
  await verifyViews(true);
  await page.evaluate(()=>{v.dispatch({selection:{anchor:v.state.doc.toString().indexOf('![toolbar]')}});v.focus();});
  await page.keyboard.press('Shift+Tab');
  assert.equal(await get(),inserted);
  await page.keyboard.press('ControlOrMeta+s');
  await page.waitForFunction(()=>window.disk===v.state.doc.toString());
  const saved=await page.evaluate(()=>window.disk);
  await page.close();page=await browser.newPage({viewport:{width:1100,height:800}});
  page.on('pageerror',error=>errors.push(error.message));
  await desktopImageFixture(page,saved);
  assert.equal(await get(),inserted,'save and reopen preserve the chosen structure');
  await verifyViews(false);
  await page.screenshot({path:artifactPath(`list-images-${name}.png`)});
  // Ordinary lazy text continuations and literal code are unchanged.
  await set('- First\ncontinuation\n- Second');
  await page.evaluate(()=>{v.dispatch({selection:{anchor:8}});v.focus();});
  await page.keyboard.press('Shift+Tab');
  assert.equal(await get(),'- First\ncontinuation\n- Second');
  assert.deepEqual(errors,[]);
  console.log(`PASS ${name}: list image outdent, reindent, preview/export, neighbors, undo/redo, insertion and simulated save/reopen`);
 } finally {await browser.close();}
}
