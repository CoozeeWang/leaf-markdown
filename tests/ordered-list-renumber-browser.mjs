import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try{
 const page=await browser.newPage({viewport:{width:1100,height:820}});
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
 const source=()=>page.evaluate(()=>v.state.doc.toString());
 const markers=()=>page.locator('.leaf-list-marker').allTextContents();
 const setup=text=>page.evaluate(text=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:0}});v.focus();},text);
 const deleteLine=text=>page.evaluate(text=>{const doc=v.state.doc.toString();const at=doc.indexOf(text);if(at<0)throw new Error('line not found: '+text);const end=doc.indexOf('\n',at);
  // A last line has no newline of its own: take the separator before it instead.
  v.dispatch({selection:{anchor:end<0?at-1:at,head:end<0?doc.length:end+1}});v.focus();},text);
 const caretAfter=text=>page.evaluate(text=>{const at=v.state.doc.toString().indexOf(text)+text.length;v.dispatch({selection:{anchor:at}});v.focus();},text);

 // Deleting a middle item closes the gap behind it, in the source the file
 // keeps and in the markers the editor draws.
 await setup('1. 第一项\n2. 第二项\n3. 第三项\n4. 第四项');
 await page.locator('.cm-content').click();await page.keyboard.press('ArrowLeft');await page.locator('.brand').click();
 await deleteLine('2. 第二项');await page.keyboard.press('Backspace');
 assert.equal(await source(),'1. 第一项\n2. 第三项\n3. 第四项');
 assert.deepEqual(await markers(),['1.','2.','3.']);
 await page.screenshot({path:artifactPath('ordered-list-renumber.png')});
 // One Cmd-Z takes back the deletion and the renumbering together.
 await page.click('#undoButton');assert.equal(await source(),'1. 第一项\n2. 第二项\n3. 第三项\n4. 第四项');
 await page.click('#redoButton');assert.equal(await source(),'1. 第一项\n2. 第三项\n3. 第四项');

 // Deleting the item that opened the list hands its start down: the rest of the
 // list counts again from 1.
 await setup('1. 第一项\n2. 第二项\n3. 第三项');await page.locator('.cm-content').click();await page.keyboard.press('ArrowLeft');
 await deleteLine('1. 第一项');await page.keyboard.press('Backspace');
 assert.equal(await source(),'1. 第二项\n2. 第三项');

 // A list the writer started at 5 keeps that start when its first item goes.
 await setup('5. 五\n6. 六\n7. 七');await page.locator('.cm-content').click();await page.keyboard.press('ArrowLeft');
 await deleteLine('5. 五');await page.keyboard.press('Backspace');
 assert.equal(await source(),'5. 六\n6. 七');

 // Deleting the last item only takes that item away.
 await setup('1. 一\n2. 二\n3. 三');await page.locator('.cm-content').click();await page.keyboard.press('ArrowLeft');
 await deleteLine('3. 三');await page.keyboard.press('Backspace');
 assert.equal(await source(),'1. 一\n2. 二');

 // A new item in the middle renumbers everything after it.
 await setup('1. 第一项\n2. 第二项\n3. 第三项');await page.locator('.cm-content').click();await page.keyboard.press('ArrowLeft');
 await caretAfter('2. 第二项');await page.keyboard.press('Enter');await page.keyboard.type('新的一项');
 assert.equal(await source(),'1. 第一项\n2. 第二项\n3. 新的一项\n4. 第三项');

 // A nested list renumbers its own level and leaves the outer one alone.
 const nested='1. 一\n2. 二\n   1. 甲\n   2. 乙\n   3. 丙\n3. 三';
 await setup(nested);await page.locator('.cm-content').click();await page.keyboard.press('ArrowLeft');
 await deleteLine('   2. 乙');await page.keyboard.press('Backspace');
 assert.equal(await source(),'1. 一\n2. 二\n   1. 甲\n   2. 丙\n3. 三');

 // Unordered lists keep their bullets; nothing about them is rewritten.
 await setup('- 一\n- 二\n- 三');await page.locator('.cm-content').click();await page.keyboard.press('ArrowLeft');
 await deleteLine('- 二');await page.keyboard.press('Backspace');
 assert.equal(await source(),'- 一\n- 三');

 console.log('PASS ordered list renumbering: delete middle/first/last, insert, nesting, bullets untouched, undo/redo');
}finally{await browser.close();}
