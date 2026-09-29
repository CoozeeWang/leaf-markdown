import assert from 'node:assert/strict';
import { webkit } from 'playwright';
import { chromium, launchOptions } from './browser-runtime.mjs';

const browser = process.env.LEAF_IMAGE_REVEAL_ENGINE === 'webkit'
  ? await webkit.launch({ headless: true }) : await chromium.launch(launchOptions);
try {
  const page = await browser.newPage({ viewport: { width: 720, height: 480 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/image-reveal-fixture', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><body><nav class="format-toolbar"><span class="toolbar-spacer"></span></nav><section id="insertPopover"></section><div id="clipboardMenu"></div><div id="editor"></div></body>',
  }));
  await page.goto('http://127.0.0.1:41732/image-reveal-fixture');
  await page.evaluate(async () => {
    const { createLeafEditor } = await import('/src/editor.js');
    const { setupWriting } = await import('/src/writing-tools.js');
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), char => char.charCodeAt(0));
    const content = 'Intro\n\n![Local](assets/my%20photo.png)\n\n![Missing](assets/missing.png)\n\n![Remote](https://example.test/picture.png)\n';
    window.ed = createLeafEditor({ parent: document.querySelector('#editor'), doc: content });
    ed.view.dispatch({ selection: { anchor: 0 } });
    window.reveals = [];
    window.failReveal = false;
    window.failures = [];
    document.addEventListener('leaf-image-reveal-failed', event => failures.push(event.detail));
    setupWriting({ editor: ed, desktop: true, icon: () => '', status: () => {}, editable: () => true,
      toggleSource: () => {}, choose: async () => [], save: async () => true, serialized: async fn => fn(),
      invoke: async (command, args) => {
        if (command === 'read_resource') {
          if (args.relative === 'assets/missing.png') throw Error('No such file or directory');
          return [...png];
        }
        if (command === 'reveal_resource') {
          reveals.push(args);
          if (failReveal) throw Error('找不到可访问的本地图片，请检查图片文件和路径');
          return;
        }
        throw Error(`Unexpected command: ${command}`);
      },
    });
  });
  const local = page.locator('.leaf-image').filter({ has: page.locator('img[alt="Local"]') });
  const missing = page.locator('.leaf-image').filter({ has: page.locator('img[alt="Missing"]') });
  const remote = page.locator('.leaf-image').filter({ has: page.locator('img[alt="Remote"]') });
  await local.locator('img[data-loaded="yes"]').waitFor();
  await missing.locator('img[data-failure="missing"]').waitFor({ state: 'attached' });
  assert.equal(await remote.locator('.leaf-image-actions').isHidden(), true, 'remote image has no local-file action');
  const before = await page.evaluate(() => ed.getValue());

  await local.hover();
  const actionBounds = await local.getByRole('button', { name: '图片操作' }).boundingBox();
  assert.ok(actionBounds.x >= 0 && actionBounds.x + actionBounds.width <= 720, 'image action stays inside the window');
  await local.getByRole('button', { name: '图片操作' }).click();
  await page.getByRole('menuitem', { name: '在文件管理器中显示' }).click();
  assert.deepEqual(await page.evaluate(() => reveals), [{ relative: 'assets/my photo.png' }]);
  assert.equal(await page.evaluate(() => ed.getValue()), before, 'revealing does not edit Markdown');

  await local.locator('img').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '在文件管理器中显示' }).waitFor();
  assert.equal(await page.evaluate(() => ed.getValue()), before, 'right click keeps the image preview and source');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menuitem', { name: '在文件管理器中显示' }).isVisible(), false);

  await local.getByRole('button', { name: '图片操作' }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('menuitem', { name: '在文件管理器中显示' }).isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await local.getByRole('button', { name: '图片操作' }).evaluate(button => document.activeElement === button), true);

  await page.evaluate(() => { failReveal = true; });
  await missing.locator('.leaf-image-status[data-kind="missing"]').dispatchEvent('mousedown', { button: 0 });
  await page.waitForFunction(() => failures.length === 1);
  assert.deepEqual(await page.evaluate(() => reveals.at(-1)), { relative: 'assets/missing.png' });
  assert.match(await page.evaluate(() => failures[0]), /missing\.png：找不到可访问的本地图片/);
  assert.equal(await page.evaluate(() => ed.getValue()), before);

  await page.evaluate(() => {
    const end = ed.view.state.doc.length;
    ed.view.dispatch({ changes: { from: end, insert: '\n![Dropped](assets/dropped.png)\n' }, selection: { anchor: 0 } });
  });
  const dropped = page.locator('.leaf-image').filter({ has: page.locator('img[alt="Dropped"]') });
  await dropped.locator('img[data-loaded="yes"]').waitFor();
  await dropped.hover();
  await dropped.getByRole('button', { name: '图片操作' }).click();
  await page.getByRole('menuitem', { name: '在文件管理器中显示' }).click();
  assert.deepEqual(await page.evaluate(() => reveals.at(-1)), { relative: 'assets/dropped.png' }, 'newly inserted images use the same action');
  await page.emulateMedia({ media: 'print' });
  assert.equal(await dropped.getByRole('button', { name: '图片操作', includeHidden: true }).isVisible(), false, 'print hides image controls');
  assert.deepEqual(errors, []);
  console.log('PASS image reveal menu, context menu, keyboard, path, failures and source preservation');
} finally {
  await browser.close();
}
