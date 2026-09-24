import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{
  const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
  window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));
 });
 const setup=(doc,head)=>page.evaluate(({doc,head})=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:doc},selection:{anchor:head},scrollIntoView:true});v.focus()},{doc,head});
 const source=()=>page.evaluate(()=>v.state.doc.toString());
 const y=()=>page.evaluate(()=>v.coordsAtPos(v.state.selection.main.head).top);
 for(const doc of ['上段','上段\n\n下段','上段  \n\n下段']) {
  const end=doc.indexOf('\n')<0?doc.length:doc.indexOf('\n');
  await setup(doc,end);await page.keyboard.press('Enter');await page.waitForTimeout(150);
  const before=await y();
  assert.equal(await source(),doc.slice(0,end)+'\n'+doc.slice(end));
  await page.keyboard.insertText('文');await page.waitForTimeout(150);
  assert.ok(Math.abs(await y()-before)<2,`caret moved after first character in ${JSON.stringify(doc)}`);
  await page.keyboard.press('Backspace');await page.waitForTimeout(100);
  assert.ok(Math.abs(await y()-before)<2,'caret moved after deleting last character');
  // One Backspace reverses the one newline inserted by Enter.
  await page.keyboard.press('Backspace');
  assert.equal(await source(),doc,`unwinding ${JSON.stringify(doc)}`);
 }
 await setup('甲\n\n乙\n\n丙',3);
 await page.evaluate(()=>v.dispatch({selection:{anchor:3,head:4}}));
 await page.keyboard.press('Backspace');assert.equal(await source(),'甲\n\n丙');
 await page.keyboard.press('ControlOrMeta+z');assert.equal(await source(),'甲\n\n乙\n\n丙');
 await setup('# 原标题\n\n正文\n\n## 子标题 ##',0);
 await page.click('#outlineButton');
 await page.getByRole('button',{name:'子标题',exact:true}).dblclick();
 const rename=page.getByRole('textbox',{name:'修改标题'});
 await rename.fill('新子标题');await rename.press('Enter');
 assert.equal(await source(),'# 原标题\n\n正文\n\n## 新子标题 ##');
 await page.getByRole('button',{name:'新子标题',exact:true}).dblclick();
 await rename.fill('取消修改');await rename.press('Escape');
 assert.ok((await source()).includes('## 新子标题 ##'));
 await page.locator('.cm-content').click();await page.keyboard.press('ControlOrMeta+z');
 assert.ok((await source()).includes('## 子标题 ##'));
 assert.deepEqual(errors,[]);
 console.log('PASS: caret Y stable before/after first and last character; one-step empty paragraph removal; outline double-click rename/cancel/undo');
}finally{await browser.close()}
