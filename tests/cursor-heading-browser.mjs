import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser = await chromium.launch(launchOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.goto('http://127.0.0.1:41732'); await page.click('#welcomeNewButton');
  await page.evaluate(async () => {
    const { createLeafEditor } = await import('/src/editor.js');
    document.querySelector('#editor').replaceChildren();
    window.testEditor = createLeafEditor({ parent: document.querySelector('#editor'), doc: '# 1.标题测试位置\n\n普通正文 **粗体内容** 后续文字\n\n## 1.1 子标题测试\n\n最后一段', showHeadingNumbers: true });
    testEditor.view.dispatch({ selection: { anchor: testEditor.getValue().length } });
  });
  for (const text of ['测试位置', '粗体内容', '后续文字', '子标题测试']) {
    const target = await page.evaluate(text => {
      const view = testEditor.view, pos = testEditor.getValue().indexOf(text);
      const dom = view.domAtPos(pos), range = document.createRange();
      range.setStart(dom.node, dom.offset); range.setEnd(dom.node, dom.offset + 1);
      const rect = range.getBoundingClientRect();
      return { pos, x: rect.left + 1, y: (rect.top + rect.bottom) / 2, mapped: view.posAtCoords({x: rect.left + 1, y:(rect.top+rect.bottom)/2}) };
    }, text);
    await page.mouse.click(target.x, target.y);
    const actual = await page.evaluate(() => testEditor.view.state.selection.main.head);
    console.log(text, target, actual);
    assert.equal(actual, target.pos);
  }
  await page.evaluate(() => { testEditor.setValue('普通文本'); testEditor.view.dispatch({selection:{anchor:2}}); testEditor.focus(); });
  for (let level = 1; level <= 6; level++) {
    await page.keyboard.press(`Alt+Digit${level}`);
    assert.equal(await page.evaluate(() => testEditor.getValue()), '#'.repeat(level) + ' 普通文本');
    assert.equal(await page.evaluate(() => testEditor.view.state.selection.main.head), level + 3);
  }
  await page.keyboard.press('Alt+Digit0');
  assert.equal(await page.evaluate(() => testEditor.getValue()), '普通文本');
  await page.keyboard.press('ControlOrMeta+z');
  assert.equal(await page.evaluate(() => testEditor.getValue()), '###### 普通文本');
  // The caret belongs on the far side of the marker it just gained. Applying a
  // level used to leave a caret that sits on the marker's own position -- an
  // empty line, or the start of a line -- in front of the `#`, so the hash read
  // as being in the way of the title rather than as something to type after.
  const levelAt = async (doc, anchor, key) => {
    await page.evaluate(({ doc, anchor }) => {
      testEditor.setValue(doc);
      testEditor.view.dispatch({ selection: { anchor } });
      testEditor.focus();
    }, { doc, anchor });
    await page.keyboard.press(key);
    return page.evaluate(() => ({ doc: testEditor.getValue(), caret: testEditor.view.state.selection.main.head }));
  };
  assert.deepEqual(await levelAt('', 0, 'Alt+Digit1'), { doc: '# ', caret: 2 });
  assert.deepEqual(await levelAt('', 0, 'Alt+Digit3'), { doc: '### ', caret: 4 });
  assert.deepEqual(await levelAt('标题', 0, 'Alt+Digit2'), { doc: '## 标题', caret: 3 });
  // Re-levelling with the caret on the old marker lands after the new one.
  assert.deepEqual(await levelAt('## 标题', 0, 'Alt+Digit1'), { doc: '# 标题', caret: 2 });
  // A caret already in the text keeps its distance from the text.
  assert.deepEqual(await levelAt('标题', 2, 'Alt+Digit1'), { doc: '# 标题', caret: 4 });
  assert.deepEqual(await levelAt('标题', 1, 'Alt+Digit1'), { doc: '# 标题', caret: 3 });
  // Dropping back to a paragraph leaves the caret at the text, not past it.
  assert.deepEqual(await levelAt('## 标题', 3, 'Alt+Digit0'), { doc: '标题', caret: 0 });
  // So typing continues the title on an empty line without reaching for Home.
  await page.evaluate(() => { testEditor.setValue(''); testEditor.view.dispatch({ selection: { anchor: 0 } }); testEditor.focus(); });
  await page.keyboard.press('Alt+Digit2');
  await page.keyboard.insertText('新标题');
  assert.equal(await page.evaluate(() => testEditor.getValue()), '## 新标题');
  await page.evaluate(() => { testEditor.setValue('原有标题\n====\n\n正文'); testEditor.format('heading2'); });
  assert.equal(await page.evaluate(() => testEditor.getValue()), '## 原有标题\n\n正文');
  await page.evaluate(() => { testEditor.setValue('# 标题 #\n\n正文'); testEditor.format('heading0'); });
  assert.equal(await page.evaluate(() => testEditor.getValue()), '标题\n\n正文');
  await page.evaluate(() => { testEditor.setValue('第一行\n第二行'); testEditor.view.dispatch({selection:{anchor:0,head:4}}); testEditor.format('heading2'); });
  assert.equal(await page.evaluate(() => testEditor.getValue()), '## 第一行\n第二行');
  await page.evaluate(() => {
    testEditor.setValue('Mac 标题'); testEditor.focus();
    testEditor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {key:'¡', code:'Digit1', altKey:true, bubbles:true, cancelable:true}));
  });
  assert.equal(await page.evaluate(() => testEditor.getValue()), '# Mac 标题');
  await page.screenshot({path:artifactPath('leaf-cursor-heading.png')});
  console.log('Pointer placement, heading shortcuts, caret preservation and undo passed');
} finally { await browser.close(); }
