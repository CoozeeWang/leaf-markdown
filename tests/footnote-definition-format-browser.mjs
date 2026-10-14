import assert from 'node:assert/strict';
import { webkit } from 'playwright';
import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';

const source = '正文[^sample]，**粗体**、*斜体*、`code`、==高亮==。\n\n'
  + '[^sample]: **粗体**、*斜体*、`code`、==高亮== 和 [**链接**](https://example.com)，\\*转义\\*、`**字面**`、**未闭合。\n'
  + '    **跨行\n    粗体**\n\n    第二段 ==段落高亮==\n\n'
  + '    ```text\n    **块内字面** ==代码内字面==\n    ```\n\n尾段';
const repro = '正文[^sample]。\n\n[^sample]: **粗体**、*斜体*、`code`、==高亮==。\n\n尾段';
for (const engine of process.env.LEAF_FOOTNOTE_ENGINE ? [process.env.LEAF_FOOTNOTE_ENGINE] : ['chrome', 'webkit']) {
  const browser = await (engine === 'webkit' ? webkit.launch({ headless: true }) : chromium.launch(launchOptions));
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 1000 }, locale: 'zh-CN' }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:41732'); await page.click('#welcomeNewButton');
    await page.evaluate(async source => {
      const { EditorView } = await import('/node_modules/@codemirror/view/dist/index.js');
      window.v = EditorView.findFromDOM(document.querySelector('#editor .cm-content'));
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: source }, selection: { anchor: source.length } });
    }, repro);
    assert.ok(await page.locator('#editor .leaf-footnote-body .tok-strong').count() > 0, 'original compact definition must render bold');
    await page.evaluate(source => v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: source }, selection: { anchor: source.length } }), source);
    await page.click('#notesButton');
    const foot = page.locator('#editor .leaf-footnote-body');
    assert.ok(await foot.locator('.tok-strong').count() > 0, 'definition body must render bold, not a link destination');
    assert.equal(await foot.locator('.tok-strong').first().innerText(), '粗体');
    assert.equal(await foot.locator('.tok-emphasis').first().innerText(), '斜体');
    assert.equal(await foot.locator('.cm-leaf-inline-code').first().innerText(), 'code');
    assert.equal(await foot.locator('.leaf-highlight').first().innerText(), '高亮');
    assert.equal(await foot.locator('.leaf-inline-link').innerText(), '链接');
    const rendered = (await foot.allTextContents()).join('\n');
    assert.ok(rendered.includes('\\*转义\\*') && rendered.includes('**字面**') && rendered.includes('**未闭合'));
    assert.ok(rendered.includes('**块内字面** ==代码内字面=='), 'real fenced code stays literal');
    assert.ok((await foot.locator('.tok-strong').allTextContents()).includes('跨行'));
    assert.ok((await foot.locator('.tok-strong').allTextContents()).includes('粗体'));
    assert.equal(await foot.locator('.leaf-highlight').last().innerText(), '段落高亮');
    // The old grammar tint must not override actual inline colors or code fonts.
    for (const selector of ['.tok-strong', '.tok-emphasis', '.cm-leaf-inline-code', '.leaf-highlight']) {
      const style = el => { const c = getComputedStyle(el); return [c.color, c.backgroundColor, c.fontFamily, c.fontWeight, c.fontStyle]; };
      assert.deepEqual(await foot.locator(selector).first().evaluate(style), await page.locator('#editor .cm-line').first().locator(selector).first().evaluate(style), selector);
    }
    assert.equal(await page.evaluate(() => v.state.doc.toString()), source, 'rendering never writes the source');
    await page.screenshot({ path: artifactPath(`footnote-definition-format-${engine}.png`) });
    await page.evaluate(() => {
      const note=document.querySelector('.leaf-endnote')._editor.view;
      note.dispatch({selection:{anchor:2}});note.focus();
    });
    await page.keyboard.insertText('新');
    assert.ok((await page.evaluate(() => v.state.doc.toString())).includes('**新粗体**'));
    await page.click('#undoButton'); assert.equal(await page.evaluate(() => v.state.doc.toString()), source);
    await page.click('#redoButton'); assert.ok((await page.evaluate(() => v.state.doc.toString())).includes('**新粗体**'));
    await page.click('#undoButton');
    const mode = async name => { await page.click('#readingToggle'); await page.click(`[data-mode=${name}]`); };
    await mode('source');
    assert.ok((await page.locator('#editor .cm-content').innerText()).includes('[^sample]: **粗体**'));
    assert.equal(await foot.count(), 0);
    await mode('reading');
    assert.equal(await page.locator('.reading-document .print-footnotes strong').first().innerText(), '粗体');
    await mode('edit');
    await page.evaluate(() => v.dispatch({ selection: { anchor: v.state.doc.length } }));
    await page.waitForFunction(() => document.querySelector('#editor .leaf-footnote-body .tok-strong')?.textContent === '粗体');
    assert.equal(await page.evaluate(() => v.state.doc.toString()), source);
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine}: definition formatting, real parser spans, source/focus rules and undo/redo`);
  } finally { await browser.close(); }
}
