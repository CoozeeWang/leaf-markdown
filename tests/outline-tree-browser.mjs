import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 const source='# 第一章\n\n正文不会折叠\n\n## 小节\n\n### 细节\n\n###### 跳级标题\n\n## 另一小节\n\n# 第二章\n\n## 小节\n\n尾段';
 await page.evaluate(async source=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source},selection:{anchor:0}});},source);
 await page.click('#outlineButton');
 const names=()=>page.locator('.outline-item:visible').allTextContents();
 const toggle=(name,expanded)=>page.getByRole('button',{name:`${expanded?'收起':'展开'}大纲子项：${name}`,exact:true}).first();
 assert.equal((await names()).length,7);
 assert.equal(await page.locator('.outline-disclosure').count(),4);
 assert.equal(await page.locator('.outline-children').first().evaluate(e=>getComputedStyle(e).borderLeftWidth),'1px');
 await toggle('小节',true).click();assert.deepEqual(await names(),['第一章','小节','另一小节','第二章','小节']);
 await toggle('第一章',true).focus();await page.keyboard.press('Space');assert.deepEqual(await names(),['第一章','第二章','小节']);
 await page.keyboard.press('Enter');assert.deepEqual(await names(),['第一章','小节','另一小节','第二章','小节']);
 assert.ok((await page.locator('.cm-content').innerText()).includes('正文不会折叠'));
 await page.evaluate(()=>v.dispatch({changes:{from:v.state.doc.length,insert:'补充'}}));
 assert.deepEqual(await names(),['第一章','小节','另一小节','第二章','小节']);
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();assert.deepEqual(await names(),['第一章','小节','另一小节','第二章','小节']);
 await toggle('小节',false).click();assert.equal((await names()).length,7);
 assert.equal(await page.evaluate(()=>v.state.doc.toString()),source+'补充');
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();await page.click('[data-close=outline]');await page.click('#outlineButton');assert.equal((await names()).length,7);
 await page.getByRole('button',{name:'另一小节',exact:true}).click();assert.equal(await page.evaluate(()=>v.state.doc.lineAt(v.state.selection.main.head).text),'## 另一小节');
 for(const theme of ['light','dark']) {
  await page.click('#appearanceButton');await page.click('#settingsTab-appearance');await page.selectOption('#themeSelect',theme);await page.click('#appearanceButton');
  await page.screenshot({path:artifactPath(`outline-tree-${theme}.png`)});
 }
 await page.setViewportSize({width:720,height:480});await toggle('第一章',true).click();await toggle('第一章',false).click();
 assert.equal(await page.evaluate(()=>v.state.doc.toString()),source+'补充');assert.deepEqual(errors,[]);
 await page.evaluate(()=>{window.showOpenFilePicker=async()=>[{name:'empty.md',getFile:async()=>new File(['无标题正文'],'empty.md')}];});
 await page.click('#openButton');await page.waitForFunction(()=>v.state.doc.toString()==='无标题正文');assert.equal(await page.locator('.outline-item').count(),0);assert.ok((await page.locator('#outlineList').innerText()).includes('没有标题'));
 console.log('PASS hierarchy, skipped levels, independent nested folds, keyboard activation, navigation, mode/body-edit stability, light/dark/narrow and unchanged source');
}finally{await browser.close();}
