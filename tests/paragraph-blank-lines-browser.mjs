import {chromium, webkit} from 'playwright';
import {launchOptions, artifactPath} from './browser-runtime.mjs';
import {source, expected} from './fixtures/paragraph-blank-lines.mjs';
import assert from 'node:assert/strict';

for (const engine of [chromium, webkit]) {
 const browser=await engine.launch(engine===chromium ? launchOptions : {headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1100,height:820}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(source=>{
   window.fixtureFile={content:source,modified:1,writes:0};
   const handle={name:'空行整理.md',kind:'file',
    getFile:async()=>new File([fixtureFile.content],'空行整理.md',{lastModified:fixtureFile.modified}),
    createWritable:async()=>({write:async content=>{fixtureFile.content=content;fixtureFile.modified++;fixtureFile.writes++;},close:async()=>{}})};
   window.showOpenFilePicker=async()=>[handle];
  },source);
  await page.goto('http://127.0.0.1:41732');
  await page.click('#welcomeOpenButton');
  await page.locator('.cm-line').filter({hasText:'第一段'}).first().waitFor();
  const value=()=>page.evaluate(async()=>{
   const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
   return EditorView.findFromDOM(document.querySelector('.cm-content')).state.doc.toString();
  });
  assert.equal(await value(),source,'opening does not silently tidy or renumber the file');
  assert.equal(await page.locator('#tidyBlankLines').getAttribute('data-tooltip'),'整理段落空行  ⌥⌘\\','hover wording is unchanged');
  await page.click('#tidyBlankLines');
  assert.equal(await value(),expected);
  assert.deepEqual(await page.locator('.leaf-list-marker').allTextContents(),['●','○','○','●','1.','2.','●','●','●','●'],'preview preserves nested marker levels and consecutive ordered numbers');
  assert.ok(await page.locator('.cm-content').innerText().then(text=>text.includes('代码第二行')&&text.includes('末段')),'preview retains protected content and the final paragraph');
  await page.screenshot({path:artifactPath(`paragraph-blank-lines-${engine.name()}.png`)});
  await page.click('#undoButton');
  assert.equal(await value(),source,'one undo restores whitespace and original ordered markers together');
  await page.click('#redoButton');
  assert.equal(await value(),expected);
  await page.keyboard.press('ControlOrMeta+Alt+Backslash');
  assert.equal(await value(),expected);
  assert.equal(await page.locator('#saveStatus').textContent(),'无需整理');
  await page.click('#undoButton');
  assert.equal(await value(),source,'a no-op cleanup creates no extra undo step');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Alt+Backslash');
  assert.equal(await value(),expected,'the shortcut performs the same whole-document cleanup');
  await page.click('#saveButton');
  await page.waitForFunction(()=>fixtureFile.writes>0);
  assert.equal(await page.evaluate(()=>fixtureFile.content),expected,'the saved bytes match the editor');
  const stored=await page.evaluate(()=>fixtureFile.content);
  await page.reload();
  await page.evaluate(content=>{fixtureFile.content=content;fixtureFile.writes=0;},stored);
  await page.click('#welcomeOpenButton');
  await page.locator('.cm-line').filter({hasText:'末段'}).first().waitFor();
  assert.equal(await value(),expected,'reopening preserves the saved cleanup');
  await page.click('#tidyBlankLines');
  assert.equal(await page.locator('#saveStatus').textContent(),'无需整理');
  assert.deepEqual(errors,[]);
  console.log(`PASS ${engine.name()}: add/remove blanks, nested/task/multi-paragraph lists, protected code, unchanged tooltip, button/shortcut, one-step undo/redo, no-op, saved bytes and reopen`);
 } finally {await browser.close();}
}
