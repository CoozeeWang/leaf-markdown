import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { artifactPath, launchOptions } from './browser-runtime.mjs';

const fixtures = [
  '- Parent\n  - A1 示例内容\n    - Child 子级说明\n    - Another child',
  '- Parent\n  - A1 Example\n  - Next sibling',
  '> A1 引用内容\n> Next quotation',
  'A1 Plain paragraph\nNext paragraph',
  '- Parent\n  - A1 Example\n',
];
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  const browser = await engine.launch(name === 'chromium' ? launchOptions : { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, locale: 'zh-CN' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.LEAF_TEST_BASE_URL || 'http://127.0.0.1:41732');
    await page.waitForSelector('.shell[data-body-fonts=ready]');
    await page.click('#welcomeNewButton');
    await page.evaluate(async () => {
      const { EditorView } = await import('/node_modules/@codemirror/view/dist/index.js');
      window.v = EditorView.findFromDOM(document.querySelector('.cm-content'));
    });
    const settle = () => page.evaluate(() => new Promise(resolve => v.requestMeasure({
      read: () => null, write: () => requestAnimationFrame(() => requestAnimationFrame(resolve)),
    })));
    const geometry = () => page.evaluate(() => {
      const range = v.state.selection.main;
      return {
        selected: v.state.sliceDoc(range.from, range.to),
        to: range.to,
        end: v.coordsAtPos(range.to, -1),
        rects: [...document.querySelectorAll('.leaf-selectionLayer .cm-selectionBackground')].map(el => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }),
      };
    });
    for (const theme of ['light', 'dark']) {
      await page.click('#appearanceButton'); await page.click('#settingsTab-appearance');
      await page.selectOption('#themeSelect', theme); await page.keyboard.press('Escape');
      for (const zoom of [75, 100, 150]) {
        await page.click('#zoomLevel'); await page.click(`#zoomPopover [data-zoom="${zoom}"]`);
        for (const [index, body] of fixtures.entries()) {
          const source = '# Synthetic sample\n\n' + body;
          const from = source.lastIndexOf('\n', source.indexOf('A1')) + 1;
          const to = source.indexOf('\n', from) + 1;
          await page.evaluate(({ source, from }) => {
            v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: source }, selection: { anchor: from + 4 }, scrollIntoView: true });
            v.focus();
          }, { source, from });
          await settle();
          const point = await page.evaluate(pos => {
            const r = v.coordsAtPos(pos); return { x: r.left + 1, y: (r.top + r.bottom) / 2 };
          }, source.indexOf('A1') + 1);
          await page.mouse.click(point.x, point.y, { clickCount: 3 });
          await settle();
          const label = `${name}/${theme}/${zoom}/${index}`;
          const checkBoundary = async () => {
            const g = await geometry();
            assert.equal(g.selected, source.slice(from, to), `${label}: newline remains selected`);
            assert.ok(g.rects.some(r => r.right > r.left), `${label}: selected line remains visible`);
            assert.ok(g.rects.every(r => r.bottom <= g.end.top + .5), `${label}: no paint on unselected next row: ${JSON.stringify(g)}`);
          };
          await checkBoundary();
          // The same boundary can be reached by a reverse drag or keyboard selection.
          await page.evaluate(({ from, to }) => v.dispatch({ selection: { anchor: to, head: from } }), { from, to });
          await settle(); await checkBoundary();
          if (index === 0 && zoom === 100) await page.screenshot({ path: artifactPath(`selection-line-boundary-${name}-${theme}.png`) });
          // Once actual next-line text is included, its highlight must remain.
          if (to < source.length) {
            const partial = to + source.slice(to).search(/\S/) + 3;
            await page.evaluate(({ from, partial }) => v.dispatch({ selection: { anchor: from, head: partial } }), { from, partial });
            await settle();
            const g = await geometry();
            assert.equal(g.selected, source.slice(from, partial));
            assert.ok(g.rects.some(r => r.bottom > g.end.top && r.top < g.end.bottom && r.right > r.left), `${label}: partial next row stays highlighted`);
            assert.ok(Math.abs(g.rects.at(-1).right - g.end.right) < 1, `${label}: partial endpoint stays exact: ${JSON.stringify(g)}`);
          }
          assert.equal(await page.evaluate(() => v.state.doc.toString()), source);
        }
      }
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${name}: triple click, reverse boundaries and partial next-line selections; 5 fixtures, 2 themes, 3 zooms`);
  } finally { await browser.close(); }
}
