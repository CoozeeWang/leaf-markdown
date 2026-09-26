import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser = await chromium.launch(launchOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:41732'); await page.click('#welcomeNewButton');
  // Ten H2 sections make the last number two digits wide ("1.10"), the case
  // that used to push the number back over the fold arrow (issue #11).
  const sections = Array.from({ length: 10 }, (_, i) => `## 第${i + 1}条\n\n段落${i + 1}`).join('\n\n');
  const source = `# 总览\n\n${sections}\n\n# 附录\n\n正文`;
  await page.evaluate(async source => {
    const { createLeafEditor } = await import('/src/editor.js');
    document.querySelector('#editor').replaceChildren();
    window.foldEditor = createLeafEditor({ parent: document.querySelector('#editor'), doc: source, showHeadingNumbers: true });
    window.foldEditor.view.dispatch({ selection: { anchor: source.length } });
  }, source);

  const arrows = () => page.locator('#editor .cm-leaf-heading > .leaf-heading-fold');

  // Measure each arrow slot and the heading text that follows it. Hidden mark
  // spans (display:none) report no rects, so the leftmost visible child is
  // the heading text itself.
  const layout = () => arrows().evaluateAll(nodes => nodes.map(b => {
    const line = b.parentElement;
    const textLeft = [...line.children]
      .filter(n => !n.classList.contains('leaf-heading-fold'))
      .reduce((a, n) => Math.min(a, ...[...n.getClientRects()].filter(r => r.width > 0).map(r => r.left), Infinity), Infinity);
    const br = b.getBoundingClientRect(), lr = line.getBoundingClientRect();
    const svg = b.querySelector('svg')?.getBoundingClientRect() ?? null;
    return {
      position: getComputedStyle(b).position,
      paddingLeft: getComputedStyle(line).paddingLeft,
      arrowLeft: br.left, arrowRight: br.right, lineLeft: lr.left, textLeft,
      svgLeft: svg?.left ?? null, svgRight: svg?.right ?? null,
    };
  }));

  // With numbering on, the heading line neither moves nor indents: the number
  // starts exactly where the text always started. The arrow leaves the inline
  // flow and parks in its usual gutter slot just left of that position, so
  // arrow and number can never overlap whatever the number's width.
  const numbered = await layout();
  assert.ok(numbered.length >= 5, `expected rendered arrows, got ${numbered.length}`);
  for (const item of numbered) {
    assert.equal(item.position, 'absolute');
    assert.equal(item.paddingLeft, '6px', 'numbered headings must not indent');
    assert.ok(item.arrowLeft < item.lineLeft, 'arrow sits in the margin, outside the text column');
    assert.ok(item.arrowRight <= item.textLeft, `arrow slot (${item.arrowRight}) crosses the number (${item.textLeft})`);
    assert.ok(item.svgRight <= item.textLeft - 3, 'arrow glyph clears the number');
  }
  // Every arrow shares one gutter position, whatever the number's width.
  const lefts = numbered.map(i => i.arrowLeft);
  assert.ok(Math.max(...lefts) - Math.min(...lefts) < 1, 'all arrows align in the gutter');

  // Hovering the arrow paints no button wash (issue #12).
  await arrows().first().hover();
  assert.equal(await arrows().first().evaluate(b => getComputedStyle(b).backgroundColor), 'rgba(0, 0, 0, 0)');

  // Scroll to the two-digit number ("1.10") and confirm its arrow still sits
  // in the same gutter. CM virtualizes lines, so scrolling is required.
  await page.evaluate(() => { const s = document.querySelector('#editor .cm-scroller'); s.scrollTop = s.scrollHeight; });
  await page.waitForTimeout(150);
  const scrolled = await layout();
  assert.ok(scrolled.length >= 1, 'arrows render after scrolling');
  for (const item of scrolled) {
    assert.equal(item.position, 'absolute');
    assert.equal(item.paddingLeft, '6px', 'numbered headings must not indent');
    assert.ok(Math.abs(item.arrowLeft - lefts[0]) < 1, 'two-digit number keeps the same gutter');
    assert.ok(item.svgRight <= item.textLeft - 3, 'arrow glyph clears the number');
  }

  // Numbering off: the arrow is back inline at its original slot, flush with
  // the heading text, and the glyph still clears it.
  await page.evaluate(() => { window.foldEditor.setHeadingNumbers(false); const s = document.querySelector('#editor .cm-scroller'); s.scrollTop = 0; });
  await page.waitForTimeout(150);
  const plain = await layout();
  assert.ok(plain.length >= 5, `expected rendered arrows, got ${plain.length}`);
  for (const item of plain) {
    assert.equal(item.position, 'static');
    assert.equal(item.paddingLeft, '6px');
    assert.ok(item.arrowRight <= item.textLeft, `arrow slot (${item.arrowRight}) overlaps heading text (${item.textLeft})`);
    assert.ok(item.svgRight <= item.textLeft - 3, 'arrow glyph clears the heading text');
  }
  await arrows().first().hover();
  assert.equal(await arrows().first().evaluate(b => getComputedStyle(b).backgroundColor), 'rgba(0, 0, 0, 0)');

  // The arrow keeps the same visual spot whether or not numbering is on.
  const glyphDrift = Math.abs((numbered[0].svgLeft + numbered[0].svgRight) - (plain[0].svgLeft + plain[0].svgRight));
  assert.ok(glyphDrift < 6, `arrow glyph moved ${glyphDrift / 2}px between numbered and plain`);

  // The arrow still folds and unfolds.
  await page.screenshot({ path: artifactPath('leaf-heading-fold-arrow.png') });
  await page.evaluate(() => { window.foldEditor.setHeadingNumbers(true); const s = document.querySelector('#editor .cm-scroller'); s.scrollTop = 0; });
  await page.waitForTimeout(150);
  await arrows().first().click();
  await page.locator('#editor .cm-foldPlaceholder').waitFor();
  await arrows().first().click();
  await page.locator('#editor .cm-foldPlaceholder').waitFor({ state: 'detached' });

  assert.deepEqual(errors, []);
  console.log('Heading fold arrow gutter, hover wash, and fold behavior passed');
} finally { await browser.close(); }
