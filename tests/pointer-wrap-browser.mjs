import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:850,height:950}});
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
 const doc=process.env.LEAF_POINTER_DOC?readFileSync(process.env.LEAF_POINTER_DOC,'utf8'):'---\n\n---\n\n# 标题\n\n> 引用框第一行\n> 引用框第二行\n\n'+('这是正文 **加粗文字** 与 *斜体文字* 以及 `code`，').repeat(9)+'目标文字\n\n下一段'+ '很长的普通内容'.repeat(30)+'最后文字\n\n末段';
 await page.evaluate(doc=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:doc},selection:{anchor:doc.length}});},doc);
 const failures=[];
 await page.waitForTimeout(200);
 const geometry=await page.evaluate(()=>[...v.contentDOM.children].filter(el=>el.classList.contains('cm-line')).slice(0,16).map(el=>Math.abs(el.getBoundingClientRect().top-v.documentTop-v.lineBlockAt(v.posAtDOM(el)).top)));
 assert.ok(geometry.every(n=>n<2),'DOM positions must match the editor height map');
 for(let i=0;i<12;i++) {
  await page.evaluate(()=>v.dispatch({selection:{anchor:0}}));await page.waitForTimeout(180);
  const target=await page.evaluate(i=>{
   const source=v.state.doc.toString();
   const starts=['01b｜','createdAt','这份报告','企业可能','因此，','第一次阅读'];
   const pos=source.includes('01b｜')?source.indexOf(starts[i%starts.length])+Math.floor(i/starts.length)*8:source.indexOf('这是正文')+i*20;
   v.dispatch({effects:[]});
   const dom=v.domAtPos(pos),range=document.createRange();
   if(dom.node.nodeType!==3||dom.offset>=dom.node.length)return null;
   range.setStart(dom.node,dom.offset);range.setEnd(dom.node,dom.offset+1);
   const r=range.getBoundingClientRect(),x=r.left+1,y=(r.top+r.bottom)/2;
   const native=document.caretRangeFromPoint(x,y);
   return {pos,x,y,mapped:v.posAtCoords({x,y}),native:native?v.posAtDOM(native.startContainer,native.startOffset):null,block:v.lineBlockAt(pos),documentTop:v.documentTop};
  },i);
  if(!target||target.y>900)continue;
  await page.mouse.click(target.x,target.y);await page.waitForTimeout(100);
  const actual=await page.evaluate(()=>({head:v.state.selection.main.head,coords:v.coordsAtPos(v.state.selection.main.head)}));
  if(actual.head!==target.pos)failures.push({target,actual});
 }
 assert.deepEqual(failures,[]);console.log('PASS real mouse click positions and block height map');
}finally{await browser.close()}
