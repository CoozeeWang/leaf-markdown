import {chromium, launchOptions, artifactPath} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:800}}), errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
 const setup=(doc,anchor=doc.length)=>page.evaluate(({doc,anchor})=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:doc},selection:{anchor}});v.focus();},{doc,anchor});
 const value=()=>page.evaluate(()=>v.state.doc.toString());
 const mode=async name=>{await page.click('#readingToggle');await page.locator(`[data-mode=${name}]`).click();};
 const blank=()=>page.locator('.cm-leaf-blank-line');
 const row=await page.evaluate(()=>parseFloat(getComputedStyle(document.querySelector('.cm-content')).lineHeight));
 await setup('第一段');await page.keyboard.press('Enter');
 assert.equal(await value(),'第一段\n');
 assert.equal(await page.evaluate(()=>v.state.doc.lineAt(v.state.selection.main.head).number),2);
 await page.keyboard.press('Enter');
 assert.equal(await value(),'第一段\n\n');
 assert.equal(await page.evaluate(()=>v.state.doc.lineAt(v.state.selection.main.head).number),3);
 assert.equal(await blank().count(),1);
 assert.ok(Math.abs((await blank().first().boundingBox()).height-row)<1,'空行自己占一格，光标才有地方落');
 await page.keyboard.insertText('第二段');
 assert.equal(await value(),'第一段\n\n第二段');
 // A blank line is a real row now, so the arrows walk it like any other line.
 await page.keyboard.press('Home');await page.keyboard.press('ArrowUp');
 assert.equal(await page.evaluate(()=>v.state.doc.lineAt(v.state.selection.main.head).number),2);
 await page.keyboard.press('ArrowDown');
 assert.equal(await page.evaluate(()=>v.state.doc.lineAt(v.state.selection.main.head).number),3);
 await page.keyboard.press('ArrowLeft');assert.equal(await page.evaluate(()=>v.state.selection.main.head),4);
 await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>v.state.selection.main.head),5);
 // One Backspace takes one layer: the blank line goes, the line break stays.
 await page.keyboard.press('Backspace');assert.equal(await value(),'第一段\n第二段');
 await page.keyboard.press('ControlOrMeta+z');assert.equal(await value(),'第一段\n\n第二段');
 // Source mode and the reading view keep the file exactly as written.
 await mode('source');assert.equal(await blank().count(),0);
 const raw=page.locator('.cm-line').filter({hasText:/^$/});assert.ok((await raw.first().boundingBox()).height>10);
 await page.evaluate(()=>{v.dispatch({selection:{anchor:v.state.doc.length}});v.focus();});await page.keyboard.press('Enter');
 assert.equal(await value(),'第一段\n\n第二段\n');
 await mode('edit');assert.equal(await value(),'第一段\n\n第二段\n');
 for(const doc of ['```text\na\n\nb\n```','---\ntitle: test\n\nsummary: value\n---']) {
  await setup(doc,0);await mode('source');await mode('edit');
  assert.equal(await blank().count(),0,'code/YAML blanks are not paragraph separators');assert.equal(await value(),doc);
 }
 // Inline spans, images and code all insert only one newline.
 for(const [doc,anchor,want] of [
  ['文字 `代码`\n[链接](url)',8,1],['文字 `代码`\n![](x.png)',8,1],['文字 `代码`\n第二段文字',8,1],
  ['`代码`\n[链接](url)',4,1],['![图](x.png)\n[链接](url)',11,1],
  ['文字 `代码` 后面',6,1],['```\n甲\n\n乙\n```',5,1],
 ]) {
  await setup(doc,anchor);await page.keyboard.press('Enter');
  const after=await value();
  assert.equal((after.match(/\n/g)??[]).length-(doc.match(/\n/g)??[]).length,want,`Enter at ${JSON.stringify(doc)}`);
 }
