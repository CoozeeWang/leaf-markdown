import assert from 'node:assert/strict';
import { chromium, launchOptions } from './browser-runtime.mjs';

const browser = await chromium.launch(launchOptions);
async function documentPage(path) {
  const page = await browser.newPage({ viewport: { width: 720, height: 480 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(initialPath => {
    window.isTauri = true;
    window.calls = [];
    window.revealError = false;
    window.callbacks = {};
    let id = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'document-test' }, currentWebview: { label: 'document-test' } },
      transformCallback: callback => { callbacks[++id] = callback; return id; },
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === 'initial_path') return initialPath;
        if (command === 'read_document') return '# 原文\n\n测试正文';
        if (command === 'recovery_initial') return null;
        if (command === 'recovery_list') return [];
        if (command === 'recovery_retention') return 30;
        if (command === 'reveal_document' && revealError) throw '文档已不在原位置';
        if (command === 'rename_document') return initialPath.replace(/[^/]+$/, args.name);
        return null;
      },
    };
  }, path);
  await page.goto('http://127.0.0.1:41732/?document=1');
  await page.waitForFunction(() => document.querySelector('.shell')?.style.pointerEvents === '');
  return { page, errors };
}

try {
  const { page, errors } = await documentPage('/测试目录/原文.md');
  assert.equal(await page.locator('#openButton').count(), 0, 'desktop title bar has no open-file button');
  assert.equal(await page.locator('#welcomeOpenButton').count(), 1, 'welcome screen keeps its open-file button');
  const content = () => page.locator('.cm-content').evaluate(element => {
    const copy = element.cloneNode(true);
    copy.querySelector('.leaf-default-title')?.remove();
    return copy.textContent;
  });
  const original = await content();
  await page.click('#documentMenuButton');
  assert.deepEqual(await page.locator('#documentPopover [role="menuitem"]').allTextContents(),
    ['在文件管理器中显示', '重命名…', '历史版本与草稿…']);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'documentReveal');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'documentRename');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'documentHistory');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'documentMenuButton');

  await page.click('#documentMenuButton');
  await page.click('#documentReveal');
  await page.waitForFunction(() => calls.some(call => call.command === 'reveal_document'));
  assert.equal(await content(), original, 'showing the file does not edit the document');

  await page.click('#documentMenuButton');
  await page.click('#documentRename');
  await page.locator('.inline-rename').fill('新名字');
  await page.locator('.inline-rename').press('Enter');
  await page.waitForFunction(() => document.querySelector('#fileName')?.textContent === '新名字.md');
  assert.deepEqual(await page.evaluate(() => calls.filter(call => call.command === 'rename_document').map(call => call.args.name)), ['新名字.md']);
  assert.equal(await content(), original, 'renaming preserves document content');

  await page.click('#readingToggle');
  await page.locator('[data-mode="source"]').click();
  await page.click('#documentMenuButton');
  await page.click('#documentRename');
  await page.locator('.inline-rename').fill('源码视图');
  await page.locator('.inline-rename').press('Enter');
  await page.waitForFunction(() => document.querySelector('#fileName')?.textContent === '源码视图.md');
  assert.equal(await page.evaluate(() => calls.filter(call => call.command === 'rename_document').at(-1).args.name), '源码视图.md');
  await page.click('#readingToggle');
  await page.locator('[data-mode="edit"]').click();
  assert.equal(await content(), original, 'renaming from source view preserves document content');

  await page.click('#documentMenuButton');
  await page.click('#documentHistory');
  await page.getByRole('dialog', { name: '历史版本与草稿' }).waitFor();
  assert.ok(await page.evaluate(() => calls.some(call => call.command === 'recovery_list' && call.args.drafts === false)));
  assert.equal(await content(), original, 'opening history does not restore anything');
  await page.keyboard.press('Escape');

  await page.evaluate(() => { revealError = true; });
  await page.click('#documentMenuButton');
  await page.click('#documentReveal');
  await page.getByText('无法在文件管理器中显示：文档已不在原位置').waitFor();
  assert.equal(await content(), original);
  assert.deepEqual(errors, []);
  await page.close();

  const { page: unsaved, errors: unsavedErrors } = await documentPage(null);
  await unsaved.click('#documentMenuButton');
  assert.equal(await unsaved.locator('#documentReveal').isDisabled(), true);
  assert.equal(await unsaved.locator('#documentRename').isDisabled(), true);
  assert.equal(await unsaved.evaluate(() => document.activeElement.id), 'documentHistory');
  await unsaved.keyboard.press('ArrowDown');
  assert.equal(await unsaved.evaluate(() => document.activeElement.id), 'documentHistory');
  assert.equal(await unsaved.evaluate(() => calls.some(call => call.command === 'reveal_document')), false);
  assert.deepEqual(unsavedErrors, []);
  console.log('PASS desktop document actions, keyboard navigation, unsaved state, rename preservation, history and reveal errors');
} finally { await browser.close(); }
