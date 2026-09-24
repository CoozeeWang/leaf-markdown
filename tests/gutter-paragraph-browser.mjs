import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:850}});
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
 await page.click('#displayButton');
 await page.check('#lineNumberToggle');
 await page.click('#displayButton');
 const doc='# 标题\n\n> 引用\n> 日期\n\n上一段\n\n\n\n\n下一段'+ '，这是一段用于验证自动折行后行号仍然对齐的正文'.repeat(8)+'\n\n最后一段';
 await page.evaluate(doc=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:doc},selection:{anchor:doc.indexOf('上一段')+3}});v.focus();},doc);
 const check=async()=>{
  await page.waitForTimeout(150);
  const errors=await page.evaluate(()=>[...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].filter(el=>el.style.visibility!=='hidden'&&el.textContent.trim()).map(el=>{
   const line=v.state.doc.line(Number(el.textContent));const block=v.lineBlockAt(line.from);
   // A filename widget can precede source line 1 in the same block.
   const b=Array.isArray(block.type)?block.type.find(part=>part.type===0):block;
   const coords=v.coordsAtPos(line.from);
   const range=document.createRange();range.selectNodeContents(el);
   const label=range.getBoundingClientRect();
   if(coords && Math.abs((label.top+label.bottom-coords.top-coords.bottom)/2)>2) throw new Error('Label does not align with first text line');
   return Math.abs(el.getBoundingClientRect().top-(v.documentTop+b.top));
  }));
  assert.ok(errors.every(x=>x<2),JSON.stringify(errors));
 };
 await check();await page.keyboard.press('Enter');await check();
 const newlines=async()=>page.evaluate(()=>(v.state.doc.toString().match(/\n/g)||[]).length);
 const base=await newlines();
 // Standing on the blank row Enter opened, each further Enter leaves one more
 // deliberate blank line -- one newline per press, never a stack that vanishes.
 await page.keyboard.press('Enter');
 assert.equal(await newlines(),base+1);
 await page.keyboard.press('Enter');
 assert.equal(await newlines(),base+2);
 await page.keyboard.type('test');await check();
 for(let i=0;i<4;i++)await page.keyboard.press('Backspace');
 await check();
 assert.equal(await newlines(),base+2,'deleting the text leaves the blanks you asked for');
 // Three Enter presses added three newlines; unwind them one at a time.
 for(let i=0;i<3;i++)await page.keyboard.press('Backspace');
 await check();
 assert.equal(await page.evaluate(()=>v.state.doc.toString()),doc);
 await page.setViewportSize({width:740,height:750});await check();
 await page.screenshot({path:artifactPath('leaf-gutter-fixed.png')});
 console.log('PASS gutter box alignment, repeated Enter, input and deletion');
}finally{await browser.close();}
