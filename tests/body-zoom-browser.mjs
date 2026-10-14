import {chromium, launchOptions, artifactPath} from './browser-runtime.mjs';
import {webkit} from 'playwright';
import assert from 'node:assert/strict';

const engine = process.env.LEAF_ZOOM_ENGINE === 'webkit' ? webkit : chromium;
const browser = await engine.launch(engine === webkit ? {headless: true} : launchOptions);
const levels = [50, 75, 90, 100, 110, 125, 150, 200];
const source = '# Zoom sample\n\nPlain text for accurate selection.\n\n| Name | Value |\n| --- | --- |\n| sample | 12 |\n\n![sample](sample.assets/zoom.svg)\n\n```js\nconst value = 12;\n```\n\nText[^1].\n\n[^1]: A synthetic note.';
try {
  for (const platform of ['MacIntel', 'Win32']) {
    const page = await browser.newPage({locale: 'zh-CN', viewport: {width: 1100, height: 800}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(platform => {
      Object.defineProperty(navigator, 'platform', {get: () => platform});
      Object.defineProperty(navigator, 'userAgentData', {get: () => undefined});
    }, platform);
    await page.goto('http://127.0.0.1:41732');
    await page.click('#welcomeNewButton');
    await page.evaluate(async () => {
      const {EditorView} = await import('/node_modules/@codemirror/view/dist/index.js');
      window.v = EditorView.findFromDOM(document.querySelector('#editor .cm-content'));
      const {setResourceReader}=await import('/src/resources.js');
      setResourceReader(async () => Array.from(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#607b68"/></svg>')));
    });
    const mod = platform === 'MacIntel' ? 'Meta' : 'Control';
    const text = () => page.evaluate(() => v.state.doc.toString());
    const resetDocument = content => page.evaluate(content => {
      v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: content}, selection: {anchor: content.indexOf('Plain')}});
      v.focus();
    }, content);
    const mode = async name => {
      await page.click('#readingToggle'); await page.click(`[data-mode="${name}"]`);
    };
    const zoom = async value => {
      await page.click('#zoomLevel');
      assert.equal(await page.locator('#zoomLevel').getAttribute('aria-expanded'), 'true');
      await page.click(`#zoomPopover [role="menuitemradio"][data-zoom="${value}"]`);
      await page.waitForFunction(value => document.querySelector('#zoomLevel').textContent === `${value}%`, value);
      if (await page.locator('#editor').isVisible()) await page.waitForFunction(value => Math.abs(v.scaleY - value / 100) < .02, value);
    };
    await resetDocument(source);
    const geometry = () => page.evaluate(() => ({
      area: document.querySelector('.document-area').getBoundingClientRect().height,
      editor: v.dom.getBoundingClientRect().height,
      toolbar: document.querySelector('.topbar').getBoundingClientRect().height,
      footer: document.querySelector('.statusbar').getBoundingClientRect().height,
      font: document.querySelector('#fontSizeValue').textContent,
      width: document.querySelector('#contentWidthValue').textContent,
    }));
    const before = await geometry();
    for (const value of levels) {
      await zoom(value);
      const box = await geometry();
      assert.ok(Math.abs(box.editor - box.area) < 2, `${engine.name()} ${value}% editor fits its viewport: ${JSON.stringify(box)}`);
      for (const key of ['toolbar', 'footer', 'font', 'width']) assert.equal(box[key], before[key], `${key} must not scale`);
      assert.equal(await text(), source);
      const position = source.indexOf('Plain') + 7;
      await page.evaluate(position => {
        v.dispatch({selection: {anchor: position}, scrollIntoView: true}); v.focus();
      }, position);
      await page.waitForFunction(position => {
        const rect = v.coordsAtPos(position), pane = v.scrollDOM.getBoundingClientRect();
        return rect && rect.top >= pane.top && rect.bottom <= pane.bottom;
      }, position);
      const hit = await page.evaluate(position => {
        const r = v.coordsAtPos(position);
        return v.posAtCoords({x: r.left, y: (r.top + r.bottom) / 2});
      }, position);
      assert.equal(hit, position, `${engine.name()} ${value}% coordinates round-trip`);
      const point = await page.evaluate(position => {const r = v.coordsAtPos(position); return {x:r.left,y:(r.top+r.bottom)/2};}, position);
      await page.mouse.click(point.x, point.y);
      assert.equal(await page.evaluate(() => v.state.selection.main.head), position, 'real mouse hits the displayed text');
      await page.keyboard.type('Z');
      assert.equal(await text(), source.slice(0, position) + 'Z' + source.slice(position));
      await page.keyboard.press(`${mod}+z`);
      assert.equal(await text(), source, 'zoom never enters undo history');
    }
    assert.equal(await page.locator('#zoomIn').isDisabled(), true);
    await zoom(50); assert.equal(await page.locator('#zoomOut').isDisabled(), true);
    await zoom(100);
    const selection = source.indexOf('Plain');
    await page.evaluate(from => {v.dispatch({selection: {anchor: from, head: from+5}}); v.focus();}, selection);
    await page.keyboard.press(`${mod}+Shift+Equal`);
    assert.equal(await page.locator('#zoomLevel').innerText(), '110%');
    assert.equal(await text(), source, 'Shift zoom must not highlight');
    assert.deepEqual(await page.evaluate(() => [v.state.selection.main.from, v.state.selection.main.to]), [selection, selection+5]);
    await page.keyboard.press(`${mod}+Equal`);
    assert.equal(await text(), source.slice(0, selection)+'==Plain=='+source.slice(selection+5), 'existing highlight works');
    await page.keyboard.press(`${mod}+z`); assert.equal(await text(), source);
    await page.keyboard.press(`${mod}+Shift+Minus`);
    assert.equal(await page.locator('#zoomLevel').innerText(), '100%');
    await page.keyboard.press(`${mod}+Shift+Equal`);
    await page.keyboard.press(`${mod}+Shift+Digit0`);
    assert.equal(await page.locator('#zoomLevel').innerText(), '100%');
    const ignoredIME = await page.evaluate(platform => {
      const e = new KeyboardEvent('keydown', {key:'+',code:'Equal',shiftKey:true,metaKey:platform==='MacIntel',ctrlKey:platform!=='MacIntel',isComposing:true,bubbles:true,cancelable:true});
      v.contentDOM.dispatchEvent(e);return e.defaultPrevented;
    }, platform);
    assert.equal(ignoredIME, false); assert.equal(await text(), source);
    for (const value of [50, 150, 200]) {
      await zoom(value);
      const cell=page.locator('#editor td').first();
      await cell.scrollIntoViewIfNeeded();
      const box=await cell.boundingBox();
      await page.mouse.move(box.x+box.width/2,box.y+box.height-2);
      const handle=page.getByRole('button',{name:'在此插入行',exact:true});
      const edge=await handle.boundingBox();
      assert.ok(Math.abs(edge.x+edge.width/2-box.x-box.width/2)<3, `table insertion handle X matches ${value}%`);
      assert.ok(Math.abs(edge.y+edge.height/2-box.y-box.height)<3, `table insertion handle Y matches ${value}%`);
      await handle.click();
      assert.notEqual(await text(),source,'scaled table edge inserts a row');
      await page.keyboard.press(`${mod}+z`);assert.equal(await text(),source);
      await cell.click();
      const input=page.locator('#editor textarea[data-row="1"][data-col="0"]');
      await input.fill('changed');await page.locator('#zoomLevel').focus();
      assert.ok((await text()).includes('| changed | 12 |'),'scaled cell edit writes the intended cell');
      // The footer owns focus here; use the toolbar's document undo rather
      // than the browser's own focused-control undo routing.
      await page.click('#undoButton');
      assert.equal(await text(),source);
    }
    await zoom(150);
    await mode('source'); assert.equal(await page.locator('#zoomLevel').innerText(), '150%');
    await mode('reading'); assert.equal(await page.locator('#zoomLevel').innerText(), '150%');
    const readingBox = () => page.evaluate(() => ({
      font: getComputedStyle(document.querySelector('.reading-document')).fontSize,
      line: document.querySelector('.reading-document p').getBoundingClientRect().height,
      image: document.querySelector('.reading-document img').getBoundingClientRect().width,
      table: document.querySelector('.reading-document table').getBoundingClientRect().height,
    }));
    await zoom(100); await page.locator('.reading-document img').waitFor();
    const normal = await readingBox(); await zoom(200); const larger = await readingBox();
    assert.equal(larger.font, normal.font);
    for (const key of ['line', 'table', 'image']) assert.ok(Math.abs(larger[key] / normal[key] - 2) < .15, `reading ${key} scales`);
    // A viewport-constrained image may wrap/fit; it stays inside its content area.
    assert.ok(larger.image > 0);
    assert.equal(await text(), source);
    await mode('edit');
    await zoom(200);
    await page.click('#notesButton');
    assert.equal(await page.locator('#notesDrawer .cm-editor').evaluate(el => getComputedStyle(el).zoom), '1', 'sidebar stays unscaled');
    await page.click('[data-close="notes"]');
    await page.keyboard.press(`${mod}+f`);
    const panelScale = await page.locator('#editor .cm-panels').evaluate(el => {
      const rect=el.getBoundingClientRect();return rect.height/el.offsetHeight;
    });
    assert.ok(Math.abs(panelScale-1)<.05, 'search panel stays at normal scale');
    await page.keyboard.press('Escape');

    // Long document: preserve the visible text, not only a percentage scroll.
    const long = Array.from({length: 180}, (_,i) => `Plain paragraph ${i}: synthetic text for zoom anchoring.`).join('\n\n');
    await resetDocument(long); await zoom(100);
    const anchor = long.indexOf('Plain paragraph 100:');
    await page.evaluate(async anchor => {
      const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
      v.dispatch({selection:{anchor},effects:v.constructor.scrollIntoView(anchor,{y:'center'})});v.focus();
    }, anchor);
    try {
      await page.waitForFunction(anchor => {const r=v.coordsAtPos(anchor),p=v.scrollDOM.getBoundingClientRect();return r&&r.top>p.top&&r.bottom<p.bottom;}, anchor, {timeout:5000});
    } catch (error) {
      console.log(await page.evaluate(anchor=>({scale:v.scaleY,coords:v.coordsAtPos(anchor),pane:v.scrollDOM.getBoundingClientRect().toJSON(),scroll:v.scrollDOM.scrollTop,scrollHeight:v.scrollDOM.scrollHeight,head:v.state.selection.main.head,viewport:v.viewport}),anchor));
      await page.screenshot({path:artifactPath('body-zoom-anchor-failure.png')});throw error;
    }
    const yBefore = await page.evaluate(anchor => v.coordsAtPos(anchor).top, anchor);
    await page.keyboard.press(`${mod}+Shift+Equal`);
    await page.waitForFunction(() => Math.abs(v.scaleY-1.1)<.02);
    await page.waitForFunction(([anchor,y]) => Math.abs(v.coordsAtPos(anchor).top-y)<5,[anchor,yBefore],{timeout:5000});
    const yAfter = await page.evaluate(anchor => v.coordsAtPos(anchor).top, anchor);
    assert.ok(Math.abs(yAfter-yBefore)<5, `caret remains at its screen position: ${yBefore} -> ${yAfter}`);
    await mode('reading');
    const readingAnchor = await page.evaluate(() => {
      const pane=document.querySelector('#readingPane');pane.scrollTop=2000;
      const top=pane.getBoundingClientRect().top+40;
      return [...document.querySelectorAll('.reading-document p')].find(el=>el.getBoundingClientRect().bottom>=top)?.textContent;
    });
    await zoom(150);
    const visible = await page.evaluate(() => {
      const top=document.querySelector('#readingPane').getBoundingClientRect().top+40;
      return [...document.querySelectorAll('.reading-document p')].find(el=>el.getBoundingClientRect().bottom>=top)?.textContent;
    });
    assert.equal(visible, readingAnchor, 'reading zoom retains the visible paragraph');

    // Each export uses an independent window and print styles. Compare the
    // actual previews opened from two different body zoom levels.
    await mode('edit'); await resetDocument(source);
    const exports=[];
    for (const percent of [50,200]) {
      await zoom(percent);
      await page.click('#exportMenuButton');
      const popupPromise=page.waitForEvent('popup');
      await page.click('#exportButton');
      const popup=await popupPromise;
      await popup.locator('.print-document p').first().waitFor();
      await popup.emulateMedia({media:'print'});
      exports.push(await popup.locator('.print-document').evaluate(el=>({
        text:el.textContent,font:getComputedStyle(el).fontSize,zoom:getComputedStyle(el).zoom,
        width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,
      })));
      await popup.close();
    }
    assert.deepEqual(exports[0],exports[1],'print layout is independent of body zoom');
    await zoom(150);
    for (const [language, label] of [['zh-Hans','放大正文'],['zh-Hant-TW','放大內文'],['en','Zoom In']]) {
      await page.evaluate(async language => {const {setLanguagePreference}=await import('/src/i18n.js');await setLanguagePreference(language);},language);
      assert.equal(await page.locator('#zoomIn').getAttribute('aria-label'), label);
      await page.click('#commandsButton'); await page.fill('#paletteInput', label);
      assert.equal(await page.locator('.palette-list button').count(),1);
      await page.locator('.palette-list button').click();
      assert.equal(await page.locator('#zoomLevel').innerText(), '200%');
      await zoom(150);
    }
    for (const theme of ['light','dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme=theme,theme);
      await page.setViewportSize({width:900,height:480});
      await page.click('#zoomLevel');
      const box=await page.locator('#zoomPopover').boundingBox();
      assert.ok(box.x>=8&&box.y>=8&&box.x+box.width<=892&&box.y+box.height<=472,'menu stays on screen');
      await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      assert.equal(await page.locator('#zoomLevel').innerText(),'75%');
      await page.click('#zoomLevel'); await page.keyboard.press('Escape');
      assert.equal(await page.locator('#zoomLevel').getAttribute('aria-expanded'),'false');
      await page.setViewportSize({width:540,height:480});
      const footer=await page.locator('.statusbar').evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth}));
      assert.ok(footer.scroll<=footer.width+1,'narrow footer fits');
      await page.screenshot({path:artifactPath(`body-zoom-${engine.name()}-${platform}-${theme}.png`)});
      await zoom(100);
    }
    await page.reload(); await page.click('#welcomeNewButton');
    assert.equal(await page.locator('#zoomLevel').innerText(),'100%','new window starts at 100%');
    assert.deepEqual(errors,[]);
    await page.close();
  }
  console.log(`PASS ${engine.name()} body zoom: presets, viewport, coordinates, real mouse/input, undo, highlight, IME, modes, sidebar, search, long-document anchors, languages and responsive menu`);
} finally {await browser.close();}
