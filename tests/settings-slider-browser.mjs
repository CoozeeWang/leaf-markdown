import assert from 'node:assert/strict';
import { chromium, launchOptions } from './browser-runtime.mjs';
import { webkit } from 'playwright';
for (const engine of ['chrome', 'webkit']) {
  const browser = await (engine === 'webkit' ? webkit.launch({headless:true}) : chromium.launch(launchOptions));
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:41732');
    await page.click('#welcomeNewButton');
    await page.click('#appearanceButton');
    const activeTab = page.locator('.settings-tabs [aria-selected="true"]');
    assert.equal(await activeTab.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    await page.keyboard.press('ArrowRight');
    assert.equal(await activeTab.getAttribute('id'), 'settingsTab-recovery');
    assert.equal(await activeTab.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
    assert.equal(await activeTab.evaluate(el => getComputedStyle(el).outlineWidth), '1px');
    for (const theme of ['dark','light']) {
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      assert.equal(await activeTab.evaluate(el => getComputedStyle(el).outlineColor),theme==='dark'?'rgb(155, 188, 160)':'rgb(96, 123, 104)');
    }
    await page.locator('#appearancePopover').focus();
    assert.equal(await activeTab.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    assert.equal(await activeTab.getAttribute('aria-selected'), 'true');
    await activeTab.focus();
    await page.keyboard.press('ArrowLeft');
    const checkTab = async tab => {
      assert.equal(await activeTab.getAttribute('id'), `settingsTab-${tab}`);
      assert.equal(await page.evaluate(() => document.activeElement.id), `settingsTab-${tab}`);
      assert.ok(await page.locator(`#settingsPanel-${tab}`).isVisible());
      for (const other of ['appearance','recovery','ai'].filter(other => other !== tab)) {
        assert.ok(await page.locator(`#settingsPanel-${other}`).isHidden());
        assert.equal(await page.locator(`#settingsTab-${other}`).getAttribute('tabindex'), '-1');
      }
    };
    await checkTab('appearance');
    for (const language of ['zh-Hans', 'zh-Hant-TW', 'en']) {
      await page.click('#editorLanguageSelect');
      await page.click(`#languagePopover [data-language=\"${language}\"]`);
      await page.click('#appearanceButton');
      await page.waitForFunction(language => document.documentElement.lang === language, language);
      await page.click('#settingsTab-appearance');
      for (const [key, tab] of [
        ['ArrowLeft', 'ai'], ['ArrowLeft', 'recovery'], ['ArrowLeft', 'appearance'],
        ['ArrowRight', 'recovery'], ['ArrowRight', 'ai'], ['ArrowRight', 'appearance'],
        ['End', 'ai'], ['Home', 'appearance'],
      ]) {
        await page.keyboard.press(key);
        await checkTab(tab);
      }
      await page.click('#settingsTab-recovery');
      await checkTab('recovery');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'appearanceButton');
      await page.click('#appearanceButton');
      await checkTab('recovery');
      await page.keyboard.press('ArrowLeft');
      await checkTab('appearance');
    }

    for (const [id, output] of [['fontSizeInput','fontSizeValue'], ['contentWidthInput','contentWidthValue']]) {
      const slider = page.locator('#' + id), rect = await slider.boundingBox();
      await page.mouse.move(rect.x + rect.width * .4, rect.y + rect.height / 2);
      await page.mouse.down();
      await page.mouse.move(rect.x + rect.width * .6, rect.y + rect.height / 2, {steps:5});
      await page.mouse.up();
      assert.equal(await page.evaluate(() => document.activeElement.id), id);
      const start = Number(await slider.inputValue()), step = Number(await slider.getAttribute('step'));
      await page.keyboard.press('ArrowRight');
      assert.equal(Number(await slider.inputValue()), start + step);
      assert.equal(await slider.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
      assert.equal(await page.locator('#' + output).textContent(), (start + step) + 'px');
      await page.keyboard.press('ArrowLeft');
      assert.equal(Number(await slider.inputValue()), start);
    }
    await page.locator('#themeSelect').focus();
    assert.equal(await page.locator('#themeSelect').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    console.log(`PASS ${engine}: trilingual tab arrows/wrap/Home/End, panel/focus sync, mouse/reopen and slider drag then arrow keys`);
  } finally { await browser.close(); }
}
