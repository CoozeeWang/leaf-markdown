import {chromium, launchOptions} from './browser-runtime.mjs';
import {webkit} from 'playwright';
import assert from 'node:assert/strict';

const browser = await (process.env.LEAF_TEST_ENGINE === 'webkit'
  ? webkit.launch({headless:true})
  : chromium.launch(launchOptions));
try {
  const page = await browser.newPage({viewport:{width:1100,height:800}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:41732');
  await page.click('#welcomeNewButton');
  const source = '# 长文档\n\n' + Array.from({length:90}, (_, index) =>
    `段落 ${String(index).padStart(2, '0')} ${'可见内容用于切换视图。'.repeat(7)}`
  ).join('\n\n');
  await page.evaluate(async value => {
    const {EditorView} = await import('/node_modules/@codemirror/view/dist/index.js');
    window.issue41View = EditorView.findFromDOM(document.querySelector('.cm-content'));
    issue41View.dispatch({changes:{from:0,to:issue41View.state.doc.length,insert:value},selection:{anchor:0}});
  }, source);

  const mode = () => page.locator('#readingToggle').getAttribute('aria-label');
  const switchTo = async target => {
    await page.click('#readingToggle');
    await page.locator(`.mode-popover [data-mode="${target}"]`).click();
    await page.waitForFunction(expected => document.querySelector('#readingToggle').getAttribute('aria-label') === `视图模式：${expected}`, {edit:'编辑',reading:'阅读',source:'源码'}[target]);
    await page.waitForTimeout(100);
  };
  const visibleParagraph = () => page.evaluate(() => {
    const pane = document.querySelector('#readingPane');
    if (!pane.hidden) {
      const y = pane.getBoundingClientRect().top + 40;
      const blocks = [...pane.querySelectorAll('p[data-source-from]')];
      const block = blocks.find(element => element.getBoundingClientRect().bottom > y);
      return Number(/段落 (\d+)/.exec(block?.textContent ?? '')?.[1]);
    }
    const view = window.issue41View, rect = view.scrollDOM.getBoundingClientRect();
    const position = view.posAtCoords({x:rect.left + 100,y:rect.top + 40});
    const line = view.state.doc.lineAt(position);
    const text = line.text || (line.number < view.state.doc.lines ? view.state.doc.line(line.number + 1).text : '');
    return Number(/段落 (\d+)/.exec(text)?.[1]);
  });
  const placeAt = async (target, index) => {
    if (target === 'reading') {
      await page.evaluate(value => {
        const pane = document.querySelector('#readingPane');
        const block = [...pane.querySelectorAll('p[data-source-from]')][value];
        pane.scrollTop += block.getBoundingClientRect().top - pane.getBoundingClientRect().top - 40;
      }, index);
    } else {
      await page.evaluate(value => {
        const view = window.issue41View;
        const position = view.state.doc.toString().indexOf(`段落 ${String(value).padStart(2, '0')}`);
        view.scrollDOM.scrollTop = view.lineBlockAt(position).top - 40;
      }, index);
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.waitForTimeout(50);
        await page.evaluate(value => {
          const view = window.issue41View;
          const position = view.state.doc.toString().indexOf(`段落 ${String(value).padStart(2, '0')}`);
          const coords = view.coordsAtPos(position), rect = view.scrollDOM.getBoundingClientRect();
          if (coords) view.scrollDOM.scrollTop += coords.top - rect.top - 40;
        }, index);
      }
    }
    await page.waitForTimeout(100);
    const actual = await visibleParagraph();
    const debug = await page.evaluate(value => {
      const view = window.issue41View, rect = view.scrollDOM.getBoundingClientRect();
      const position = view.posAtCoords({x:rect.left + 100,y:rect.top + 40});
      const target=view.state.doc.toString().indexOf(`段落 ${String(value).padStart(2, '0')}`);
      return {position, line:view.state.doc.lineAt(position).number, text:view.state.doc.lineAt(position).text.slice(0,50), scroll:view.scrollDOM.scrollTop, height:view.scrollDOM.scrollHeight, client:view.scrollDOM.clientHeight, target, targetCoords:view.coordsAtPos(target)?.top, targetBlock:view.lineBlockAt(target).top};
    }, index);
    assert.ok(Math.abs(actual - index) <= 1, `${target} setup at ${index}, saw ${actual}: ${JSON.stringify(debug)}`);
  };

  for (const [from, to] of [['edit','reading'],['reading','edit'],['edit','source'],['source','edit'],['reading','source'],['source','reading']]) {
    const current = (await mode()).replace('视图模式：', '');
    if (current !== {edit:'编辑',reading:'阅读',source:'源码'}[from]) await switchTo(from);
    await placeAt(from, to === 'source' ? 76 : 42);
    const before = await visibleParagraph();
    await switchTo(to);
    await page.waitForTimeout(100);
    const after = await visibleParagraph();
    assert.ok(Math.abs(after - before) <= 1, `${from} → ${to}: ${before} → ${after}`);
  }

  await switchTo('edit');
  await placeAt('edit', 65);
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.keyboard.press('ControlOrMeta+r');
    await page.keyboard.press('ControlOrMeta+r');
    await page.keyboard.press('ControlOrMeta+r');
    await page.waitForTimeout(100);
    assert.ok(Math.abs(await visibleParagraph() - 65) <= 1, `round trip ${cycle}`);
  }
  assert.equal(await page.evaluate(() => issue41View.state.doc.toString()), source);
  assert.equal(await page.evaluate(() => issue41View.state.selection.main.head), 0);
  assert.deepEqual(errors, []);
  console.log('PASS visible content across six mode changes and repeated keyboard cycles with caret elsewhere');
} finally {
  await browser.close();
}
