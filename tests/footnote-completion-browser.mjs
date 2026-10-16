import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('#editor .cm-content'));});
 const setDoc=text=>page.evaluate(t=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:t},selection:{anchor:0}});v.focus();},text);
 const caret=at=>page.evaluate(at=>{v.dispatch({selection:{anchor:at}});v.focus();},at);
 const doc=()=>page.evaluate(()=>v.state.doc.toString());
 const original='正文[^1] ==高亮段落[^6==\n\n[^1]: 第一条';
 await setDoc(original);await caret(original.indexOf('==',original.indexOf('==')+2));
 await page.keyboard.type(']');
 assert.equal(await doc(),'正文[^1] ==高亮段落[^2]==\n\n[^1]: 第一条\n\n[^2]:');
 await page.click('#notesButton');
 assert.equal(await page.locator('#notesCount').textContent(),'2');
 assert.equal(await page.locator('.note-card[data-state="undefined"]').count(),0);
 await page.locator('.note-card[data-label="2"] .cm-content').fill('手打脚注内容');
 assert.ok((await doc()).endsWith('[^2]: 手打脚注内容'));
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode="reading"]').click();
 assert.deepEqual(await page.locator('.reading-document .footnote-ref').allTextContents(),['1','2']);
 assert.ok((await page.locator('.reading-document').innerText()).includes('手打脚注内容'));
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode="edit"]').click();
 // Existing incomplete notes remain unchanged on open; explicit editing fills the gap.
 const missing='正文[^1] 旧引用[^6]\n\n[^1]: 第一条';
 await setDoc(missing);assert.equal(await doc(),missing);
 await page.locator('.note-card[data-label="6"] .cm-content').click();
 assert.equal(await page.locator('.note-card[data-state="undefined"]').count(),0);
 assert.equal(await page.locator('#notesCount').textContent(),'2');
 assert.ok((await doc()).endsWith('[^2]:'));
 await page.keyboard.press('ControlOrMeta+z');assert.equal(await doc(),missing);
 assert.equal(await page.locator('.note-card[data-state="undefined"]').count(),1);
 await page.keyboard.press('ControlOrMeta+Shift+z');assert.ok((await doc()).endsWith('[^2]:'));
 await page.screenshot({path:artifactPath('footnote-completion.png')});
 assert.deepEqual(errors,[]);console.log('footnote-completion-browser: PASS');
} finally {await browser.close();}
