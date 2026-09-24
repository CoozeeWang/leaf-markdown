import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 const source='# 一级\n\n普通正文\n\n- 父项\n  - 子项\n    - 孙项\n  - 另一个子项\n- 同级项\n\n> [!note]\n> 提示正文\n\n## 子标题\n\n| A | B |\n| --- | --- |\n| x | y |\n\n# 下一章\n\n结尾';
 await page.evaluate(async source=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source},selection:{anchor:0}});},source);
 await page.waitForTimeout(200);
 const sizes=await page.evaluate(()=>[getComputedStyle(document.querySelector('.cm-content')).fontSize,getComputedStyle(document.querySelector('.leaf-callout-widget')).fontSize]);assert.equal(sizes[0],sizes[1]);
 assert.deepEqual(await page.locator('.leaf-list-marker').allTextContents(),['●','○','■','○','●']);
 assert.notEqual(await page.locator('.cm-leaf-nested-list').nth(1).evaluate(e=>getComputedStyle(e).backgroundImage),'none');
 await page.getByRole('button',{name:'收起列表',exact:true}).first().click();
 assert.ok(!(await page.locator('.cm-content').innerText()).includes('孙项'));
 await page.getByRole('button',{name:'展开列表',exact:true}).first().click();
 assert.ok((await page.locator('.cm-content').innerText()).includes('孙项'));
 await page.getByRole('button',{name:'收起标题',exact:true}).first().click();
 assert.ok(!(await page.locator('.cm-content').innerText()).includes('普通正文'));
 assert.ok((await page.locator('.cm-content').innerText()).includes('下一章'));
 await page.getByRole('button',{name:'展开标题',exact:true}).first().click();
 assert.equal(await page.evaluate(()=>v.state.doc.toString()),source);
 await page.screenshot({path:artifactPath('leaf-outline-folding.png')});
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
 await page.getByRole('button',{name:'收起标题',exact:true}).first().click();
 assert.ok(!(await page.locator('.reading-document').innerText()).includes('普通正文'));
 await page.getByRole('button',{name:'展开标题',exact:true}).first().click();
 assert.ok((await page.locator('.reading-document').innerText()).includes('普通正文'));
 assert.deepEqual(errors,[]);console.log('PASS callout font, nested markers, list/heading folding, reading folding and source preservation');
}finally{await browser.close();}
