import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:800}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const source='# 测试\n\n第一段\n\n\n\n第二段\n\n```\na\n\n\nb\n```';
 await page.addInitScript(source=>{
  window.showOpenFilePicker=async()=>[{name:'test.md',getFile:async()=>new File([source],'test.md')}];
 },source);
 await page.goto('http://127.0.0.1:41732');
 await page.click('#welcomeOpenButton');
 // Reading the file is async: wait for its text before measuring anything.
 await page.locator('.cm-line').filter({hasText:'第二段'}).first().waitFor();
 const getSource=()=>page.evaluate(async()=>{
  const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
  return EditorView.findFromDOM(document.querySelector('.cm-content')).state.doc.toString();
 });
 // Measure the lines themselves: .cm-content is stretched to the viewport, and
 // CodeMirror's own contentHeight carries a provisional estimate for blocks it
 // has not re-measured yet, so neither is a witness to the marker's effect.
 const contentHeight=()=>page.evaluate(()=>[...document.querySelectorAll('.cm-line')].reduce((n,e)=>n+e.getBoundingClientRect().height,0));
 const marked=()=>page.locator('.cm-leaf-blank-line:has(.leaf-editing-marker)');
 const blankHeights=()=>page.locator('.cm-leaf-blank-line').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height));
 const row=await page.evaluate(()=>parseFloat(getComputedStyle(document.querySelector('.cm-content')).fontSize) * 1.25);
 const toggleMarker=async()=>{await page.click('#displayButton');await page.click('#blankMarkerToggle');await page.click('#displayButton');};
 // Put the caret at the end of 第一段 and press Enter, from a known document.
 const enterAtFirstParagraph=async()=>{
  await page.evaluate(async doc=>{
   const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
   const v=EditorView.findFromDOM(document.querySelector('.cm-content'));
   v.dispatch({changes:{from:0,to:v.state.doc.length,insert:doc},selection:{anchor:doc.indexOf('第一段')+3}});v.focus();
  },source);
  await page.keyboard.press('Enter');
  return getSource();
 };

// Each blank line draws one row of its own, so a run of three reads as three
// rows and a single one reads as the ordinary paragraph gap.
 assert.equal(await marked().count(),0);
 assert.equal(await blankHeights().then(hs=>hs.length),5,'one row per blank line outside code');
 assert.ok((await blankHeights()).every(h=>Math.abs(h-row)<1),'blank lines take exactly one row');
 assert.equal(await page.locator('.cm-leaf-blank-line.cm-leaf-code-block').count(),0,'a fenced block keeps its own blank lines');
 const gaps=await page.evaluate(()=>{
  const l=[...document.querySelectorAll('.cm-line')];
  const box=t=>l.find(e=>e.textContent===t).getBoundingClientRect();
  return {run:box('第二段').top-box('第一段').bottom,
   pads:['第一段','第二段'].map(t=>parseFloat(getComputedStyle(l.find(e=>e.textContent===t)).paddingTop))};
 });
 assert.ok(Math.abs(gaps.run-row*3)<2,'three blank lines read as three rows');
 assert.deepEqual(gaps.pads,[0,0],'nothing is added to the block below');

 // The marker switch is display only: same bytes, same Enter, same height.
 const withMarkerOff=await enterAtFirstParagraph();
 await page.keyboard.press('ControlOrMeta+z');
 assert.equal(await getSource(),source);
 const before=await contentHeight();
 await toggleMarker();
 assert.equal(await marked().count(),5,'one mark per blank line outside code');
 assert.ok(await marked().evaluateAll((es,h)=>es.every(e=>Math.abs(e.getBoundingClientRect().height-h)<1),row),'a marked blank line keeps its row, the dot adds nothing');
 assert.equal(await contentHeight(),before,'the marker cannot change the height of the document');
 assert.equal(await getSource(),source);
 const withMarkerOn=await enterAtFirstParagraph();
 assert.equal(withMarkerOn,withMarkerOff,'the marker must not change what Enter writes');
 assert.equal(await getSource(),withMarkerOff);
 await page.screenshot({path:artifactPath('leaf-blank-markers.png')});
 await page.keyboard.press('ControlOrMeta+z');
 assert.equal(await getSource(),source);

 // Both shortcuts still act on their own half: the mark display, then cleanup.
 await page.keyboard.press('ControlOrMeta+Shift+Backslash');
 assert.equal(await marked().count(),0);
 await page.keyboard.press('ControlOrMeta+Alt+Backslash');
 assert.equal(await getSource(),source.replace('第一段\n\n\n\n第二段','第一段\n\n第二段'));
 await page.keyboard.press('ControlOrMeta+z');
 assert.equal(await getSource(),source);
 await page.click('#tidyBlankLines');
 await page.keyboard.press('ControlOrMeta+z');
 assert.equal(await getSource(),source);
 await toggleMarker();
 // The same command both inserts missing separators and removes excess ones.
 const plain='甲\n乙\n\n\n丙';
 await page.evaluate(async doc=>{
  const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
  const v=EditorView.findFromDOM(document.querySelector('.cm-content'));
  v.dispatch({changes:{from:0,to:v.state.doc.length,insert:doc}});v.focus();
 },plain);

 assert.equal(await page.locator('#tidyBlankLines').getAttribute('aria-label'),'整理段落空行');
 await page.click('#tidyBlankLines');
 assert.equal(await getSource(),'甲\n\n乙\n\n丙');
 assert.match(await page.locator('#saveStatus').textContent(),/已整理段落空行/);
 await page.keyboard.press('ControlOrMeta+Alt+Backslash');
 assert.equal(await getSource(),'甲\n\n乙\n\n丙');
 assert.equal(await page.locator('#saveStatus').textContent(),'无需整理');
 await page.keyboard.press('ControlOrMeta+z');
 assert.equal(await getSource(),plain,'one undo reverses the whole normalization');
 assert.deepEqual(errors,[]);
 console.log('Blank markers: display only, marks stay heightless, Enter and the file unchanged, cleanup and one-step undo passed');
}finally{await browser.close()}
