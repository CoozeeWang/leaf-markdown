import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser = await chromium.launch(launchOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1050, height: 820 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/recovery-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/src/style.css"></head><body></body></html>' }));
  await page.goto('http://127.0.0.1:41732/recovery-fixture');
  const original = '# 当前文档\n\n最新修改[^Test]。\n\n[^Test]: 保留文字标签\n';
  const historical = '# 历史版本\r\n\r\n旧编号[^8] 和重复引用[^8]\r\n\r\n[^8]: 不应自动重排\r\n\r\n<script>window.pwned=true</script>';
  await page.evaluate(async ({ original, historical }) => {
    const { createLeafEditor } = await import('/src/editor.js');
    const { createDocumentSession } = await import('/src/document-session.js');
    const { showRecovery } = await import('/src/recovery-dialog.js');
    document.body.replaceChildren();
    const host = document.createElement('div'); host.style.height = '700px'; document.body.append(host);
    window.ed = createLeafEditor({ parent: host, doc: original });
    window.writes = []; window.checkpoints = []; window.clears = [];
    window.session = createDocumentSession({
      content: () => ed.getValue(), load: content => ed.setValue(content), status: () => {},
      checkpoint: async (content, preserve) => checkpoints.push({ content, preserve }),
      restore: content => ed.restoreValue(content), write: async (...args) => writes.push(args), saved: () => {},
    });
    await session.initialize('/file.md', original);
    const entries = [ { key: 'file', id: 'old', timestamp: 1, kind: 'saved', source: '/中文/file.md', bytes: historical.length } ];
    window.openRecovery = () => showRecovery({ restore: content => session.restore(content), invoke: async (command, args) => {
      if (command === 'recovery_list') return entries;
      if (command === 'recovery_read') return historical;
      if (command === 'recovery_delete') { clears.push(args.key); entries.length = 0; return; }
      throw new Error(command);
    } });
    await openRecovery();
  }, { original, historical });
  await page.waitForFunction(() => !document.querySelector('[data-apply]').disabled);
  assert.equal(await page.locator('[aria-label="版本源码预览"]').inputValue(), historical.replaceAll('\r\n', '\n'));
  assert.equal(await page.evaluate(() => ed.getValue()), original, 'opening preview must not modify content');
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  await page.screenshot({ path: artifactPath('leaf-recovery-preview.png') });
  await page.getByRole('button', { name: '恢复到编辑区', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.recovery-dialog'));
  assert.equal(await page.evaluate(() => ed.getValue()), historical, 'restore retains exact footnote labels');
  assert.equal(await page.evaluate(() => session.save({ manual: false })), false);
  assert.deepEqual(await page.evaluate(() => writes), []);
  assert.equal(await page.evaluate(() => ed.undo()), true);
  assert.equal(await page.evaluate(() => ed.getValue()), original, 'one undo restores the entire current document');
  assert.equal(await page.evaluate(() => ed.redo()), true);
  assert.equal(await page.evaluate(() => ed.getValue()), historical);
  await page.evaluate(() => openRecovery());
  await page.getByRole('button', { name: '删除该版本', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => clears), [], 'cleanup needs the explicit second click');
  await page.getByRole('alertdialog').getByRole('button', { name: '删除该版本', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role=status]').textContent.includes('暂无可恢复'));
  assert.equal(await page.evaluate(() => ed.getValue()), historical, 'cleanup never changes the document');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.recovery-dialog'));
  assert.equal(await page.locator('.recovery-dialog').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS recovery preview, safe source display, exact restore, undo/redo, autosave pause and cleanup');
} finally { await browser.close(); }
