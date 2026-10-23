import {chromium, webkit} from 'playwright';
import assert from 'node:assert/strict';
import {launchOptions, artifactPath} from './browser-runtime.mjs';

const headings = ['# 一级中文标题', '## English section', '###   多空格标题', '####\tTabbed heading',
  '##### 中文五级标题', '###### English level six', '## Closing hashes ###', '## **加粗标题**',
  '## ' + 'Long synthetic heading 自动换行标题 '.repeat(12)];
const source = Array.from({length:20}, (_,i) => `Synthetic introduction ${i}.\n`).join('\n')
  + '\n' + headings.map(text => text + '\n\nSynthetic body.\n').join('\n')
  + '\n' + 'Following synthetic paragraph.\n\n'.repeat(20);
const targets = headings.map(text => ({text, line: source.slice(0,source.indexOf(text)).split('\n').length,
  at: source.indexOf(text) + text.match(/^#+[ \t]+/)[0].length}));

for (const [engineName, engine] of Object.entries({chromium, webkit})) {
  const browser = await engine.launch(engineName === 'chromium' ? launchOptions : {headless:true});
  try {
    for (const locale of ['zh-CN','en-US']) {
      const page = await browser.newPage({locale, viewport:{width:1100,height:800}}), errors=[];
      page.on('pageerror',error => errors.push(error.message));
      await page.goto('http://127.0.0.1:41732');
      await page.waitForSelector('.shell[data-body-fonts=ready]');
      await page.click('#welcomeNewButton');
      await page.evaluate(async source => {
        const {EditorView} = await import('/node_modules/@codemirror/view/dist/index.js');
        const {undoDepth} = await import('/node_modules/@codemirror/commands/dist/index.js');
        window.v = EditorView.findFromDOM(document.querySelector('.cm-content'));
        window.depth = () => undoDepth(v.state);
        v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source},selection:{anchor:0}});
      },source);
      await page.click('#outlineButton');
      assert.equal(await page.locator('.outline-item').count(),headings.length);
      const settle = () => page.evaluate(() => new Promise(resolve => v.requestMeasure({read:()=>null,write:()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))})));
      const read = () => page.evaluate(() => ({source:v.state.doc.toString(),head:v.state.selection.main.head,
        anchor:v.state.selection.main.anchor,depth:depth(),focused:v.hasFocus}));
      const mode = async name => {
        await page.click('#readingToggle'); await page.click(`.mode-popover [data-mode="${name}"]`);
        if(name !== 'reading') await page.waitForFunction(name => v.dom.classList.contains('cm-source-mode') === (name === 'source'),name);
      };
      for (const viewMode of ['edit','source']) {
        await mode(viewMode);
        const before = await read();
        for (const target of targets) for (const activation of ['click','Enter','Space']) {
          const button = page.locator(`.outline-item[data-line="${target.line}"]`);
          if(activation === 'click') await button.click();
          else {await button.focus();await button.press(activation);}
          const actual = await read();
          assert.equal(actual.head,target.at,`${engineName}/${locale}/${viewMode}/${activation}: ${target.text}`);
          assert.equal(actual.anchor,target.at,'navigation collapses selection');
          assert.ok(actual.focused,'editor receives focus');
          assert.equal(actual.source,source,'navigation preserves Markdown');
          assert.equal(actual.depth,before.depth,'navigation adds no undo entry');
          await page.waitForFunction(at => {
            const r=v.coordsAtPos(at),box=v.scrollDOM.getBoundingClientRect();
            return r && r.top>=box.top-1 && r.bottom<=box.bottom+1;
          },target.at);
          await settle();
          const caret = await page.evaluate(at => {const expected=v.coordsAtPos(at),actual=v.dom.querySelector('.cm-cursor').getBoundingClientRect();return {dx:actual.left-expected.left,dy:actual.top-expected.top};},target.at);
          assert.ok(Math.abs(caret.dx)<1 && Math.abs(caret.dy)<1,`visible caret follows heading content: ${JSON.stringify(caret)}`);
        }
        // A real next input starts the title content and leaves its prefix intact.
        for (const target of [targets[2],targets.at(-1)]) {
          await page.locator(`.outline-item[data-line="${target.line}"]`).click();
          await page.keyboard.insertText('新增');
          assert.equal((await read()).source,source.slice(0,target.at)+'新增'+source.slice(target.at));
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
          assert.equal((await read()).source,source,'one undo restores input');
        }
        // Heading-link navigation still uses the generic line-start behavior.
        await page.evaluate(line => document.dispatchEvent(new CustomEvent('leaf-heading-link',{detail:line})),targets[1].line);
        assert.equal((await read()).head,source.indexOf(headings[1]));
      }
      await mode('reading');
      const beforeReading = await read();
      await page.locator(`.outline-item[data-line="${targets[0].line}"]`).click();
      await page.waitForFunction(line => {
        const r=document.querySelector(`.reading-document [data-source-line="${line}"]`).getBoundingClientRect();
        const pane=document.querySelector('#readingPane').getBoundingClientRect();
        return r.top>=pane.top-1 && r.top<pane.bottom;
      },targets[0].line);
      const afterReading=await read();
      assert.equal(afterReading.head,beforeReading.head,'reading navigation leaves editor selection alone');
      assert.equal(afterReading.source,source);
      assert.equal(afterReading.depth,beforeReading.depth);
      await mode('edit');
      const first = page.locator(`.outline-item[data-line="${targets[0].line}"]`);
      await first.dblclick();
      const rename = page.locator('.outline-rename');
      await rename.fill('Cancelled title');await rename.press('Escape');
      assert.equal((await read()).source,source,'double-click rename cancellation');
      await first.dblclick();await rename.fill('Renamed 合成标题');await rename.press('Enter');
      assert.equal((await read()).source,source.replace(headings[0],'# Renamed 合成标题'));
      await page.evaluate(() => v.focus());
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
      assert.equal((await read()).source,source,'rename shares document undo');
      await page.locator(`.outline-item[data-line="${targets[2].line}"]`).click();
      await settle();
      await page.screenshot({path:artifactPath(`outline-navigation-${engineName}-${locale}.png`)});
      assert.deepEqual(errors,[]);
      console.log(`PASS ${engineName}/${locale}: H1–H6, spaces/tabs, formatted/wrapped titles, mouse/keyboard, edit/source/read, typing, history, generic line navigation and rename`);
      await page.close();
    }
  } finally {await browser.close();}
}
