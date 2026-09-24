// The current-line band and a drawn selection must agree about where the text
// is, and the band must never be painted over a selection.
//
// A heading can add padding inside its own measured row, so the band
// used to reach from that padding down past the paragraph below, and over a
// selection it replaced the selection's colour and drew a third, darker band
// where the two overlapped. These assertions read the rendered pixels, because
// that is where the report came from.
import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';

const browser = await chromium.launch(launchOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:41732');
  await page.click('#welcomeNewButton');
  // A fresh document has the gutter off; the report was made with it on.
  await page.click('#displayButton');
  await page.check('#lineNumberToggle');
  await page.click('#displayButton');

  const source = [
    '前置段落一。',                                    // 1
    '',                                                // 2
    '前置段落二。',                                    // 3
    '',                                                // 4
    '准备日期：2026-09-13',                            // 5
    '对应代码：ui/redesign-versions · 660d4f5',        // 6
    '自动检查参考：363 项前端测试、代码检查和构建通过。', // 7
    '',                                                // 8
    '## 怎么用',                                        // 9
    '',                                                // 10
    '每完成一项，把 `- [ ]` 改成 `- [x]`，或在支持任务列表的编辑器里直接点击方框。勾选表示已经执行，不自动表示通过。发现问题请在该组的反馈区写明项目编号；未测试或不适用的项目保持未勾选并注明原因。', // 11
    '',                                                // 12
    '只用测试音频、测试稿件及其副本。文件异常测试使用另一份独立副本，勿直接操作真实访谈。建议按顺序测试；遇到正文丢失、保存错版本或覆盖原稿，先停下并保留现场。', // 13
    '',                                                // 14
    '### 本轮记录',                                     // 15
  ].join('\n');

  await page.evaluate(async source => {
    const { EditorView } = await import('/node_modules/@codemirror/view/dist/index.js');
    window.v = EditorView.findFromDOM(document.querySelector('.cm-content'));
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: source } });
  }, source);
  await page.waitForTimeout(200);

  // Where things are on screen: the active line's row box, the bounds of its
  // text, and the paragraph's rows. The x used for sampling is the middle of
  // the content, where the short heading has no glyph to sit on.
  const geometry = () => page.evaluate(() => {
    const round = n => Math.round(n * 10) / 10;
    const box = el => { const r = el.getBoundingClientRect(); return { top: round(r.top), bottom: round(r.bottom), height: round(r.height), left: round(r.left), right: round(r.right) }; };
    const line = n => document.querySelectorAll('.cm-content > .cm-line')[n - 1];
    const glyphs = el => {
      const pos = v.posAtDOM(el, 0);
      const c = pos == null ? null : v.coordsAtPos(Math.min(pos + 1, v.state.doc.length));
      return c ? { top: round(c.top), bottom: round(c.bottom), left: round(c.left) } : null;
    };
    const gutter = document.querySelector('.cm-gutters');
    const g = gutter.getBoundingClientRect();
    const padding = el => { const s = getComputedStyle(el); return { top: parseFloat(s.paddingTop), bottom: parseFloat(s.paddingBottom) }; };
    return {
      heading: { box: box(line(9)), text: glyphs(line(9)), padding: padding(line(9)) },
      blank: { box: box(line(10)) },
      paragraph: { box: box(line(11)), text: glyphs(line(11)), padding: padding(line(11)) },
      followingBlank: { box: box(line(12)) },
      sampleX: Math.round((v.contentDOM.getBoundingClientRect().left + v.contentDOM.getBoundingClientRect().right) / 2),
      gutterX: Math.round((g.left + g.right) / 2),
      lineNumberCount: document.querySelectorAll('.cm-lineNumbers .cm-gutterElement').length,
    };
  });

  // Rendered pixels down one column, one entry per row.
  const column = async (x, y0, y1) => {
    const shot = await page.screenshot({ clip: { x, y: y0, width: 1, height: y1 - y0 } });
    return page.evaluate(async ([data, y0]) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + data;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      const ctx = c.getContext('2d');
      const rows = [];
      for (let y = 0; y < img.naturalHeight; y++) {
        const d = ctx.getImageData(0, y, 1, 1).data;
        rows.push({ y: y + y0, rgb: [d[0], d[1], d[2]] });
      }
      return rows;
    }, [shot.toString('base64'), y0]);
  };

  const canvasColour = () => page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;width:1px;height:1px';
    document.body.appendChild(probe);
    probe.style.background = getComputedStyle(document.querySelector('.cm-editor')).backgroundColor;
    const out = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return out;
  });

  // Composite an element colour with a known alpha over the canvas, so the
  // assertion names the exact pixel it expects instead of trusting a sample.
  const parse = value => {
    const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(value)
      || /rgba?\((\d+), ?(\d+), ?(\d+)(?:, ?([\d.]+))?\)/.exec(value);
    assert.ok(srgb, `unparsed colour: ${value}`);
    const scale = /^color\(/.test(value) ? 255 : 1;
    return { r: srgb[1] * scale, g: srgb[2] * scale, b: srgb[3] * scale, a: srgb[4] === undefined ? 1 : Number(srgb[4]) };
  };
  const over = (top, bottom) => [
    Math.round(top.r * top.a + bottom[0] * (1 - top.a)),
    Math.round(top.g * top.a + bottom[1] * (1 - top.a)),
    Math.round(top.b * top.a + bottom[2] * (1 - top.a)),
  ];
  const layerColour = selector => page.evaluate(selector => {
    const el = document.querySelector(selector);
    return el ? getComputedStyle(el).backgroundColor : null;
  }, selector);

  const canvas = parse(await canvasColour());
  assert.equal(canvas.a, 1, `canvas is opaque: ${JSON.stringify(canvas)}`);
  const canvasRGB = [Math.round(canvas.r), Math.round(canvas.g), Math.round(canvas.b)];

  const park = line => page.evaluate(line => {
    v.focus();
    v.dispatch({ selection: { anchor: v.state.doc.line(line).from } });
    return v.hasFocus;
  }, line);
  // Select from `headLine` down to `anchorLine`, so the caret sits on the line
  // the report was about.
  const selectTo = (headLine, anchorLine) => page.evaluate(([headLine, anchorLine]) => {
    const doc = v.state.doc;
    v.focus();
    v.dispatch({ selection: { anchor: doc.line(anchorLine).to, head: doc.line(headLine).from } });
  }, [headLine, anchorLine]);

  const at = (rows, y) => rows.find(r => r.y === y)?.rgb;
  const isCanvas = rgb => rgb && rgb.every((v, i) => Math.abs(v - canvasRGB[i]) <= 1);
  const eq = (a, b) => a && a.every((v, i) => Math.abs(v - b[i]) <= 2);
  // Glyph ink and its anti-aliased edges are darker than the band they sit on,
  // in every channel. A band of some other colour is not.
  const isInk = (rgb, band) => rgb && rgb.every((v, i) => v <= band[i] + 2);
  const show = rgb => rgb ? rgb.join(',') : 'off-screen';

  const geo = await geometry();
  assert.ok(geo.lineNumberCount > 0, 'the gutter is showing line numbers');
  const sampleX = geo.sampleX;
  const headingTextMiddle = Math.round((geo.heading.text.top + geo.heading.text.bottom) / 2);
  const paragraphRowMiddle = Math.round((geo.paragraph.text.top + geo.paragraph.text.bottom) / 2);

  // 1. Caret alone on the heading: the band marks the text, not the block.
  //    Blank lines around this heading remove its own padding. Its active band
  //    must still stop at the measured row, without painting adjacent blanks.
  assert.equal(await park(9), true, 'the editor takes focus');
  await page.waitForTimeout(150);
  const activeLine = parse(await layerColour('.cm-activeLine'));
  const expectedBand = over(activeLine, canvasRGB);
  const contentTop = geo.heading.box.top + geo.heading.padding.top;
  const contentBottom = geo.heading.box.bottom - geo.heading.padding.bottom;
  assert.deepEqual(geo.heading.padding, { top: 0, bottom: 0 },
    `blank lines remove heading padding: ${JSON.stringify(geo.heading.padding)}`);
  const caretRows = await column(sampleX, Math.round(geo.heading.box.top) - 4, Math.round(geo.heading.box.bottom) + 8);
  for (const row of caretRows) {
    if (row.y >= Math.round(contentTop) && row.y <= Math.round(contentBottom)) continue;
    assert.ok(isCanvas(row.rgb), `the heading's own padding is unpainted at y=${row.y}, got ${show(row.rgb)}`);
  }
  assert.ok(eq(at(caretRows, headingTextMiddle), expectedBand), `the band is drawn where the text is: y=${headingTextMiddle} ${show(at(caretRows, headingTextMiddle))} vs ${show(expectedBand)}`);
  assert.ok(isCanvas(at(caretRows, Math.round(geo.heading.box.bottom) + 4)), 'nothing is painted below the band');
  await page.screenshot({ path: artifactPath('leaf-highlight-band-heading.png') });

  // A heading is not special: on a plain row the band is still the whole row.
  assert.equal(await park(11), true);
  await page.waitForTimeout(150);
  const rowRows = await column(sampleX, Math.round(geo.paragraph.box.top) - 2, Math.round(geo.paragraph.box.bottom) + 2);
  const painted = rowRows.filter(r => !isCanvas(r.rgb));
  assert.ok(painted.length > 80, `the band on a paragraph row covers the row (${painted.length} rows)`);
  assert.ok(eq(painted[0].rgb, expectedBand), `the paragraph band is the same colour: ${show(painted[0].rgb)}`);
  assert.ok(painted[0].y <= geo.paragraph.box.top + 1, `the band starts at the row top: ${painted[0].y} vs ${geo.paragraph.box.top}`);
  assert.ok(painted[painted.length - 1].y >= geo.paragraph.box.bottom - 2, `the band ends at the row bottom: ${painted[painted.length - 1].y} vs ${geo.paragraph.box.bottom}`);

  // 2. A selection that crosses the caret's row keeps one colour and one shape.
  //    The caret stays on the heading, which is what the report showed.
  await selectTo(9, 11);
  await page.waitForTimeout(150);
  const selection = parse(await layerColour('.leaf-selectionLayer .cm-selectionBackground'));
  selection.a *= await page.locator('.leaf-selectionLayer').evaluate(el => Number(getComputedStyle(el).opacity));
  const expectedSelection = over(selection, canvasRGB);
  assert.notDeepEqual(expectedSelection, expectedBand, 'the two bands are distinguishable colours');
  const selectionRows = await column(sampleX, Math.round(geo.heading.text.top) - 24, Math.round(geo.paragraph.box.top) + 90);
  // Every painted row inside the selection is the selection colour: no band
  // tints the caret's row and no third colour appears where the two overlap.
  for (const row of selectionRows) {
    if (isCanvas(row.rgb)) continue;
    assert.ok(eq(row.rgb, expectedSelection) || isInk(row.rgb, expectedSelection),
      `only the selection colour inside the selection: y=${row.y} ${show(row.rgb)} vs ${show(expectedSelection)}`);
  }
  // Nothing above the heading's text or in the blank row after the selected
  // paragraph is painted. Do not sample the next paragraph's real text.
  const aboveSelection = await column(sampleX, Math.round(geo.heading.box.top) + 1, geo.heading.text.top - 1);
  for (const row of aboveSelection) assert.ok(isCanvas(row.rgb), `no band above the selected text: y=${row.y} ${show(row.rgb)}`);
  const belowSelection = await column(sampleX, Math.round(geo.followingBlank.box.top) + 2, Math.round(geo.followingBlank.box.bottom) - 2);
  for (const row of belowSelection) assert.ok(isCanvas(row.rgb), `nothing below the selection: y=${row.y} ${show(row.rgb)}`);
  // The selection really did cover the rows it is supposed to, or the loop
  // above would pass on an empty selection.
  assert.ok(eq(at(selectionRows, headingTextMiddle), expectedSelection), 'the heading is selected');
  assert.ok(eq(at(selectionRows, paragraphRowMiddle), expectedSelection)
    || isInk(at(selectionRows, paragraphRowMiddle), expectedSelection), 'the paragraph is selected');
  await page.screenshot({ path: artifactPath('leaf-highlight-band-selection.png') });

  // 3. The gutter never takes a band: a gutter cell is as tall as the whole row
  //    and knows nothing about the block it belongs to, so its band could only
  //    ever disagree with the row next to it.
  const gutterRows = await column(Math.max(1, geo.gutterX), Math.round(geo.heading.box.top) - 4, Math.round(geo.heading.box.bottom) + 8);
  for (const row of gutterRows) assert.ok(isCanvas(row.rgb), `the gutter is unpainted at y=${row.y}, got ${show(row.rgb)}`);
  assert.equal(await layerColour('.cm-activeLineGutter'), null, 'no gutter element is marked as the current row');

  // 4. Dropping the selection brings the band back.
  await park(9);
  await page.waitForTimeout(150);
  const backRows = await column(sampleX, headingTextMiddle, headingTextMiddle + 1);
  assert.ok(eq(at(backRows, headingTextMiddle), expectedBand), `the band returns when the selection is dropped: ${show(at(backRows, headingTextMiddle))}`);

  assert.deepEqual(errors, []);
  console.log('highlight band: the current row and a selection agree, and the gutter stays clean');
} finally {
  await browser.close();
}
