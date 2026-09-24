import {chromium,launchOptions} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'# 正文标题\n\n正文'}});});
 const text=await page.evaluate(()=>v.state.doc.toString());
 assert.equal(await page.locator('.leaf-default-title').count(),1);assert.equal(await page.getByRole('button',{name:'写入正文',exact:true}).count(),0);
 await page.click('#displayButton');await page.uncheck('#fileNameTitleToggle');await page.click('#displayButton');
 assert.equal(await page.locator('.leaf-default-title').count(),0);assert.equal(await page.evaluate(()=>v.state.doc.toString()),text);
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();assert.deepEqual(await page.locator('.reading-document h1').allTextContents(),['正文标题']);
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();await page.click('#displayButton');await page.check('#fileNameTitleToggle');await page.click('#displayButton');
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();assert.equal(await page.locator('.reading-document h1').count(),2);
 assert.equal(await page.locator('.leaf-file-name-title .leaf-reading-fold').count(),0);
 assert.equal(await page.locator('.reading-document h1:not(.leaf-file-name-title) .leaf-reading-fold').count(),1);
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();assert.equal(await page.evaluate(()=>v.state.doc.toString()),text);
 await page.click('#displayButton');await page.uncheck('#fileNameTitleToggle');await page.reload();await page.click('#welcomeNewButton');assert.equal(await page.locator('.leaf-default-title').count(),0);
 assert.deepEqual(errors,[]);console.log('PASS display-only file title, H1 independence, no insert button, reading consistency, persisted setting and unchanged Markdown');
}finally{await browser.close();}
