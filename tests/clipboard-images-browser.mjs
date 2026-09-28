import { chromium, launchOptions } from './browser-runtime.mjs';
import { webkit } from 'playwright';
import { desktopImageFixture } from './fixtures/desktop-image.mjs';
import assert from 'node:assert/strict';

for (const engine of [chromium, webkit]) {
const browser = await engine.launch(engine === chromium ? launchOptions : { headless: true });
try {
  const source = await browser.newPage();
  await desktopImageFixture(source, 'Before\n\n![图](source.assets/photo.png)\n\nAfter');
  const copied = await source.evaluate(() => {
    const text = v.state.doc.toString();
    const from = text.indexOf('!['), to = text.indexOf('\n\nAfter');
    v.dispatch({ selection: { anchor: from, head: to } });
    v.focus();
    const data = new DataTransfer();
    v.contentDOM.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return { plain: data.getData('text/plain'), meta: data.getData('application/x-leaf-markdown-images') };
  });
  assert.equal(copied.plain, '![图](source.assets/photo.png)');
  assert.ok(JSON.parse(copied.meta).sourceLabel);
  const ordinary = await source.evaluate(() => {
    v.dispatch({ selection: { anchor: 0, head: 6 } }); v.focus();
    const data = new DataTransfer();
    v.contentDOM.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return { plain: data.getData('text/plain'), meta: data.getData('application/x-leaf-markdown-images') };
  });
  assert.deepEqual(ordinary, { plain: 'Before', meta: '' });

  const target = await browser.newPage();
  await desktopImageFixture(target, '# Target\n\n');
  await target.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'copy_pasted_images') {
        window.copyArgs = args;
        if (window.rejectImageCopy) throw '图片无法读取';
        return [['source.assets/photo.png', 'target.assets/photo-1.png']];
      }
      return original(command, args);
    };
  });
  await target.evaluate(({ plain, meta }) => {
    v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus();
    const data = new DataTransfer();
    data.setData('text/plain', plain); data.setData('application/x-leaf-markdown-images', meta);
    v.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, copied);
  await target.waitForFunction(() => v.state.doc.toString().includes('target.assets/photo-1.png'));
  assert.deepEqual(await target.evaluate(() => copyArgs.references), ['source.assets/photo.png']);
  assert.equal(await target.evaluate(() => v.state.doc.toString()), '# Target\n\n![图](target.assets/photo-1.png)');
  await target.click('#undoButton');
  assert.equal(await target.evaluate(() => v.state.doc.toString()), '# Target\n\n');
  await target.evaluate(({ plain, meta }) => {
    window.rejectImageCopy = true;
    v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus();
    const data = new DataTransfer();
    data.setData('text/plain', plain); data.setData('application/x-leaf-markdown-images', meta);
    v.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, copied);
  await target.waitForFunction(() => document.querySelector('#saveStatus')?.textContent.includes('粘贴图片失败'));
  assert.equal(await target.evaluate(() => v.state.doc.toString()), '# Target\n\n');
  console.log(`PASS ${engine.name()}: cross-document image copy, rewritten paste, undo and failed-copy protection`);
} finally { await browser.close(); }
}
