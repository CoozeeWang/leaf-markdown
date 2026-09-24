import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try{
 const page=await browser.newPage({viewport:{width:1100,height:820}});
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 const source='# 林间工作笔记\n\n这里有**重点内容**、*轻微强调*、==需要回看的句子==，以及 `note.title` 和[参考资料](https://example.com)。\n\n## 一段安静的写作时间\n\n中文与 English words、数字 2026 放在一起，正文仍是阅读的主体。\n\n### 三级标题\n\n#### 四级标题\n\n##### 五级标题\n\n###### 六级标题\n\n```js\nconsole.log("Leaf");\n```';
 await page.locator('.cm-content').fill(source);await page.keyboard.press('ArrowLeft');await page.locator('.brand').click();await page.locator('.cm-scroller').evaluate(el=>el.scrollTop=0);
 const edit=await page.locator('.cm-leaf-heading').evaluateAll(els=>els.map(el=>({size:getComputedStyle(el).fontSize,color:getComputedStyle(el).color})));
 console.log('title geometry',await page.locator('.leaf-default-title').evaluate(el=>({parent:el.parentElement.className,next:el.nextElementSibling?.className,gap:getComputedStyle(el.nextElementSibling).paddingTop})));
 await page.screenshot({path:artifactPath('typography-applied-edit.png')});
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();await page.locator('#readingPane').evaluate(el=>el.scrollTop=0);
 const read=await page.locator('.reading-document :is(h1,h2,h3,h4,h5,h6)[data-source-line]').evaluateAll(els=>els.map(el=>({size:getComputedStyle(el).fontSize,color:getComputedStyle(el).color})));
 assert.deepEqual(read,edit);
 await page.screenshot({path:artifactPath('typography-applied-reading.png')});
 await page.setViewportSize({width:720,height:480});
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.waitForTimeout(200);
 await page.screenshot({path:artifactPath('typography-applied-dark.png')});
 assert.equal(await page.locator('.reading-document h3').evaluate(el=>getComputedStyle(el).color),'rgb(189, 195, 148)');
 assert.equal(await page.locator('.reading-document h4').evaluate(el=>getComputedStyle(el).color),'rgb(201, 189, 140)');
 await page.click('#readingToggle');await page.getByRole('menuitemradio',{name:'源码',exact:true}).click();
 assert.equal(await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');return EditorView.findFromDOM(document.querySelector('.cm-content')).state.doc.toString();}),source);
 console.log('PASS shared heading sizes/colors, dark earth colors, unchanged source');
}finally{await browser.close();}
