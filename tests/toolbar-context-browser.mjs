import {chromium, launchOptions} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 const source='# 一级\n\n正文\n\n## 二级\n\n二级下划线\n---\n\n```md\n# 假标题\n```\n\n###### 六级\n';
 await page.evaluate(async source=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source},selection:{anchor:0}});},source);
 const check=async(needle,label,level)=>{
  await page.evaluate(needle=>v.dispatch({selection:{anchor:v.state.doc.toString().indexOf(needle)}}),needle);
  assert.equal(await page.locator('#headingButton > span').textContent(),label);
  await page.click('#headingButton');
  assert.equal(await page.locator('.heading-grid [aria-pressed="true"]').getAttribute('data-format'),'heading'+level);
  await page.click('#headingButton');
 };
 await check('一级','H1',1);await check('正文','¶',0);await check('二级\n','H2',2);
 await check('二级下划线','H2',2);await check('---','H2',2);await check('假标题','¶',0);await check('六级','H6',6);
 await page.evaluate(()=>v.dispatch({selection:{anchor:0,head:v.state.doc.toString().indexOf('正文')+2}}));
 assert.equal(await page.locator('#headingButton').getAttribute('aria-label'),'标题级别：混合级别');
 assert.equal(await page.locator('.heading-grid [aria-pressed="true"]').count(),0);
 await page.evaluate(()=>v.dispatch({selection:{anchor:0,head:v.state.doc.line(2).from}}));
 assert.equal(await page.locator('#headingButton > span').textContent(),'H1','selection ending at next line start excludes it');
 await page.click('#headingButton');await page.locator('[data-format="heading3"]').click();
 assert.equal(await page.locator('#headingButton > span').textContent(),'H3');
 await page.click('#undoButton');assert.equal(await page.evaluate(()=>v.state.doc.toString()),source);
 const visible=()=>page.locator('.format-toolbar > button:visible').evaluateAll(es=>es.map(e=>e.id||e.dataset.format));
 const edit=await visible();
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
 // Reading keeps copy plus the controls that describe what is on screen: the
 // 显示 switchboard carries the switches the settings dialog used to hold, so
 // it has to stay reachable here. 标题多级编号 is one of those switches now, so
 // it no longer has a toolbar button of its own.
 assert.deepEqual(await visible(),['richCopy','displayButton']);
 assert.equal(await page.locator('.format-toolbar .toolbar-divider:visible').count(),0);
 await page.setViewportSize({width:720,height:480});
 assert.ok(await page.locator('#richCopy').evaluate(e=>e.getBoundingClientRect().left>=0));
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();assert.deepEqual(await visible(),edit);
 assert.equal(await page.evaluate(()=>v.state.doc.toString()),source);assert.deepEqual(errors,[]);
 console.log('PASS heading state, Setext/code/mixed selections, heading change/undo, reading toolbar and edit restoration');
}finally{await browser.close();}
