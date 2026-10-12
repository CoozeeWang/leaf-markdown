import { chromium, launchOptions } from './browser-runtime.mjs';
import { webkit } from 'playwright';
import assert from 'node:assert/strict';

const engine = process.env.LEAF_INLINE_ENGINE === 'webkit' ? webkit : chromium;
const browser = await engine.launch(engine === webkit ? { headless: true } : launchOptions);
try {
  for (const platform of ['MacIntel', 'Win32']) {
    const page = await browser.newPage({ locale: 'zh-CN' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(platform => {
      Object.defineProperty(navigator, 'platform', { get: () => platform });
      Object.defineProperty(navigator, 'userAgentData', { get: () => undefined });
    }, platform);
    await page.goto('http://127.0.0.1:41732');
    await page.click('#welcomeNewButton');
    await page.evaluate(async () => {
      const { EditorView } = await import('/node_modules/@codemirror/view/dist/index.js');
      window.v = EditorView.findFromDOM(document.querySelector('.cm-content'));
    });
    const mod = platform === 'MacIntel' ? 'Meta' : 'Control';
    const source = '前文 示例 后文';
    const text = () => page.evaluate(() => v.state.doc.toString());
    const select = (from, to) => page.evaluate(([from, to]) => {
      v.dispatch({ selection: { anchor: from, head: to } }); v.focus();
    }, [from, to]);
    const reset = () => page.evaluate(source => {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: source }, selection: { anchor: 3, head: 5 } });
      v.focus();
    }, source);
    for (const [key, marker, selector] of [
      ['=', '==', '.leaf-highlight'],
      ['Alt+c', '`', '.cm-leaf-inline-code'],
    ]) {
      await reset();
      await page.keyboard.press(`${mod}+${key}`);
      assert.equal(await text(), `前文 ${marker}示例${marker} 后文`);
      await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('示例'), selector);
      await page.keyboard.press(`${mod}+z`);
      assert.equal(await text(), source, 'one undo restores the selected text');
      await page.click('#redoButton');
      assert.equal(await text(), `前文 ${marker}示例${marker} 后文`);
      await select(3, 5 + marker.length * 2);
      await page.keyboard.press(`${mod}+${key}`);
      assert.equal(await text(), source, 'selecting the marked text removes formatting');
      await select(3, 3);
      await page.keyboard.press(`${mod}+${key}`);
      assert.equal(await text(), `前文 ${marker}${marker}示例 后文`);
      assert.equal(await page.evaluate(() => v.state.selection.main.head), 3 + marker.length);
      await page.keyboard.press(`${mod}+z`);
      assert.equal(await text(), source);
    }
    // macOS Option+C may report ç; CodeMirror must resolve the underlying C key.
    if (platform === 'MacIntel') {
      await reset();
      await page.evaluate(() => v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ç', code: 'KeyC', keyCode: 67, metaKey: true, altKey: true, bubbles: true, cancelable: true,
      })));
      assert.equal(await text(), '前文 `示例` 后文');
    }
    await reset();
    const untouched = await page.evaluate(mod => {
      const input = document.createElement('input'); document.body.append(input); input.focus();
      const result = ['=', 'c'].map(key => {
        const event = new KeyboardEvent('keydown', { key, [mod === 'Meta' ? 'metaKey' : 'ctrlKey']: true,
          altKey: key === 'c', bubbles: true, cancelable: true });
        input.dispatchEvent(event); return event.defaultPrevented;
      });
      input.remove(); return result;
    }, mod);
    assert.deepEqual(untouched, [false, false], 'plain inputs keep their own editing');
    assert.equal(await text(), source);
    for (const [language, highlight, code] of [
      ['zh-Hans', '高亮', '行内代码'], ['zh-Hant-TW', '醒目標示', '行內程式碼'], ['en', 'Highlight', 'Inline Code'],
    ]) {
      await page.evaluate(async language => { const { setLanguagePreference } = await import('/src/i18n.js'); await setLanguagePreference(language); }, language);
      assert.equal(await page.locator('[data-format="code"]').getAttribute('data-tooltip'), `${code}  ${platform === 'MacIntel' ? '⌥⌘C' : 'Ctrl+Alt+C'}`);
      await page.click('#commandsButton');
      await page.fill('#paletteInput', highlight);
      const command = page.locator('.palette-list button').filter({ hasText: highlight });
      const shortcut = command.locator('kbd');
      assert.equal(await shortcut.innerText(), platform === 'MacIntel' ? '=' : 'Ctrl+=');
      if (platform === 'MacIntel') assert.equal(await shortcut.locator('[role="img"]').getAttribute('aria-label'), 'Command+=');
      await select(3, 5);
      await page.locator('.palette-list button').first().click();
      assert.equal(await text(), '前文 ==示例== 后文');
      await page.keyboard.press(`${mod}+z`);
      assert.equal(await text(), source);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS inline formatting shortcuts, rendered syntax, undo/redo, inputs, Option+C and three-language commands');
} finally { await browser.close(); }
