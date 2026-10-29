import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const cases=JSON.parse(fs.readFileSync(new URL('./app-link-cases.json',import.meta.url)));
for(const engine of (process.env.LEAF_APP_LINK_ENGINE==='webkit' ? [webkit] : [chromium])) {
 console.log(`Starting ${engine.name()} application-link regression`);
 const browser=await engine.launch({headless:true,...(engine===chromium && process.env.LEAF_BROWSER_CHANNEL ? {channel:process.env.LEAF_BROWSER_CHANNEL} : {})});
 try {
  const page=await browser.newPage({locale:'zh-CN'});page.setDefaultTimeout(20000);
  page.on('pageerror',error=>console.error(error.message));
  await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
  await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
  for(const mode of ['edit','source']) {
   console.log(`Checking ${engine.name()} ${mode} paste`);
   if(mode==='source'){await page.click('#readingToggle');await page.locator('[data-mode=source]').click();}
   const result=await page.evaluate(async({url,invalid})=>{
    v.dispatch({changes:{from:0,to:v.state.doc.length,insert:''},selection:{anchor:0}});v.focus();
    const data=new DataTransfer();data.setData('text/html',`<div>合成说话人 [00:10–00:20] (2)</div><p>合成正文</p><a href="${url}">合成访谈</a>`);data.setData('text/plain','plain fallback without link');
    document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
    const markdown=v.state.doc.toString();
    const {renderInline}=await import('/src/inline-preview.js');const {htmlToMarkdown}=await import('/src/html-markdown.js');
    const root=document.createElement('div');renderInline(root,markdown);
    const link=root.querySelector('[data-leaf-link]');
    const {renderPrintDocument}=await import('/src/print-document.js');const print=document.createElement('div');renderPrintDocument(print,markdown,{fallbackTitle:false});
    const unsafe=invalid.map(url=>htmlToMarkdown(`<a href="${url.replaceAll('&','&amp;').replaceAll('"','&quot;')}">label</a>`));
    return {markdown,target:link?.dataset.leafLink,label:link?.textContent,print:print.innerHTML,unsafe};
   },{url:cases.valid[0],invalid:cases.invalid});
   assert.ok(result.markdown.includes('\\[00:10–00:20\\] (2)'));
   assert.ok(result.markdown.includes(`[合成访谈](${cases.valid[0]})`));
   assert.equal(result.target,cases.valid[0]);assert.equal(result.label,'合成访谈');
   assert.ok(result.print.includes('ripple-segment-dev:'));
   assert.ok(result.unsafe.every(x=>x==='label'));
  }
  console.log(`PASS ${engine.name()}: HTML paste edit/source, timestamp escaping, named link roundtrip/render/export, unsafe href stripping`);
 } finally {await browser.close();}
}
