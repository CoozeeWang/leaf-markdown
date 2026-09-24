import {chromium,launchOptions} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'# 标题\n\n正文'},selection:{anchor:8}});});
 for(const mode of ['source','reading','edit','reading','source','edit']){
  await page.click('#readingToggle');await page.locator(`[data-mode=${mode}]`).click();
  assert.equal(await page.locator('.cm-source-mode').count(),mode==='source'?1:0);
  assert.equal(await page.locator('.shell').evaluate(e=>e.classList.contains('reading-mode')),mode==='reading');
  assert.equal(await page.evaluate(()=>v.state.doc.toString()),'# 标题\n\n正文');
 }
 await page.click('#readingToggle');await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
 assert.equal(await page.locator('.cm-source-mode').count(),1);
 assert.deepEqual(errors,[]);console.log('PASS one mode menu, all transitions preserve source, keyboard selection');
}finally{await browser.close();}
