import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser = await chromium.launch(launchOptions);
try {
 const page = await browser.newPage({viewport:{width:1100,height:850}}), errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
 for(const prefix of ['- 前面的列表', '- 父项\n  - 子项', '> 前面的引用', '```\ncode\n```', Array.from({length:120},(_,i)=>'- 列表 '+i).join('\n')]) {
  const source=prefix+'\n\n正文甲乙\n\n### 问题02\n\n![截图](assets/'+'abc'.repeat(55)+'.png)\n\n最后';
  for(const reverse of [false,true]) {
   await page.evaluate(({source,reverse})=>{
    const from=source.indexOf('正文甲乙')+2,to=source.indexOf('\n\n最后');
    v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source},selection:{anchor:reverse?to:from,head:reverse?from:to},scrollIntoView:true});v.focus();
   },{source,reverse});
   await page.waitForTimeout(100);
   const geometry=await page.evaluate(()=>{
    const rects=[...document.querySelectorAll('.leaf-selectionLayer .cm-selectionBackground')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};});
    const start=v.coordsAtPos(v.state.selection.main.from),end=v.coordsAtPos(v.state.selection.main.to,-1);
    return {rects,start,end,left:v.contentDOM.getBoundingClientRect().left+6,source:v.state.doc.toString()};
   });
   assert.equal(geometry.source,source);
   assert.ok(geometry.rects.length>=3);
   assert.ok(Math.abs(geometry.rects[0].left-geometry.start.left)<1,'partial first row remains exact');
   for(const rect of geometry.rects.slice(1)) assert.ok(Math.abs(rect.left-geometry.left)<1,`continuation inherits indentation: ${JSON.stringify({prefix,geometry})}`);
   assert.ok(Math.abs(geometry.rects.at(-1).right-geometry.end.right)<1,'partial last row remains exact');
  }
 }
 await page.screenshot({path:artifactPath('selection-edges-fixed.png')});
 assert.deepEqual(errors,[]);
 console.log('PASS selection edges across lists, quotes, code, headings and wrapped image source; both directions and partial endpoints');
} finally {await browser.close();}
