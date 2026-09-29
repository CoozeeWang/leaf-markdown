import { chromium, launchOptions } from './browser-runtime.mjs';
import assert from 'node:assert/strict';

const browser = await chromium.launch(launchOptions);
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/moved-image-fixture', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><body><main id="fixture"></main></body>',
  }));
  await page.goto('http://127.0.0.1:41732/moved-image-fixture');
  await page.evaluate(async () => {
    window.resources = await import('/src/resources.js');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    window.bytes = Array.from(atob(png), character => character.charCodeAt(0));
    resources.setResourceReader(async () => bytes);
    document.querySelector('#fixture').append(resources.imageNode('photo', 'assets/photo.png'));
  });
  await page.locator('img[data-loaded="yes"]').waitFor();
  assert.deepEqual(await page.evaluate(() => resources.loadedLocalImagePaths()), ['assets/photo.png']);

  await page.evaluate(() => {
    resources.setResourceReader(async () => { throw Error('No such file or directory (os error 2)'); });
    resources.setMovedMissingImages(['assets/photo.png']);
    resources.refreshImages();
  });
  await page.locator('.leaf-image-status[data-kind="moved-missing"]').waitFor();
  assert.equal(await page.locator('.leaf-image-status-head').textContent(), '找不到图片：photo.png');
  assert.equal(await page.locator('.leaf-image-status-note').textContent(), '文档已移动，图片仍在原文件夹。请将图片也移到新位置。');

  await page.evaluate(() => { resources.setMovedMissingImages(); resources.refreshImages(); });
  await page.locator('.leaf-image-status[data-kind="missing"]').waitFor();
  assert.equal(await page.locator('.leaf-image-status-note').textContent(), '文件可能已被移动、重命名或删除');

  await page.evaluate(() => {
    window.imageAvailable = false;
    resources.setResourceReader(async () => {
      if (!imageAvailable) throw Error('No such file or directory (os error 2)');
      return bytes;
    });
  });
  await page.locator('.leaf-image-status[data-kind="missing"]').waitFor();
  await page.evaluate(() => { window.imageAvailable = true; resources.retryMissingImages(); });
  await page.locator('img[data-loaded="yes"]').waitFor();
  await page.evaluate(() => { resources.setResourceReader(async () => { throw Error('No such file or directory (os error 2)'); }); });
  await page.locator('.leaf-image-status[data-kind="missing"]').waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS moved-image notice only follows confirmed prior loading and clears for generic failures');
} finally {
  await browser.close();
}
