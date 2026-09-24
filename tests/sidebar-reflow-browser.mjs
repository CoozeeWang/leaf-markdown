import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 const source='# 窄窗口正文检查\n\n'+('这一段的开头与结尾都应该完整可见，侧栏展开后正文应当自动换行。'.repeat(8))+'[^a]\n\n## 下一节\n\n尾段。\n\n[^a]: 用于检查右侧注释与正文是否重叠。';
 await page.evaluate(async source=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source},selection:{anchor:0}});},source);
 const mode=async name=>{await page.click('#readingToggle');await page.locator(`[data-mode=${name}]`).click();};
 const check=async(side,reading)=>{
  const geometry=await page.evaluate(({side,reading})=>{
   const drawer=document.querySelector(`#${side}Drawer`).getBoundingClientRect();
   const host=document.querySelector(reading?'#readingPane':'#editor').getBoundingClientRect();
   const scroller=document.querySelector(reading?'#readingPane':'.cm-scroller');
   const text=document.querySelector(reading?'.reading-document p':'.cm-line');
   const result={left:host.left,right:host.right,width:host.width,drawerLeft:drawer.left,drawerRight:drawer.right,client:scroller.clientWidth,scroll:scroller.scrollWidth};
   if(!reading){const range=document.createRange();range.selectNodeContents(text);result.rects=[...range.getClientRects()].map(r=>({left:r.left,right:r.right}));}
   return result;
  },{side,reading});
  assert.ok(geometry.width>=359,JSON.stringify(geometry));
  assert.ok(side==='outline'?geometry.left>=geometry.drawerRight-1:geometry.right<=geometry.drawerLeft+1,JSON.stringify(geometry));
  assert.ok(geometry.scroll<=geometry.client+2,JSON.stringify(geometry));
  for(const r of geometry.rects||[]) assert.ok(r.left>=geometry.left-1&&r.right<=geometry.right+1,JSON.stringify(r));
 };
 for(const width of [1100,1000,900,720]) {
  await page.setViewportSize({width,height:600});
  for(const side of ['outline','notes']) {
   await page.click(`#${side}Button`);
   for(const name of ['edit','source','reading']) {await mode(name);await check(side,name==='reading');}
   await page.locator(`.${side}-resizer`).focus();await page.keyboard.press('End');await check(side,true);
   await page.locator(`.${side}-resizer`).dblclick();await check(side,true);
   await mode('edit');
   if(width===720) await page.screenshot({path:artifactPath(`sidebar-reflow-${side}.png`)});
   await page.click(`[data-close=${side}]`);
  }
 }
 await page.click('#outlineButton');await page.click('#notesButton');
 assert.equal(await page.locator('.outline-drawer.visible').count(),0);
 assert.equal(await page.evaluate(()=>v.state.doc.toString()),source);assert.deepEqual(errors,[]);
 console.log('PASS non-overlapping sidebars, full text viewport, reflow without horizontal overflow, edit/source/read at 1100/1000/900/720px, max resize and unchanged source');
}finally{await browser.close();}
