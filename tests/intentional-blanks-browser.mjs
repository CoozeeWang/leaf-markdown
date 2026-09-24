import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
 const setup=(doc,anchor=doc.length)=>page.evaluate(({doc,anchor})=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:doc},selection:{anchor}});v.focus();},{doc,anchor});
 const value=()=>page.evaluate(()=>v.state.doc.toString());
 const line=()=>page.evaluate(()=>v.state.doc.lineAt(v.state.selection.main.head).number);
 const head=()=>page.evaluate(()=>v.state.selection.main.head);
 const newlines=text=>(text.match(/\n/g)??[]).length;
 const blank=page.locator('.cm-leaf-blank-line');
 const row=await page.evaluate(()=>parseFloat(getComputedStyle(document.querySelector('.cm-content')).fontSize) * 1.25);

 // Each Enter writes one newline; a second Enter creates a blank line.
 await setup('正文');await page.keyboard.press('Enter');
 assert.equal(await value(),'正文\n');
 // The second Enter leaves one actual blank separator.
 await page.keyboard.press('Enter');assert.equal(await value(),'正文\n\n');
 await page.keyboard.press('Backspace');assert.equal(await value(),'正文\n');
 await page.keyboard.type('tail');assert.equal(await value(),'正文\ntail');

 // A run of blanks already in the file draws as that many rows -- three blanks
 // asked for three rows, so three rows is what the editor gives.
 await setup('甲\n\n\n\n乙',0);
 assert.equal(await blank.count(),3);
 assert.ok(await blank.evaluateAll((es,h)=>es.every(e=>Math.abs(e.getBoundingClientRect().height-h)<1),row));
 const stacked=await page.evaluate(()=>{const l=[...document.querySelectorAll('.cm-line')];return l.find(e=>e.textContent==='乙').getBoundingClientRect().top-l.find(e=>e.textContent==='甲').getBoundingClientRect().bottom;});
 assert.ok(Math.abs(stacked-row*3)<2,'three blank lines read as three rows');
 await page.screenshot({path:artifactPath('leaf-blank-run-stacked.png')});

 // Arrows walk the run one row at a time; Backspace unwinds it one row per press.
 await page.evaluate(()=>{v.dispatch({selection:{anchor:1}});v.focus();});
 for(const want of [2,3,4,5]) {await page.keyboard.press('ArrowDown');assert.equal(await line(),want);}
 await page.keyboard.press('ArrowUp');assert.equal(await line(),4);
 await page.keyboard.press('ArrowRight');assert.equal(await head(),5);
 await page.keyboard.press('ArrowLeft');assert.equal(await head(),4);
 await setup('甲\n\n\n\n乙',5);
 for(const want of ['甲\n\n\n乙','甲\n\n乙','甲\n乙','甲乙']) {
  await page.keyboard.press('Backspace');
  assert.equal(await value(),want);
 }
 await page.keyboard.press('ControlOrMeta+z');assert.equal(await value(),'甲\n乙');
 await page.keyboard.press('ControlOrMeta+Shift+z');assert.equal(await value(),'甲乙');
 await setup('甲\n\n\n\n乙',5);
 await page.keyboard.press('Backspace');assert.equal(await value(),'甲\n\n\n乙');
 await page.keyboard.press('ControlOrMeta+z');assert.equal(await value(),'甲\n\n\n\n乙');
 await page.keyboard.press('ControlOrMeta+Shift+z');assert.equal(await value(),'甲\n\n\n乙');

 // The file keeps its blanks: only an edit of your own changes them.
 const mode=async name=>{await page.click('#readingToggle');await page.locator(`[data-mode=${name}]`).click();};
 await mode('source');assert.equal(await value(),'甲\n\n\n乙');
 await mode('edit');assert.equal(await value(),'甲\n\n\n乙');
 await setup('甲\n\n\n\n乙',0);
 await mode('source');assert.equal(await value(),'甲\n\n\n\n乙');
 await mode('edit');assert.equal(await value(),'甲\n\n\n\n乙');

 // Lists continue with their own marker and code blocks keep literal blanks.
 await setup('- 列表');await page.keyboard.press('Enter');await page.keyboard.type('第二项');
 assert.equal(await value(),'- 列表\n- 第二项');
 const code='```\na\n\n\nb\n```';
 await setup(code,5);await page.keyboard.press('Enter');
 assert.equal(newlines(await value())-newlines(code),1,'a code block keeps a plain newline');
 assert.equal(await blank.count(),0,'code blanks are content, not a separator');
 assert.deepEqual(errors,[]);
 console.log('PASS Enter writes one newline and a second Enter creates a blank, runs draw one row each, arrows walk and Backspace unwinds one layer per press, the file keeps its bytes, lists and code unchanged');
} finally {await browser.close();}
