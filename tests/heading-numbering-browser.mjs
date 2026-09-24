import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser = await chromium.launch(launchOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:41732'); await page.click('#welcomeNewButton');
  const source = '# 阅读路线\n\n# 1.这轮研究\n\n## 1.1 创业命题\n\n## 1.2 第二小节\n\n# 2.后续安排\n\n正文';
  await page.evaluate(async source => {
    const { createLeafEditor } = await import('/src/editor.js');
    document.querySelector('#editor').replaceChildren();
    window.numberEditor = createLeafEditor({ parent: document.querySelector('#editor'), doc: source, showHeadingNumbers: true });
    numberEditor.view.dispatch({ selection: { anchor: source.length } });
  }, source);
  const numbers = () => page.locator('#editor .cm-leaf-heading').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-heading-number')));
  const titles = () => page.locator('#editor .cm-leaf-heading').allTextContents();
  assert.deepEqual(await numbers(), ['1.', '2.', '2.1', '2.2', '3.']);
  assert.deepEqual((await titles()).map(s => s.trim()), ['阅读路线', '这轮研究', '创业命题', '第二小节', '后续安排']);
  assert.equal(await page.evaluate(() => numberEditor.getValue()), source);
  await page.evaluate(() => numberEditor.view.dispatch({ selection: { anchor: numberEditor.getValue().indexOf('创业') } }));
  assert.ok((await titles())[2].includes('1.1'));
  assert.equal((await numbers())[2], null); // Editing shows source, not two numbers.
  await page.evaluate(() => numberEditor.view.dispatch({ selection: { anchor: numberEditor.getValue().length } }));
  await page.evaluate(() => numberEditor.view.dispatch({ changes: { from: 0, to: numberEditor.getValue().indexOf('# 1.'), insert: '' } }));
  assert.deepEqual(await numbers(), ['1.', '1.1', '1.2', '2.']);
  await page.evaluate(() => { const pos = numberEditor.getValue().indexOf('##'); numberEditor.view.dispatch({ changes: { from: pos, to: pos + 1, insert: '' } }); });
  assert.deepEqual(await numbers(), ['1.', '2.', '2.1', '3.']);
  assert.ok(!(await titles())[1].includes('1.1'));
  await page.screenshot({ path: artifactPath('leaf-heading-replacement.png') });
  const edited = await page.evaluate(() => numberEditor.getValue());
  await page.evaluate(() => numberEditor.setHeadingNumbers(false));
  assert.ok((await titles())[1].includes('1.1'));
  assert.equal(await page.evaluate(() => numberEditor.getValue()), edited);
  await page.evaluate(() => {
    numberEditor.setValue('# 1.父标题\n\n## 1.1 子标题\n\n正文'); numberEditor.setHeadingNumbers(true);
    numberEditor.view.dispatch({ selection: { anchor: numberEditor.getValue().length } });
    numberEditor.view.dispatch({ changes: { from: 0, to: numberEditor.getValue().indexOf('##'), insert: '' } });
  });
  assert.equal((await titles())[0].trim(), '子标题');
  assert.deepEqual(await numbers(), ['1.']);
  assert.deepEqual(errors, []);
  console.log('Live renumbering and display-only prefix replacement passed');
} finally { await browser.close(); }
