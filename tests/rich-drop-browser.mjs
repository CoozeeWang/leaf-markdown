import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const url=JSON.parse(fs.readFileSync(new URL('./app-link-cases.json',import.meta.url))).valid[1];
for(const engine of [chromium,webkit]){
 const browser=await engine.launch({headless:true});
 try{
  const page=await browser.newPage({locale:'zh-CN'});page.setDefaultTimeout(20000);
  await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
  await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
  const seed='# 合成文档\n\n目标位置\n\n尾段';
  for(const mode of ['edit','source']){
   if(mode==='source'){await page.click('#readingToggle');await page.locator('[data-mode=source]').click();}
   const result=await page.evaluate(({seed,url})=>{
    v.dispatch({changes:{from:0,to:v.state.doc.length,insert:seed},selection:{anchor:seed.length}});v.focus();
    const at=seed.indexOf('目标位置');const pos=v.coordsAtPos(at);const data=new DataTransfer();
    data.setData('text/plain','WRONG PLAIN FALLBACK');data.setData('text/html',`<p>合成说话人 [00:10–00:20] (2)</p><p>合成正文</p><p><a href="${url}">合成访谈</a></p>`);
    v.contentDOM.dispatchEvent(new DragEvent('dragover',{dataTransfer:data,clientX:pos.left+1,clientY:(pos.top+pos.bottom)/2,bubbles:true,cancelable:true}));
    const event=new DragEvent('drop',{dataTransfer:data,clientX:pos.left+1,clientY:(pos.top+pos.bottom)/2,bubbles:true,cancelable:true});v.contentDOM.dispatchEvent(event);
    return {doc:v.state.doc.toString(),prevented:event.defaultPrevented};
   },{seed,url});
   assert.equal(result.prevented,true);assert.ok(result.doc.includes(`[合成访谈](${url})`));assert.equal(result.doc.match(/合成访谈/g).length,1);assert.ok(!result.doc.includes('WRONG'));
   assert.ok(result.doc.indexOf('合成说话人')<result.doc.indexOf('目标位置'));
   await page.waitForFunction(()=>!document.querySelector('.cm-dropCursor'));
   await page.click('#undoButton');assert.equal(await page.evaluate(()=>v.state.doc.toString()),seed);
  }
  await page.click('#readingToggle');await page.locator('[data-mode=edit]').click();
  const escaped='合成说话人 \\[00:10–00:20\\] (2)\n\n尾段';
  await page.evaluate(s=>v.dispatch({changes:{from:0,to:v.state.doc.length,insert:s},selection:{anchor:s.length}}),escaped);
  await page.waitForFunction(()=>!document.querySelector('.cm-content').innerText.includes('\\['));
  assert.equal(await page.evaluate(()=>v.state.doc.toString()),escaped);
  await page.click('#readingToggle');await page.locator('[data-mode=source]').click();assert.ok((await page.locator('.cm-content').innerText()).includes('\\['));
  // Internal drag remains owned by CodeMirror; no rich HTML duplicate insertion.
  await page.evaluate(()=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'alpha beta'},selection:{anchor:0,head:5}});});
  const internal=await page.evaluate(()=>{const data=new DataTransfer();v.contentDOM.dispatchEvent(new DragEvent('dragstart',{dataTransfer:data,bubbles:true}));data.setData('text/html','<b>WRONG INTERNAL HTML</b>');data.setData('text/plain','alpha');const p=v.coordsAtPos(v.state.doc.length);v.contentDOM.dispatchEvent(new DragEvent('drop',{dataTransfer:data,clientX:p.left,clientY:(p.top+p.bottom)/2,bubbles:true,cancelable:true}));v.contentDOM.dispatchEvent(new DragEvent('dragend',{dataTransfer:data,bubbles:true}));return v.state.doc.toString();});
  assert.ok(!internal.includes('WRONG'));assert.equal(internal.match(/alpha/g).length,1);
  console.log(`PASS ${engine.name()}: external rich drop position/one undo/source mode, escaped timestamp preview and internal move`);
 }finally{await browser.close();}
}
