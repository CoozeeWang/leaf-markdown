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
    assert.equal(await activeTab.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    await page.keyboard.press('ArrowLeft');

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
    console.log(`PASS ${engine}: drag then arrow keys without programmatic focus`);
  } finally { await browser.close(); }
}
