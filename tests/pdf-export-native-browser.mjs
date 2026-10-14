import assert from 'node:assert/strict';
import { chromium, launchOptions } from './browser-runtime.mjs';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch(launchOptions);
try {
  await mkdir('tmp/pdfs', { recursive: true });
  for (const platform of ['Win32', 'MacIntel']) {
    const page = await browser.newPage();
    await page.addInitScript(platform => {
      Object.defineProperty(navigator, 'platform', { value: platform });
      window.isTauri = true;
      window.printCalls = 0;
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'export-test' }, currentWebview: { label: 'export-test' } },
        transformCallback: () => 1,
        invoke: async command => {
          if (command === 'language_get') return { preference: 'system', language: 'zh-Hans', revision: 0 };
          if (command === 'export_snapshot') return { name: '中文標題-é-😀.md', source: '# 中文标题\n\n' + 'Pagination text.\n\n'.repeat(120) + 'FINAL-CONTENT-END', numbered: false };
          if (command === 'print_export') {
            printCalls++;
            return new Promise((resolve, reject) => { window.finishPrint = resolve; window.failPrint = reject; });
          }
          return null;
        },
      };
    }, platform);
    await page.goto('http://127.0.0.1:41732/?export=1');
    await page.locator('article h1').waitFor();
    assert.equal(await page.title(), '中文標題-é-😀');
    const zeroMargin = await page.locator('head style').evaluateAll(styles => styles.some(s => s.textContent.includes('@page { margin: 0; }')));
    assert.equal(zeroMargin, platform === 'MacIntel', 'Windows PDF must retain A4/18mm CSS margins; Mac keeps its native margins');
    await page.click('#print');
    await page.waitForFunction(() => printCalls === 1);
    await page.click('#print');
    assert.equal(await page.evaluate(() => printCalls), 1, 'No duplicate export while Save/render is pending');
    await page.evaluate(() => finishPrint()); // A canceled save resolves without error.
    await page.waitForTimeout(30);
    assert.equal(await page.locator('#export-error').innerText(), '');
    await page.click('#print');
    await page.waitForFunction(() => printCalls === 2);
    await page.evaluate(() => failPrint('fixture-save-failed'));
    await page.waitForFunction(() => document.querySelector('#export-error').textContent.includes('fixture-save-failed'));
    await page.keyboard.press(platform === 'Win32' ? 'Control+p' : 'Meta+p');
    await page.waitForFunction(() => printCalls === 3);
    await page.evaluate(() => finishPrint());
    if (platform === 'Win32') {
      await page.pdf({ path: 'tmp/pdfs/windows-unicode-title.pdf', printBackground: true, preferCSSPageSize: true });
    }
    await page.close();
  }
  console.log('PASS: Windows/Mac native preview margins, Unicode title, duplicate guard, cancellation, error and retry');
} finally { await browser.close(); }
