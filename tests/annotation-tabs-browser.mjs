import assert from 'node:assert/strict';
import {chromium, webkit} from 'playwright';
import {mkdirSync} from 'node:fs';

const base = process.env.LEAF_TEST_BASE_URL || 'http://127.0.0.1:41732';
const source = '# Sidebar sample\n\nText {==range==}{>>Comment sample<<} and note[^one].\n\n[^one]: Footnote sample.';
const labels = {'zh-Hans': ['批注', '脚注'], 'zh-Hant-TW': ['批註', '註腳'], en: ['Comments', 'Footnotes']};
mkdirSync('test-results', {recursive: true});

for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1200, height: 800}, locale: 'zh-CN'});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.click('#welcomeNewButton');
    await page.evaluate(async source => {
      const {EditorView} = await import('/node_modules/@codemirror/view/dist/index.js');
      window.v = EditorView.findFromDOM(document.querySelector('#editor .cm-content'));
      v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: source}});
    }, source);
    await page.click('#commentsButton');
    const snapshot = () => page.evaluate(async () => {
      const {undoDepth, redoDepth} = await import('/node_modules/@codemirror/commands/dist/index.js');
      return {source: v.state.doc.toString(), undo: undoDepth(v.state), redo: redoDepth(v.state)};
    });
    const before = await snapshot();
    const tabs = ['#commentsTab', '#notesTab'];
    const geometry = async () => page.locator('#notesDrawer .drawer-header').evaluate(header => {
      const rect = el => { const r = el.getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom}; };
      return {
        header: rect(header), collapse: rect(header.querySelector('[data-close]')),
        tabs: [...header.querySelectorAll('[role=tab]')].map(button => ({
          ...rect(button), contents: [...button.children].filter(el => getComputedStyle(el).display !== 'none').map(rect),
          font: parseFloat(getComputedStyle(button).fontSize),
        })),
      };
    });
    const checkLayout = async context => {
      await page.evaluate(() => document.fonts.ready);
      const g = await geometry();
      const description = JSON.stringify({context, g});
      assert.ok(g.tabs[0].right <= g.tabs[1].left + 0.5, description);
      assert.ok(g.tabs[1].right <= g.collapse.left + 0.5, description);
      assert.ok(g.collapse.right <= g.header.right + 0.5, description);
      for (const tab of g.tabs) {
        assert.ok(tab.left >= g.header.left && tab.font >= 12, description);
        for (const content of tab.contents) assert.ok(content.left >= tab.left - 0.5 && content.right <= tab.right + 0.5 && content.top >= tab.top && content.bottom <= tab.bottom, description);
      }
    };
    for (const language of Object.keys(labels)) {
      await page.evaluate(async language => (await import('/src/i18n.js')).setLanguagePreference(language), language);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        for (const width of [1200, 700]) {
          await page.setViewportSize({width, height:800});
          for (const size of ['default', 'minimum']) {
            if (size === 'default') await page.locator('.notes-resizer').dblclick();
            else await page.locator('.notes-resizer').press('Home');
            for (const [i, tab] of tabs.entries()) {
              await page.click(tab);
              const other = tabs[1-i];
              assert.equal(await page.locator(tab).getAttribute('aria-selected'), 'true');
              assert.equal(await page.locator(tab + ' .annotation-tab-label').innerText(), labels[language][i]);
              assert.ok(await page.locator(tab + ' .annotation-tab-label').isVisible());
              assert.equal(await page.locator(tab + ' .annotation-tab-icon').isVisible(), false);
              assert.ok(await page.locator(other + ' .annotation-tab-icon svg').isVisible());
              assert.equal(await page.locator(other + ' .annotation-tab-label').isVisible(), false);
              assert.equal(await page.locator(other).getAttribute('aria-label'), labels[language][1-i]);
              assert.equal(await page.locator(other).getAttribute('data-tooltip'), labels[language][1-i]);
              assert.equal(await page.locator(other).getAttribute('tabindex'), '-1');
              for (const id of ['#commentsCount', '#notesCount']) {
                assert.equal(await page.locator(id).innerText(), '1');
                assert.equal(await page.locator(id).evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
              }
              await checkLayout({language, theme, width, size, tab});
            }
          }
        }
      }
    }
    // Stress real rendered badges with a three-digit count at the minimum width.
    await page.evaluate(async () => {
      const source = Array.from({length:123}, (_,i) => `Text {>>Comment ${i}<<}[^n${i}]`).join('\n\n') + '\n\n' + Array.from({length:123}, (_,i) => `[^n${i}]: Note ${i}`).join('\n\n');
      v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source}});
      await (await import('/src/i18n.js')).setLanguagePreference('en');
    });
    for (const tab of tabs) {
      await page.click(tab);
      for (const id of ['#commentsCount', '#notesCount']) assert.equal(await page.locator(id).innerText(), '123');
      await checkLayout({counts:123, tab});
    }
    // Keyboard selection/focus, including Home/End when already at that edge.
    for (const [key, target] of [['Home', tabs[0]], ['Home', tabs[0]], ['End', tabs[1]], ['End', tabs[1]], ['ArrowRight', tabs[0]], ['ArrowLeft', tabs[1]]]) {
      await page.locator('.annotation-tabs [aria-selected=true]').press(key);
      assert.equal(await page.locator(target).getAttribute('aria-selected'), 'true');
      assert.ok(await page.locator(target).evaluate(el => el === document.activeElement));
      assert.ok(await page.locator(target).evaluate(el => getComputedStyle(el).outlineStyle !== 'none'));
    }
    await page.locator('.annotation-tabs [aria-selected=true]').press('Tab');
    // Safari's system keyboard-navigation preference may skip native buttons.
    // Tab must leave this single-stop tablist, regardless of the next OS target.
    assert.ok(await page.locator('.annotation-tabs').evaluate(el => !el.contains(document.activeElement)));
    await page.evaluate(source => v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source}}), source);
    const restored = await snapshot();
    for (const tab of tabs) await page.click(tab);
    assert.deepEqual(await snapshot(), restored, 'tab switching preserves source and both history depths');
    assert.equal(before.source, source);
    await page.screenshot({path:`test-results/annotation-tabs-${engine.name()}.png`});
    assert.deepEqual(errors, []);
    console.log(`PASS annotation tabs ${engine.name()}: three languages, two themes, default/minimum widths, narrow windows, counts, keyboard and history`);
  } finally { await browser.close(); }
}
