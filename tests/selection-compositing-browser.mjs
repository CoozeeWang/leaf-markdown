import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { artifactPath, launchOptions } from './browser-runtime.mjs';

// Native WebKit can overlap selection pieces at paragraph boundaries. Exercise
// that geometry explicitly, since Playwright's newer engines don't reproduce it.
// Sample empty selected space: a darker pixel must never be excused as glyph ink.
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  const browser = await engine.launch(name === 'chromium' ? launchOptions : { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    await page.goto('http://127.0.0.1:41732');
    await page.click('#welcomeNewButton');
    const source = '## 标题\n\n正文一。\n\n正文二。';
    await page.evaluate(async source => {
      const { EditorView } = await import('/node_modules/@codemirror/view/dist/index.js');
      window.v = EditorView.findFromDOM(document.querySelector('.cm-content'));
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: source } });
    }, source);
    for (const theme of ['light', 'dark']) {
      await page.click('#appearanceButton');
      await page.click('#settingsTab-appearance');await page.selectOption('#themeSelect', theme);
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        v.focus();
        v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
      });
      await page.waitForTimeout(100);
      const clip = await page.evaluate(() => {
        const r = document.querySelector('.leaf-selectionLayer .cm-selectionBackground').getBoundingClientRect();
        // Well right of the short heading, away from antialiased text and edges.
        return { x: Math.floor(r.right - 40), y: Math.ceil(r.top + 5), width: 5, height: 5 };
      });
      const before = await page.screenshot({ clip });
      await page.evaluate(() => {
        const piece = document.querySelector('.leaf-selectionLayer .cm-selectionBackground');
        const clone = piece.cloneNode(true);
        clone.dataset.overlapProbe = 'true';
        piece.parentElement.appendChild(clone);
      });
      const after = await page.screenshot({ clip });
      assert.deepEqual(after, before, `${name}/${theme}: overlapping selection pieces must not darken`);
      await page.evaluate(() => document.querySelector('[data-overlap-probe]').remove());
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.cm-line'), '::selection').backgroundColor), 'rgba(0, 0, 0, 0)', `${name}/${theme}: no second native selection`);
      assert.equal(await page.evaluate(() => getComputedStyle(v.contentDOM, '::selection').backgroundColor), 'rgba(0, 0, 0, 0)', `${name}/${theme}: native paragraph gaps must also be transparent`);
      const inputSelection = await page.evaluate(() => {
        const input = document.createElement('textarea');
        v.dom.appendChild(input);
        const colour = getComputedStyle(input, '::selection').backgroundColor;
        input.remove();
        return colour;
      });
      assert.notEqual(inputSelection, 'rgba(0, 0, 0, 0)', `${name}/${theme}: structured inputs retain native selection`);
      await page.screenshot({ path: artifactPath(`selection-compositing-${name}-${theme}.png`) });
      assert.equal(await page.evaluate(() => v.state.doc.toString()), source);
    }
    console.log(`${name}: overlapping selections keep one colour in light and dark themes`);
  } finally {
    await browser.close();
  }
}
