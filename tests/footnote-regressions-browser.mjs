import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:41732');
  await page.click('#welcomeNewButton');
  await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
  const setDoc=text=>page.evaluate(t=>v.dispatch({changes:{from:0,to:v.state.doc.length,insert:t},selection:{anchor:0}}),text);
  const caret=at=>page.evaluate(at=>{v.dispatch({selection:{anchor:at}});v.focus();},at);
  const doc=()=>page.evaluate(()=>v.state.doc.toString());
  const button=page.locator('[data-format="footnote"]');
  const box=page.locator('.footnote-box textarea');

  // Reproduce manual typing beside an existing marker, checking every keystroke.
  await setDoc('甲[^1] 乙[^2] 丙[^3] 新增[^Test] 丁[^4] 戊[^5]\n\n[^1]: A\n[^2]: B\n[^3]: C\n[^Test]: Test\n[^4]: D\n[^5]: E');
  await page.click('#commandsButton');
  await page.locator('#paletteInput').fill('按引用顺序重新编号脚注');
  await page.locator('#paletteList button').click();
  assert.equal(await doc(),'甲[^1] 乙[^2] 丙[^3] 新增[^Test] 丁[^5] 戊[^6]\n\n[^1]: A\n[^2]: B\n[^3]: C\n[^Test]: Test\n[^5]: D\n[^6]: E');
  await page.click('#notesButton');
  assert.equal(await page.locator('.note-label').count(),0,'侧栏不再显示重复的标签行');
  await page.locator('.note-card[data-label="5"] .note-body').fill('D 改写');
  await page.locator('.note-card[data-label="6"] .note-body').fill('E 改写');
  assert.ok((await doc()).includes('[^5]: D 改写\n[^6]: E 改写'));
  await page.click('[data-close="notes"]');

  const original='甲[^1] 乙[^2]\n\n[^1]: A\n[^2]: B';
  const at=original.indexOf('乙')+1;
  await setDoc(original);
  await caret(at);
  let typed='';
  for (const key of '[^Test]') {
    typed+=key;
    await page.keyboard.type(key);
    assert.equal(await doc(),original.slice(0,at)+typed+original.slice(at),`输入 ${typed} 不得改动旧定义`);
  }
  await page.click('#notesButton');
  assert.deepEqual(await page.locator('.note-body').evaluateAll(es=>es.map(e=>e.value)),['A','B','']);
  const newBody=page.locator('.note-card[data-label="Test"] .note-body');
  await newBody.fill('行业注释');
  await newBody.press('Escape');
  await page.waitForTimeout(150);
  assert.deepEqual(await page.locator('.note-body').evaluateAll(es=>es.map(e=>e.value)),['A','行业注释','B']);
  assert.ok((await doc()).includes('[^3]: B'));
  await page.click('[data-close="notes"]');
  await caret(0);
  assert.deepEqual(await page.locator('.cm-content .footnote-ref').allTextContents(),['1','2','3']);
  await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
  assert.deepEqual(await page.locator('.reading-document .footnote-ref').allTextContents(),['1','2','3']);
  await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();

  await setDoc('甲[^1] 中间[^9] 乙[^2]\n\n[^1]: A\n[^2]: B');
  await page.click('#notesButton');
  await page.locator('.note-card[data-label="9"] .note-body').fill('新');
  await page.keyboard.type('注释');
  assert.equal(await page.evaluate(()=>document.activeElement.closest('.note-card').dataset.label),'2');
  await page.locator('.note-card[data-label="3"] .note-body').fill('旧注释改写');
  assert.equal(await doc(),'甲[^1] 中间[^2] 乙[^3]\n\n[^1]: A\n[^2]: 新注释\n[^3]: 旧注释改写');
  await page.click('[data-close="notes"]');

  await setDoc('来源: 甲[^1] 乙[^2]\n\n[^1]: A\n[^2]: B');
  await caret(2);
  await button.click();
  await box.fill('行业注释');
  await box.press('Escape');
  assert.equal(await doc(),'来源[^1]: 甲[^2] 乙[^3]\n\n[^1]: 行业注释\n[^2]: A\n[^3]: B');
  await caret(0);
  assert.deepEqual(await page.locator('.cm-content .footnote-ref').allTextContents(),['1','2','3']);
  await page.click('#notesButton');
  assert.deepEqual(await page.locator('.note-body').evaluateAll(es=>es.map(e=>e.value)),['行业注释','A','B']);
  await page.click('[data-close="notes"]');
  await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
  assert.deepEqual(await page.locator('.reading-document .footnote-ref').allTextContents(),['1','2','3']);
  await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();

  // Moving a selection containing another citation can require a second numbering
  // pass. The popup must edit the newly inserted note, never its former label.
  await setDoc('甲[^1] 乙[^2]\n\n[^1]: A\n[^2]: B');
  await page.evaluate(()=>{v.dispatch({selection:{anchor:0,head:5}});v.focus();});
  await button.click();
  assert.equal(await box.inputValue(),'甲[^3]');
  await box.fill('新注释正文');
  await box.press('Escape');
  assert.ok((await doc()).includes('[^1]: 新注释正文'));
  assert.ok(!(await doc()).includes('[^3]: A'),'替换包含最后引用的注释正文时，也清理其定义');

  // Adjacent markers are parsed as one reference link; each must open its own note.
  await setDoc('甲[^1][^2]。\n\n[^1]: A\n[^2]: B');
  await caret(0);
  await page.locator('.cm-content .footnote-ref').nth(1).click();
  assert.equal(await page.locator('.note-card.active .note-body').inputValue(),'B');
  await page.click('[data-close="notes"]');

  // A title caret offset must be added to the title's source start.
  await setDoc('> [!note] 行业情况说明\n> 正文[^1]\n\n[^1]: A');
  await page.locator('.leaf-callout-title').click();
  await page.evaluate(()=>{
    const input=document.querySelector('.leaf-callout-title textarea');
    input.focus();input.setSelectionRange(4,4);
  });
  await button.click();
  await box.fill('标题注释');
  // Confirming an IME candidate must not close the popup.
  await box.evaluate(input=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true})));
  assert.equal(await box.count(),1);
  await box.press('Escape');
  assert.equal(await doc(),'> [!note] 行业情况[^1]说明\n> 正文[^2]\n\n[^1]: 标题注释\n[^2]: A');
  assert.deepEqual(errors,[]);
  console.log('footnote-regressions-browser: PASS');
} finally {await browser.close();}
