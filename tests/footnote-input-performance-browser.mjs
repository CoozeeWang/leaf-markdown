import {chromium,launchOptions} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({locale:'zh-CN'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 const source='# 合成访谈\n\n正文引用[^1]。\n\n'+'这是一段公开合成的访谈样本，用于检查长文脚注输入。\n\n'.repeat(7000)+'\n[^1]: 原注释';
 await page.evaluate(async source=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('#editor .cm-content'));v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source},selection:{anchor:12}});v.focus();},source);
 await page.click('#notesButton');await page.click('[data-format=footnote]');await page.locator('.footnote-box textarea').waitFor();
 const result=await page.evaluate(()=>{
  const input=document.querySelector('.footnote-box textarea');const times=[];
  const events=[];input.addEventListener('input',()=>events.push(input.value));
  for(const c of '连续输入不丢文字'){input.value+=c;const t=performance.now();input.dispatchEvent(new Event('input',{bubbles:true}));times.push(performance.now()-t);}
  input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
  input.value+='中文';input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'中文'}));
  input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));
  return {times,value:input.value,events,source:v.state.doc.toString(),row:document.querySelector('.note-card[data-label="1"] .note-body').value};
 });
 assert.equal(result.value,'连续输入不丢文字中文');assert.equal(result.row,result.value);
 assert.ok(result.source.includes('[^1]: 连续输入不丢文字中文'));
 assert.ok(result.source.includes('[^2]: 原注释'));
 assert.equal(result.source.split('这是一段公开合成的访谈样本').length-1,7000);
 await page.keyboard.press('Escape');assert.equal(await page.locator('.footnote-box').count(),0);
 assert.deepEqual(errors,[]);
 console.log(`PASS long-document footnote input, immediate source/panel sync and composition; milliseconds: ${result.times.map(t=>t.toFixed(1)).join(', ')}`);
}finally{await browser.close()}
