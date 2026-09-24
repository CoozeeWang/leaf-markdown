import {chromium,launchOptions} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
 await page.click('#notesButton');
 const source=()=>page.evaluate(()=>v.state.doc.toString());
 const setup=text=>page.evaluate(text=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:0}});v.focus();},text);
 const select=marker=>page.evaluate(marker=>{const from=v.state.doc.toString().indexOf(marker);v.dispatch({selection:{anchor:from,head:from+marker.length}});v.focus();},marker);
 const original='甲[^1] 再引[^1] 乙[^2]\n\n[^1]: 第一条\n    续行\n[^2]: 第二条';
 await setup(original);await select('[^1]');await page.keyboard.press('Backspace');
 assert.ok((await source()).includes('[^1]: 第一条'));
 const once=await source();await select('[^1]');await page.keyboard.press('Backspace');
 assert.ok(!(await source()).includes('第一条'));assert.equal(await page.locator('.note-card').count(),1);
 assert.equal(await page.locator('.note-body').inputValue(),'第二条');
 await page.click('#undoButton');assert.equal(await source(),once);assert.equal(await page.locator('.note-card').count(),2);
 await page.click('#redoButton');assert.equal(await page.locator('.note-card').count(),1);
 await setup('甲[^note]\n\n[^note]: 内容');
 await page.evaluate(()=>{v.dispatch({selection:{anchor:8}});v.focus();});
 await page.keyboard.press('Backspace');assert.ok(!(await source()).includes('[^note]'));
 assert.equal(await page.locator('.note-card').count(),0);
 await setup('甲[^note] 乙\n\n[^note]: 保留内容');await select('[^note]');
 await page.evaluate(()=>{const data=new DataTransfer();document.activeElement.dispatchEvent(new ClipboardEvent('cut',{bubbles:true,cancelable:true,clipboardData:data}));window.cutText=data.getData('text/plain');});
 assert.ok((await source()).includes('[^note]: 保留内容'));
 assert.equal(await page.evaluate(()=>window.cutText),'[^note]');
 await page.evaluate(()=>{v.dispatch({selection:{anchor:2}});v.focus();const data=new DataTransfer();data.setData('text/plain',window.cutText);document.activeElement.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});
 assert.equal(await page.locator('.note-card[data-state="complete"]').count(),1);
 assert.equal(await page.locator('.note-body').inputValue(),'保留内容');
 // Native-style textarea input paths (Callout and table) must tag cuts too.
 for(const text of ['> [!NOTE]\n> 甲[^note]乙\n\n[^note]: 内容','| A |\n| --- |\n| 甲[^note]乙 |\n\n[^note]: 内容']){
  await setup(text);
  await page.locator(text.startsWith('>')?'.leaf-callout-body .leaf-callout-preview':'td .leaf-cell-preview').first().click();
  const input=page.locator(text.startsWith('>')?'.leaf-callout-body textarea':'textarea[data-row="1"][data-col="0"]');
  await input.evaluate(el=>{el.focus();const at=el.value.indexOf('[^note]');el.setSelectionRange(at,at+7);});
  await page.keyboard.press('Backspace');assert.ok(!(await source()).includes('[^note]:'));
  await page.click('#undoButton');assert.equal(await source(),text);
 }
 const ordered='甲[^1] 乙[^2] 丙[^3]\n\n[^1]: A\n[^2]: B\n[^3]: C';
 await setup(ordered);await select('[^3]');
 await page.evaluate(()=>{const data=new DataTransfer();document.activeElement.dispatchEvent(new ClipboardEvent('cut',{bubbles:true,cancelable:true,clipboardData:data}));window.cutText=data.getData('text/plain');});
 const cut=await source();
 await page.evaluate(()=>{v.dispatch({selection:{anchor:0}});v.focus();const data=new DataTransfer();data.setData('text/plain',window.cutText);document.activeElement.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});
 assert.equal(await source(),'[^1]甲[^2] 乙[^3] 丙\n\n[^1]: C\n[^2]: A\n[^3]: B');
 assert.deepEqual(await page.locator('.note-body').evaluateAll(nodes=>nodes.map(n=>n.value)),['C','A','B']);
 await page.click('#undoButton');assert.equal(await source(),cut);
 await page.click('#redoButton');assert.ok((await source()).endsWith('[^1]: C\n[^2]: A\n[^3]: B'));
 console.log('PASS last-reference deletion, repeated references, sidebar sync, undo/redo, cut/paste definition order, Callout and table');
}finally{await browser.close();}
