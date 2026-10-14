import { chromium, launchOptions } from './browser-runtime.mjs';
import { webkit } from 'playwright';
import assert from 'node:assert/strict';

const engine = process.env.LEAF_INLINE_ENGINE === 'webkit' ? webkit : chromium;
const browser = await engine.launch(engine === webkit ? { headless: true } : launchOptions);
try {
  for (const platform of ['MacIntel', 'Win32']) {
    const page = await browser.newPage({ locale: 'zh-CN' }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(platform => Object.defineProperty(navigator, 'platform', { get: () => platform }), platform);
    await page.goto('http://127.0.0.1:41732');
    await page.click('#welcomeNewButton');
    await page.evaluate(async () => {
      const { EditorView } = await import('/node_modules/@codemirror/view/dist/index.js');
      window.v = EditorView.findFromDOM(document.querySelector('.cm-content'));
    });
    const text = () => page.evaluate(() => v.state.doc.toString());
    const select = (from, to = from) => page.evaluate(([from, to]) => {
      v.dispatch({ selection: { anchor: from, head: to } }); v.focus();
    }, [from, to]);
    const reset = (source, from, to) => page.evaluate(async ([source, from, to]) => {
      const { isolateHistory } = await import('/node_modules/@codemirror/commands/dist/index.js');
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: source },
        selection: { anchor: from, head: to }, annotations: isolateHistory.of('full') }); v.focus();
    }, [source, from, to]);
    const mod = platform === 'MacIntel' ? 'Meta' : 'Control';
    for (const [type, marker, shortcut, selector, style, value] of [
      ['italic', '*', 'i', '.tok-emphasis', 'fontStyle', 'italic'],
      ['bold', '**', 'b', '.tok-strong', 'fontWeight', '600'],
      ['strike', '~~', 'Shift+x', '.tok-strike', 'textDecorationLine', 'line-through'],
    ]) {
      const source = '前文“重点。”后文\n\n结尾';
      const expected = `前文 ${marker}“重点。”${marker} 后文\n\n结尾`;
      for (const input of ['button', 'shortcut']) {
        await reset(source, 2, 7);
        if (input === 'button') await page.click(`[data-format="${type}"]`);
        else await page.keyboard.press(`${mod}+${shortcut}`);
        assert.equal(await text(), expected, `${platform} ${type} ${input}`);
        await select(expected.length);
        const span = page.locator(`.cm-content ${selector}`).first();
        await span.waitFor();
        assert.equal(await span.textContent(), '“重点。”');
        assert.equal(await span.evaluate((el, style) => getComputedStyle(el)[style], style), value);
        await page.keyboard.press(`${mod}+z`);
        assert.equal(await text(), source, 'one undo includes both added spaces');
        await page.click('#redoButton');
        assert.equal(await text(), expected);
        await select(3, 3 + marker.length * 2 + 5);
        await page.click(`[data-format="${type}"]`);
        assert.equal(await text(), '前文 “重点。” 后文\n\n结尾', 'cancel preserves spacing');
      }
      const paragraphs = '前文 重点。 后文\n\n下一段。';
      await reset(paragraphs, 2, paragraphs.length);
      await page.click(`[data-format="${type}"]`);
      assert.equal(await text(), `前文 ${marker}重点。 后文${marker}\n\n${marker}下一段。${marker}`);
      await page.keyboard.press(`${mod}+z`);
      assert.equal(await text(), '前文 重点。 后文\n\n下一段。');
    }
    const code = 'a`b\n\n结尾';
    await reset(code, 0, 3); await page.click('[data-format="code"]');
    assert.equal(await text(), '``a`b``\n\n结尾');
    await select((await text()).length);
    assert.equal(await page.locator('.cm-leaf-inline-code').first().innerText(), 'a`b');
    await select(0, 7); await page.click('[data-format="code"]');
    assert.equal(await text(), code);
    await reset('正文', 1, 1); await page.click('[data-format="italic"]');
    assert.equal(await text(), '正**文');
    assert.equal(await page.evaluate(() => v.state.selection.main.head), 2);
    await page.keyboard.insertText('新');
    assert.equal(await text(), '正*新*文');
    await page.keyboard.press(`${mod}+z`); assert.equal(await text(), '正**文');
    await page.keyboard.press(`${mod}+z`); assert.equal(await text(), '正文');
    // The editor and the reading/export inline renderer interpret the same file.
    const html = await page.evaluate(async () => {
      const { renderInline } = await import('/src/inline-preview.js');
      const root = document.createElement('div');
      renderInline(root, '前文 *“斜体。”* 后文 **“粗体。”** 后文 ~~“删除。”~~ 后文');
      return [root.querySelector('em')?.textContent, root.querySelector('strong')?.textContent, root.querySelector('s')?.textContent];
    });
    assert.deepEqual(html, ['“斜体。”', '“粗体。”', '“删除。”']);
    await page.evaluate(async () => {
      const { setLanguagePreference } = await import('/src/i18n.js'); await setLanguagePreference('en');
    });
    await reset('before"focus."after', 6, 14);
    await page.click('[data-format="bold"]');
    assert.equal(await text(), 'before **"focus."** after', 'English text and interface use the same rules');
    assert.deepEqual(errors, []); await page.close();
  }
  console.log('PASS inline-format buttons, Mac/Windows shortcuts, styles, paragraphs, code, cancel and one undo/redo');
} finally { await browser.close(); }