// A run of blank lines in the file is that many rows: one blank reads as the
// paragraph gap, three read as three. Nothing is added to the block below.
 await setup('甲\n\n\n\n乙',0);
 assert.equal(await blank().count(),3);
 assert.ok(await blank().evaluateAll((es,h)=>es.every(e=>Math.abs(e.getBoundingClientRect().height-h)<1),row));
 assert.equal(await page.evaluate(()=>parseFloat(getComputedStyle([...document.querySelectorAll('.cm-line')].find(e=>e.textContent==='乙')).paddingTop)),0,'间距不再画在后面那块上');
 const stacked=await page.evaluate(()=>{const l=[...document.querySelectorAll('.cm-line')];return l.find(e=>e.textContent==='乙').getBoundingClientRect().top-l.find(e=>e.textContent==='甲').getBoundingClientRect().bottom;});
 assert.ok(Math.abs(stacked-row*3)<2,'三个空行就是三格');
 await page.screenshot({path:artifactPath('leaf-blank-run-stacked.png')});
 // Enter adds exactly one newline even before an existing separator.
 await setup('文字\n\n![](x.png)',2);await page.keyboard.press('Enter');
 assert.equal(await value(),'文字\n\n\n![](x.png)');
 await page.keyboard.insertText('新段');
 assert.equal(await value(),'文字\n新段\n\n![](x.png)');
 await page.keyboard.press('Enter');
 assert.equal(await value(),'文字\n新段\n\n\n![](x.png)');
 await page.keyboard.press('Backspace');
 assert.equal(await value(),'文字\n新段\n\n![](x.png)');
 await setup('文字\n\n新段\n\n\n\n![](x.png)');
 // The marker switch is display only: same bytes, same Enter, same height.
 // Measure the lines themselves -- CodeMirror's own contentHeight carries a
 // provisional estimate for blocks it has not re-measured yet.
 const rows=()=>page.evaluate(()=>[...document.querySelectorAll('.cm-line')].reduce((n,e)=>n+e.getBoundingClientRect().height,0));
 const heightWithoutMarks=await rows();
 await page.click('#displayButton');await page.check('#blankMarkerToggle');await page.click('#displayButton');
 assert.equal(await page.locator('.cm-leaf-blank-line:has(.leaf-editing-marker)').count(),4);
 assert.equal(await blank().count(),4);
 assert.ok(await page.locator('.cm-leaf-blank-line:has(.leaf-editing-marker)').evaluateAll((es,h)=>es.every(e=>Math.abs(e.getBoundingClientRect().height-h)<1),row),'标记不改变空行的高度');
 assert.ok(Math.abs(await rows()-heightWithoutMarks)<.5,'打开标记不改变文档高度');
 await page.evaluate(()=>{v.dispatch({selection:{anchor:v.state.doc.length}});v.focus();});
 await page.keyboard.press('Enter');
 assert.equal(await value(),'文字\n\n新段\n\n\n\n![](x.png)\n');
 assert.equal(await page.locator('.cm-leaf-blank-line:has(.leaf-editing-marker)').count(),4,'the trailing caret line is not a blank separator');
 const heightWithExtra=await rows();
 assert.ok(heightWithExtra>heightWithoutMarks+row-1,'the extra blank line takes its own row');
 await page.click('#displayButton');await page.uncheck('#blankMarkerToggle');await page.click('#displayButton');
 assert.equal(await page.locator('.cm-leaf-blank-line:has(.leaf-editing-marker)').count(),0);
 assert.ok(Math.abs(await rows()-heightWithExtra)<.5,'关掉标记只少一个点');
 assert.equal(await value(),'文字\n\n新段\n\n\n\n![](x.png)\n');
 // Reading view renders the same document without empty rows either.
 await mode('reading');
 assert.equal(await page.locator('.reading-document > p').evaluateAll(es=>es.filter(e=>!e.textContent.trim()&&!e.children.length).length),0);
 await mode('edit');
 assert.equal(await value(),'文字\n\n新段\n\n\n\n![](x.png)\n');
 assert.deepEqual(errors,[]);
 console.log('PASS each blank draws one row, Enter at line end and at an inline span, deliberate extra blanks, one-layer removal, marker is display only, reading view clean, code/YAML preserved');
}finally{await browser.close();}
