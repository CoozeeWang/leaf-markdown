import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try{
 const page=await browser.newPage({viewport:{width:1100,height:820}});
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 const source='## 列表与引用\n\n- 第一项：记录主要判断。\n- 第二项：这是一条较长的说明，包含中文、English words 和数字 2026，用于检查换行之后是否仍然对齐正文，而不是回到项目符号下方。\n  - 二级项目：补充理由。\n    - 三级项目：补充细节。\n\n1. 打开文档。\n2. 检查排版。\n3. 保存修改。\n\n> 引用应该与正文有所区分，同时保持连续阅读的舒适度。\n>\n> 这是引用的第二段，用于检查段落之间的距离。\n\n正文继续。';
 await page.locator('.cm-content').fill(source);await page.keyboard.press('ArrowLeft');await page.locator('.brand').click();await page.locator('.cm-scroller').evaluate(el=>el.scrollTop=0);
 assert.equal(await page.locator('.cm-leaf-quote-first').count(),1);assert.equal(await page.locator('.cm-leaf-quote-last').count(),1);
 await page.screenshot({path:artifactPath('lists-quotes-new-edit.png')});
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();await page.locator('#readingPane').evaluate(el=>el.scrollTop=0);
 const toggle=page.locator('.reading-document li > .leaf-reading-fold').first();
 assert.equal(await toggle.evaluate(el=>{const r=el.getBoundingClientRect(),li=el.parentElement.getBoundingClientRect();return r.right<=li.left-24;}),true,'fold button has its own space outside marker');
 await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'false');
 await page.getByRole('button',{name:'展开列表',exact:true}).first().click();
 assert.equal(await page.locator('.reading-document ol > li').first().evaluate(el=>getComputedStyle(el,'::marker').fontSize),'14px');
 await page.screenshot({path:artifactPath('lists-quotes-new-reading.png')});
 await page.setViewportSize({width:720,height:480});await page.locator('.reading-document blockquote').scrollIntoViewIfNeeded();
 await page.screenshot({path:artifactPath('lists-quotes-new-narrow.png')});
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.waitForTimeout(200);
 await page.screenshot({path:artifactPath('lists-quotes-new-dark.png')});
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
 assert.equal(await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');return EditorView.findFromDOM(document.querySelector('.cm-content')).state.doc.toString();}),source);
 console.log('PASS list fold separation and toggling, marker size, quote boundaries, narrow/dark and unchanged source');
}finally{await browser.close();}
