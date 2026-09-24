import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1280,height:1600}});
 await page.goto('http://127.0.0.1:41732'); await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{
  const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
  window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));
  const text='# 间距测试\n\n正文甲\n\n> 引用正文\n> 第二行\n\n正文乙\n\n> [!note]\n> 提示内容\n\n正文丙\n\n| 名称 | 值 |\n| --- | --- |\n| 示例 | 内容 |\n\n正文丁\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n正文戊';
  v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:0}});
 });
 await page.waitForTimeout(300);
 const metrics=await page.evaluate(()=>{
  const s=e=>getComputedStyle(e), lines=[...document.querySelectorAll('.cm-line')];
  return {gap:parseFloat(s(lines.find(e=>e.textContent==='正文乙')).paddingTop),
   row:parseFloat(s(document.querySelector('.cm-content')).fontSize) * 1.25,
   blankHeights:[...document.querySelectorAll('.cm-leaf-blank-line')].map(e=>Math.round(e.getBoundingClientRect().height*100)/100),
   frames:[...document.querySelectorAll('.leaf-widget-frame')].map(e=>[parseFloat(s(e).paddingTop),parseFloat(s(e).paddingBottom)]),
   quote:parseFloat(getComputedStyle(document.querySelector('.cm-leaf-quote'),'::before').top),
   geometry:lines.map(e=>{const block=v.lineBlockAt(v.posAtDOM(e));const textBlock=Array.isArray(block.type)?block.type.find(part=>part.type===0):block;return Math.abs(e.getBoundingClientRect().top-v.documentTop-textBlock.top);})};
 });
 assert.equal(metrics.gap,0,'段间距不再由后面那块承担');
 assert.ok(metrics.blankHeights.length>0);
 assert.ok(metrics.blankHeights.every(h=>Math.abs(h-metrics.row)<1),'每条空行各占一格');
 for(const [top,bottom] of metrics.frames){assert.equal(top,0);assert.equal(bottom,0);}
 assert.equal(metrics.quote,0);
 assert.ok(metrics.geometry.every(n=>n<2));
 await page.screenshot({path:artifactPath('leaf-block-spacing.png')});
 assert.equal(await page.locator('.leaf-block-source').count(),2);
 assert.ok(await page.locator('.leaf-block-source').first().evaluate(e=>getComputedStyle(e).position==='absolute'));
 for(const theme of ['light','dark']) {
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  const bg=await page.locator('.cm-activeLine').first().evaluate(e=>getComputedStyle(e).backgroundColor);
  assert.notEqual(bg,'rgba(0, 0, 0, 0)');
 }
 await page.evaluate(()=>document.documentElement.dataset.theme='light');
 await page.locator('.leaf-callout-widget .leaf-block-source').click();
 await page.getByRole('button',{name:'返回实时渲染',exact:true}).click();
 await page.locator('.leaf-callout-widget .leaf-block-source').waitFor();
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
 const margins=await page.locator('.reading-document > :is(p,blockquote,pre,table,.leaf-callout)').evaluateAll(es=>es.map(e=>getComputedStyle(e).marginTop));
 assert.ok(margins.length>=8);assert.equal(new Set(margins).size,1);
 console.log('PASS shared block spacing in editing/reading and CM height map');
} finally {await browser.close();}
