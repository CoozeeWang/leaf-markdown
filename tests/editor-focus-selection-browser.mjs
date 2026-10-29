import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import sharp from 'sharp';
import {artifactPath} from './browser-runtime.mjs';

for(const engine of [chromium,webkit]) {
 const browser=await engine.launch({headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1100,height:900}});
  await page.goto(process.env.LEAF_TEST_BASE_URL||'http://127.0.0.1:41732');await page.locator('#welcomeNewButton').click();
  await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('#editor .cm-content'));});
  const load=(doc,head=0)=>page.evaluate(({doc,head})=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:doc},selection:{anchor:head},scrollIntoView:true});v.focus();},{doc,head});
  const formats=['==sample==','**sample**','*sample*','~~sample~~','`sample`','[sample](https://example.com)','<sup>sample</sup>','<sub>sample</sub>','## sample','> sample'];
  for(const format of formats) {
   const source=`${format}\n\nOrdinary paragraph\n\n> [!note] Synthetic title\n> Synthetic body\n\n`;
   await load(source,format.indexOf('sample')+2);
   const line=page.locator('#editor .cm-line').first();
   assert.equal(await line.textContent(),format);
   for(const field of ['title','body']) {
    await page.locator(`.leaf-callout-${field} .leaf-callout-preview`).click({position:{x:5,y:5}});
    await page.waitForFunction(()=>!v.hasFocus);
    assert.equal((await line.textContent()).trim(),'sample',`${engine.name()} ${format}: source hides on ${field} focus`);
    assert.equal(await page.evaluate(()=>v.state.doc.toString()),source);
    await page.evaluate(at=>{v.dispatch({selection:{anchor:at}});v.focus();},format.indexOf('sample')+2);
    assert.equal(await line.textContent(),format,'returning to the retained caret exposes source');
   }
  }
  const source='Before ABC\n\n> [!note] Synthetic title\n> Body one.\n> Body two.\n\nAfter XYZ\n\n> [!note]- Folded title\n> Hidden body\n\nEnd.';
  for(const theme of ['light','dark'])for(const zoom of [75,100,150]) {
   await page.evaluate(({theme,zoom})=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty('--editor-font-size',`${18*zoom/100}px`);},{theme,zoom});
   await load(source);
   const box=page.locator('.leaf-callout').first();
   const bounds=await box.boundingBox();
   const color=async()=>{const png=await page.screenshot();return [...await sharp(png).extract({left:Math.floor(bounds.x+bounds.width-12),top:Math.floor(bounds.y+70*zoom/100),width:1,height:1}).removeAlpha().raw().toBuffer()];};
   const before=await color();
   const points=await page.evaluate(()=>{let s=v.state.doc.toString();const rect=at=>{const r=v.coordsAtPos(at);return {x:r.left,y:(r.top+r.bottom)/2};};return {a:rect(s.indexOf('ABC')),b:rect(s.indexOf('XYZ')+3)};});
   for(const reverse of [false,true]) {
    const a=reverse?points.b:points.a,b=reverse?points.a:points.b;
    await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:25});await page.mouse.up();
    const evidence=await page.evaluate(()=>{const r=v.state.selection.main,d=new DataTransfer();v.contentDOM.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:d}));const w=document.querySelector('.leaf-callout-widget'),o=getComputedStyle(w.querySelector('.leaf-callout'),'::after');return {text:v.state.doc.sliceString(r.from,r.to),copy:d.getData('text/plain'),selected:w.classList.contains('leaf-block-selected'),opacity:o.opacity,pointer:o.pointerEvents};});
    assert.equal(evidence.text,'ABC\n\n> [!note] Synthetic title\n> Body one.\n> Body two.\n\nAfter XYZ');
    assert.equal(evidence.copy,evidence.text);assert.ok(evidence.selected);assert.equal(evidence.opacity,'0.28');assert.equal(evidence.pointer,'none');
    assert.notDeepEqual(await color(),before,'actual body pixels show selection tint');
   }
   if(zoom===100)await page.screenshot({path:artifactPath(`callout-selection-${engine.name()}-${theme}.png`)});
  }
  await page.evaluate(()=>{const s=v.state.doc.toString();v.dispatch({selection:{anchor:0,head:s.length}});v.focus();});
  assert.equal(await page.locator('.leaf-callout-widget.leaf-block-selected').count(),2,'folded and ordinary callouts both selected');
  await page.keyboard.press('Backspace');assert.equal(await page.evaluate(()=>v.state.doc.toString()),'');
  await page.keyboard.press('ControlOrMeta+z');assert.equal(await page.evaluate(()=>v.state.doc.toString()),source);
  await page.locator('.leaf-callout-body .leaf-callout-preview').first().click();
  assert.equal(await page.locator('.leaf-callout').first().evaluate(n=>getComputedStyle(n,'::after').display),'none','nested text selection is not double-painted');
  console.log(engine.name()+': format focus, real cross-callout selection pixels, copy, folded blocks and deletion/undo passed');
 } finally {await browser.close();}
}
