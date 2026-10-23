import { chromium, webkit } from 'playwright';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { launchOptions, artifactPath } from './browser-runtime.mjs';

const source = Array.from({length: 24}, (_, i) => `Synthetic paragraph ${i}.\n`).join('\n')
  + '\n> Quote text for selecting and reviewing.\n\n'
  + '> 引用段落中的文字应当能够准确选中，并显示清楚的选区背景。\n\n'
  + '> ' + 'Wrapped quotation with synthetic words for accurate selection. '.repeat(4)
  + '\n\nFollowing plain paragraph for cross-block selection.\n';
const ranges = [
  [source.indexOf('Quote') + 3, source.indexOf('reviewing')],
  [source.indexOf('引用') + 3, source.indexOf('选区背景')],
  [source.indexOf('Wrapped') + 4, source.indexOf('Wrapped') + 100],
  [source.indexOf('Wrapped') + 160, source.indexOf('Following') + 16],
];

for (const [name, engine] of Object.entries({chromium, webkit})) {
  const browser = await engine.launch(name === 'chromium' ? launchOptions : {headless: true});
  try {
    const page = await browser.newPage({locale: name === 'chromium' ? 'zh-CN' : 'en-US', viewport: {width: 1000, height: 850}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:41732');
    await page.waitForSelector('.shell[data-body-fonts=ready]');
    await page.click('#welcomeNewButton');
    await page.evaluate(async source => {
      const {EditorView} = await import('/node_modules/@codemirror/view/dist/index.js');
      window.v = EditorView.findFromDOM(document.querySelector('.cm-content'));
      window.scrollSelection = pos => {
        const r=v.coordsAtPos(pos), pane=v.scrollDOM.getBoundingClientRect();
        v.scrollDOM.scrollTop += (r.top-pane.top-120)/v.scaleY;
      };
      v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: source}});
    }, source);
    const settle = () => page.evaluate(() => new Promise(resolve => v.requestMeasure({read: () => null,
      write: () => requestAnimationFrame(() => requestAnimationFrame(resolve))})));
    const selection = () => page.evaluate(() => ({from: v.state.selection.main.from, to: v.state.selection.main.to}));
    const checkPaint = async label => {
      await settle();
      const geometry = await page.evaluate(() => {
        const range = v.state.selection.main;
        const rects = [...document.querySelectorAll('.leaf-selectionLayer .cm-selectionBackground')].map(e => {
          const r = e.getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom};
        });
        const start = v.coordsAtPos(range.from, 1), end = v.coordsAtPos(range.to, -1);
        const quote = v.dom.querySelector('.cm-leaf-quote');
        const paint = getComputedStyle(quote, '::before');
        const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
        ctx.fillStyle = paint.backgroundColor; ctx.fillRect(0,0,1,1);
        return {rects, start, end, scroll: v.scrollDOM.scrollTop, quoteRGB: [...ctx.getImageData(0,0,1,1).data].slice(0,3), border: paint.borderLeftWidth};
      });
      assert.ok(geometry.scroll > 0, `${label}: exercised scrolling`);
      assert.ok(geometry.rects.length);
      assert.ok(Math.abs(geometry.rects[0].left - geometry.start.left) < 1, `${label}: first edge`);
      assert.ok(Math.abs(geometry.rects.at(-1).right - geometry.end.right) < 1, `${label}: last edge`);
      assert.ok(Math.abs(geometry.rects[0].top - geometry.start.top) < 1, `${label}: first row`);
      assert.ok(Math.abs(geometry.rects.at(-1).bottom - geometry.end.bottom) < 1, `${label}: last row`);
      const r = geometry.rects[0];
      // Identify background pixels from an actual screenshot, excluding glyph ink
      // (Chinese glyphs can reach the top of the measured selection box).
      const clip = {x: Math.ceil(r.left + 2), y: Math.ceil(r.top+2), width: Math.max(1,Math.min(80,Math.floor(r.right-r.left)-4)), height: Math.max(1,Math.floor(r.bottom-r.top)-5)};
      const before = await page.screenshot({clip});
      await page.locator('.leaf-selectionLayer').evaluate(el => { el.style.visibility = 'hidden'; });
      const hidden = await page.screenshot({clip});
      await page.locator('.leaf-selectionLayer').evaluate(el => { el.style.visibility = ''; });
      const pixels = async buffer => [...(await sharp(buffer).removeAlpha().raw().toBuffer())];
      const hiddenPixels = await pixels(hidden);
      assert.notDeepEqual(await pixels(before), hiddenPixels, `${label}: selection is visible above quote paint`);
      const background = [];
      for(let i=0;i<hiddenPixels.length;i+=3) if(geometry.quoteRGB.every((n,c)=>Math.abs(n-hiddenPixels[i+c])<=2)) background.push(i);
      assert.ok(background.length>=3, `${label}: opaque quote background retained`);
      assert.equal(geometry.border, '2px', `${label}: quote border retained`);
      // Overlapping pieces must still composite once in the single layer.
      await page.locator('.leaf-selectionLayer').evaluate(el => {
        const clone = el.firstElementChild.cloneNode(true); clone.dataset.probe = ''; el.append(clone);
      });
      const overlap = await pixels(await page.screenshot({clip})), original = await pixels(before);
      assert.ok(background.every(i => [0,1,2].every(c => Math.abs(overlap[i+c]-original[i+c])<=2)), `${label}: no overlap darkening (allow compositor rounding)`);
      assert.ok(background.some(i => [0,1,2].some(c => Math.abs(original[i+c]-hiddenPixels[i+c])>5)), `${label}: background pixels show selection`);
      await page.locator('[data-probe]').evaluate(el => el.remove());
      assert.equal(await page.evaluate(() => getComputedStyle(v.contentDOM, '::selection').backgroundColor), 'rgba(0, 0, 0, 0)');
      assert.equal(await page.evaluate(() => v.state.doc.toString()), source);
    };
    for (const theme of ['light', 'dark']) {
      await page.click('#appearanceButton'); await page.click('#settingsTab-appearance');
      await page.selectOption('#themeSelect', theme); await page.keyboard.press('Escape');
      for (const zoom of [75, 100, 150, 200]) {
        console.log(`${name}/${theme}/${zoom}`);
        await page.click('#zoomLevel'); await page.click(`#zoomPopover [data-zoom="${zoom}"]`);
        await page.waitForFunction(zoom => Math.abs(v.scaleY - zoom / 100) < .02, zoom);
        for (const [index, [from, to]] of ranges.entries()) {
          for (const reverse of [false, true]) {
            // Start with the caret inside the quote so its visible Markdown
            // markers and wrapping are settled before deriving pointer targets.
            await page.evaluate(from => { v.dispatch({selection: {anchor: from}}); scrollSelection(from); v.focus(); }, from);
            await settle();
            await page.evaluate(pos => scrollSelection(pos), from);
            await settle();
            await page.waitForFunction(pos => { const r=v.coordsAtPos(pos), box=v.scrollDOM.getBoundingClientRect();return r && r.top>=box.top && r.bottom<=box.bottom; },from);
            const coords = await page.evaluate(([from, to]) => [from, to].map(pos => {
              const r = v.coordsAtPos(pos); return {x: r.left, y: (r.top + r.bottom) / 2, hit: v.posAtCoords({x:r.left,y:(r.top+r.bottom)/2})};
            }), [from, to]);
            assert.deepEqual(coords.map(c => c.hit), [from, to], `${name}/${zoom}/${index}: pointer round trip`);
            const [a,b] = reverse ? coords.toReversed() : coords;
            await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, {steps: 12}); await page.mouse.up();
            assert.deepEqual(await selection(), {from,to}, `${name}/${zoom}/${index}: real drag endpoints`);
            assert.equal(await page.evaluate(() => v.state.selection.main.anchor), reverse ? to : from, 'drag direction');
            await checkPaint(`${name}/${theme}/${zoom}/${index}/${reverse}`);
          }
        }
        // Extend through wrapping and block boundaries at 100%; also check
        // English/Chinese keyboard selection at each scaled size.
        const keyboardRanges = zoom === 100 ? ranges : ranges.slice(0,2).map(([from]) => [from,from+8]);
        for (const [from,to] of keyboardRanges) for (const reverse of [false,true]) {
          await page.evaluate(pos => {v.dispatch({selection:{anchor:pos}});scrollSelection(pos);v.focus();}, reverse ? to : from);
          await settle();
          await page.evaluate(pos => scrollSelection(pos), from);
          await settle();
          await page.keyboard.down('Shift');
          for (let n=from;n<to;n++) await page.keyboard.press(reverse ? 'ArrowLeft' : 'ArrowRight');
          await page.keyboard.up('Shift');
          assert.deepEqual(await selection(),{from,to});
          assert.equal(await page.evaluate(() => v.state.selection.main.anchor), reverse ? to : from, 'keyboard direction');
          await checkPaint(`${name}/${theme}/${zoom}/keyboard/${reverse}`);
        }
      }
      await page.screenshot({path: artifactPath(`quote-selection-${name}-${theme}.png`)});
    }
    // Clipboard events exercise the editor's actual handlers without relying on
    // OS clipboard permissions. Verify payload, cut/replacement and undo.
    for (const event of ['copy','cut']) {
      const [from,to] = ranges[1];
      const result = await page.evaluate(({event,from,to}) => {
        v.dispatch({selection:{anchor:from,head:to}});v.focus();
        const data = new DataTransfer();
        v.contentDOM.dispatchEvent(new ClipboardEvent(event,{clipboardData:data,bubbles:true,cancelable:true}));
        return {payload:data.getData('text/plain'),doc:v.state.doc.toString()};
      },{event,from,to});
      assert.equal(result.payload,source.slice(from,to));
      assert.equal(result.doc,event==='copy'?source:source.slice(0,from)+source.slice(to));
      if(event==='cut') {await page.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');assert.equal(await page.evaluate(()=>v.state.doc.toString()),source);}
    }
    const [from,to]=ranges[2];
    await page.evaluate(({from,to})=>{v.dispatch({selection:{anchor:to,head:from}});v.focus();},{from,to});
    await page.keyboard.insertText('Replacement');
    assert.equal(await page.evaluate(()=>v.state.doc.toString()),source.slice(0,from)+'Replacement'+source.slice(to));
    assert.deepEqual(errors,[]);
    console.log(`PASS ${name}: quote paint, real mouse/keyboard, both directions, wrapped/cross-block, scroll, 75–200%, themes and clipboard/edit ranges`);
  } finally {await browser.close();}
}
