import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
  const page=await browser.newPage({viewport:{width:1200,height:900},deviceScaleFactor:2}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
  await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
  const doc=()=>page.evaluate(()=>v.state.doc.toString());
  const dim=id=>page.locator(id).isDisabled();

  // A fresh document has nothing to undo or redo, so both controls are dimmed
  // rather than offering an action that would do nothing.
  assert.equal(await doc(),'');
  assert.equal(await dim('#undoButton'),true,'空文档的撤销应为禁用');
  assert.equal(await dim('#redoButton'),true,'空文档的重做应为禁用');
  // Idle is not invisible: 40% of --muted turned the 1.8px stroke into an empty
  // slot on a freshly opened document, which is exactly when both icons idle.
  const idleOpacity = await page.evaluate(()=>Number(getComputedStyle(document.querySelector('#undoButton')).opacity));
  assert.ok(idleOpacity >= .6,`空历史时撤销图标过淡: opacity=${idleOpacity}`);

  await page.keyboard.type('甲');
  assert.equal(await doc(),'甲');
  assert.equal(await dim('#undoButton'),false);
  assert.equal(await dim('#redoButton'),true);

  // The tooltip carries the platform shortcut, drawn with the shared modifier
  // glyphs so it does not depend on the font covering ⌘.
  await page.hover('#undoButton');await page.waitForTimeout(400);
  assert.equal(await page.locator('#tooltip').isVisible(),true);
  assert.equal(await page.locator('#tooltip').textContent(),'撤销  Z');
  assert.equal(await page.locator('#tooltip svg[data-modifier="Command"]').count(),1);
  assert.equal(await page.locator('#tooltip .shortcut-keys').getAttribute('aria-label'),'Command+Z');
  await page.locator('.format-toolbar').screenshot({path:artifactPath('leaf-toolbar-history.png')});

  await page.click('#undoButton');
  assert.equal(await doc(),'');
  assert.equal(await dim('#undoButton'),true);
  assert.equal(await dim('#redoButton'),false);
  // The caret comes back to the editor, so the next keystroke and the next Cmd-Z
  // still land in the document instead of dying on the button.
  assert.equal(await page.evaluate(()=>!!document.activeElement.closest('.cm-editor')),true);
  await page.keyboard.type('乙');
  assert.equal(await doc(),'乙','工具栏撤销后仍可直接输入');

  // A formatting command is a programmatic change, so the editor's own history
  // has to own it — the case that used to break undo on macOS.
  await page.evaluate(()=>{v.dispatch({selection:{anchor:0,head:1}});v.focus();});
  await page.locator('.format-toolbar button[data-format="sup"]').click();
  assert.equal(await doc(),'<sup>乙</sup>');
  await page.click('#undoButton');
  assert.equal(await doc(),'乙','工具栏撤销应能撤回程序化格式改动');
  assert.equal(await dim('#redoButton'),false);
  await page.click('#redoButton');
  assert.equal(await doc(),'<sup>乙</sup>');
  assert.equal(await dim('#redoButton'),true);

  assert.deepEqual(errors,[]);
  console.log('PASS toolbar undo and redo run the editor history, dim when empty and keep the caret');
} finally { await browser.close(); }
