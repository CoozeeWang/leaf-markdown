import assert from 'node:assert/strict';
import {chromium, launchOptions, artifactPath} from './browser-runtime.mjs';

const browser = await chromium.launch(launchOptions);
try {
  const page = await browser.newPage({viewport: {width: 720, height: 480}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await page.goto('http://127.0.0.1:41732/');
  await page.locator('#welcomeNewButton').waitFor();
  const close = page.getByRole('button', {name: '关闭提示', exact: true});
  const notice = page.locator('#statusNotice');
  const status = page.locator('#saveStatus');
  const fail = () => page.evaluate(() => document.dispatchEvent(new CustomEvent('leaf-image-reveal-failed', {
    detail: '读取失败，请重试。' + '/很长的文件夹路径'.repeat(100),
  })));
  // Failed opens remain readable even while the welcome screen is shown.
  await fail();
  assert.ok(await close.isVisible());
  await close.click();
  assert.ok(await notice.isHidden());
  assert.equal(await page.evaluate(() => document.activeElement.id), 'welcomeOpenButton');
  await page.locator('#welcomeNewButton').click();
  assert.match(await status.innerText(), /选择保存位置/);
  await page.locator('#tidyBlankLines').click();
  assert.match(await status.innerText(), /无需整理/);
  await page.clock.runFor(4000);
  assert.match(await status.innerText(), /选择保存位置/, 'a temporary action must not erase a save requirement');
  await close.click();
  assert.ok(await notice.isHidden());
  assert.equal(await page.evaluate(() => document.activeElement.id), 'saveButton');
  await fail();
  await page.clock.runFor(10000);
  assert.match(await status.innerText(), /读取失败/);
  await page.locator('#tidyBlankLines').click();
  assert.match(await status.innerText(), /读取失败/);
  for (const width of [720, 1000]) {
    await page.setViewportSize({width, height: 480});
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      const bounds = await page.evaluate(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return {message: box('#statusNotice'), close: box('#dismissStatus'), text: box('#saveStatus'), editor: box('.document-area'), toolbar: box('.format-toolbar'), scroll: document.documentElement.scrollWidth};
      });
      assert.ok(bounds.message.top >= bounds.toolbar.bottom - 1, 'message must stay below the toolbar');
      assert.ok(bounds.message.bottom <= bounds.editor.top + 1, 'message must stay above the document');
      assert.ok(bounds.close.right <= width && bounds.close.bottom <= 480, 'close must stay within the window');
      assert.ok(bounds.text.right <= bounds.close.left && bounds.text.height <= 120, 'long text must scroll beside a fixed close button');
      assert.ok(bounds.scroll <= width, 'long messages must not widen the page');
      await page.screenshot({path: artifactPath(`status-notices-${width}-${theme}.png`)});
    }
  }
  await page.locator('#focusButton').click();
  assert.ok(await close.isVisible(), 'focus mode must retain error dismissal');
  await close.click();
  assert.ok(await notice.isHidden());
  assert.ok(await page.locator('.cm-content').evaluate(el => el === document.activeElement), 'focus-mode dismissal returns to the editor');
  await page.keyboard.press('Escape');
  await page.locator('#readingToggle').click();
  await page.locator('.mode-popover [data-mode=reading]').click();
  await fail();
  assert.ok(await close.isVisible(), 'reading mode must retain error dismissal');
  await close.click();
  assert.ok(await notice.isHidden());
  assert.deepEqual(errors, []);
  console.log('PASS single top message, manual fallback, long errors, narrow/dark, welcome, focus and reading dismissal');
} finally { await browser.close(); }
