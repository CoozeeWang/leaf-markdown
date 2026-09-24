import assert from 'node:assert/strict';
import {chromium,launchOptions} from './browser-runtime.mjs';
const browser=await chromium.launch(launchOptions);
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.locator('.cm-content').fill('---\nauthor: Alice # keep comment\nother: Bob\n---\n\n# Body');
 const source=()=>page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');return EditorView.findFromDOM(document.querySelector('.cm-content')).state.doc.toString();});
 await page.getByLabel('属性名：author',{exact:true}).fill('作者');await page.getByLabel('属性名：author',{exact:true}).press('Enter');
 assert.match(await source(),/"作者": Alice # keep comment/);
 await page.getByLabel('属性名：作者',{exact:true}).fill('other');await page.getByLabel('属性名：作者',{exact:true}).press('Enter');
 assert.match(await page.locator('.leaf-property-error').innerText(),/已存在/);assert.match(await source(),/"作者": Alice/);
 await page.getByLabel('属性名：作者',{exact:true}).fill('');await page.getByLabel('属性名：作者',{exact:true}).press('Enter');assert.match(await page.locator('.leaf-property-error').innerText(),/属性值仍有内容/);
 await page.locator('.leaf-default-title h1').dblclick();await page.getByLabel('新文件名').waitFor();assert.equal(await page.locator('[role=dialog]:visible').count(),0);assert.equal(await page.getByLabel('新文件名').evaluate(e=>getComputedStyle(e).outlineStyle),'none');await page.getByLabel('新文件名').press('Escape');
 await page.keyboard.press('ControlOrMeta+r');await page.locator('.leaf-file-name-title').dblclick();await page.getByLabel('新文件名').waitFor();assert.equal(await page.locator('[role=dialog]:visible').count(),0);assert.equal(await page.getByLabel('新文件名').evaluate(e=>getComputedStyle(e).outlineStyle),'none');await page.getByLabel('新文件名').press('Escape');assert.deepEqual(errors,[]);
 console.log('PASS property key rename preserves value/comment, rejects duplicate/empty, both document modes rename in place');
}finally{await browser.close();}
