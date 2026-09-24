import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
  const page=await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:2}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:41732');

  await page.click('#welcomeNewButton');
  await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
  const setDoc=text=>page.evaluate(t=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:t},selection:{anchor:0}});},text);
  const doc=()=>page.evaluate(()=>v.state.doc.toString());
  const rows=()=>page.evaluate(()=>[...document.querySelectorAll('.note-card')].map(card=>[
    card.dataset.number,card.querySelector('.note-body').value,card.dataset.state]));

  const before='甲[^1] 乙[^2] 丙[^3]\n\n[^1]: test\n[^2]: 注释\n[^3]: This is a test.\n';
  await setDoc(before);
  await page.click('#notesButton');
  await page.waitForTimeout(150);
  assert.deepEqual(await rows(),[['1','test','complete'],['2','注释','complete'],['3','This is a test.','complete']],
    '三条注释先各就各位');

  // 1. 用键盘把第二个标记的名字打掉。定义必须跟过来：不跟的话这条注释就裂成两半，
  //    后面那条会从 3 号升成 2 号。
  const at=before.indexOf('[^2]')+2;
  await page.evaluate(f=>{v.dispatch({selection:{anchor:f,head:f+1}});v.focus();},at);
  await page.keyboard.type('READ');
  await page.waitForTimeout(200);
  assert.equal(await doc(),'甲[^1] 乙[^READ] 丙[^3]\n\n[^1]: test\n[^READ]: 注释\n[^3]: This is a test.\n',
    '正文改了名，文末的定义要一起改');
  assert.deepEqual(await rows(),[['1','test','complete'],['2','注释','complete'],['3','This is a test.','complete']],
    '编号不该动：改的只是名字');

  // 2. 整件事是一笔事务，一次撤销连定义一起回去。
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(200);
  assert.equal(await doc(),before,'一次撤销要两边都回到原样');

  // 3. 反过来改定义的名字，正文里的每个标记都跟着。
  const spread='甲[^2] 乙[^2]\n\n[^2]: 注释\n';
  await setDoc(spread);
  await page.waitForTimeout(150);
  const defAt=spread.lastIndexOf('[^2]')+2;
  await page.evaluate(f=>{v.dispatch({selection:{anchor:f,head:f+1}});v.focus();},defAt);
  await page.keyboard.type('READ');
  await page.waitForTimeout(200);
  assert.equal(await doc(),'甲[^READ] 乙[^READ]\n\n[^READ]: 注释\n','改定义的名字，两个标记都要跟');

  assert.deepEqual(errors,[],'不该有页面报错');
  console.log('footnote-rename-browser: PASS');
} finally {
  await browser.close();
}
