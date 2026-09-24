import {chromium,launchOptions} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
 const setup=()=>page.evaluate(()=>{const text='---\nauthor: Leaf\n---\n\n# 正文';v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:text.length}});});
 for(const order of [['属性名：author','author'],['author','属性名：author']]){
 await setup();for(const label of order)await page.getByLabel(label,{exact:true}).fill('');
 await page.waitForFunction(()=>v.state.doc.toString()==='# 正文');assert.equal(await page.locator('.leaf-yaml').count(),0);
 await page.locator('.cm-content').focus();await page.keyboard.press('ControlOrMeta+z');assert.ok((await page.evaluate(()=>v.state.doc.toString())).startsWith('---'));
 }
 await page.evaluate(()=>{const text='---\na: x\nb: y\n---\n\n正文';v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:text.length}});});
 await page.getByLabel('属性名：a',{exact:true}).fill('');await page.getByLabel('a',{exact:true}).fill('');
 await page.getByLabel('b',{exact:true}).waitFor();assert.equal(await page.getByLabel('b',{exact:true}).inputValue(),'y');
 assert.ok((await page.evaluate(()=>v.state.doc.toString())).endsWith('\n\n正文'));
 console.log('PASS clearing name/value in either order removes last block, undo restores, other fields survive');
}finally{await browser.close();}
