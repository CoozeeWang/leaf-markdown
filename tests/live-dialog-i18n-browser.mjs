import assert from 'node:assert/strict';
import {webkit} from 'playwright';
import {chromium, launchOptions} from './browser-runtime.mjs';
import {nativePage} from './ai-browser-fixture.mjs';

const base = process.env.LEAF_TEST_BASE_URL || 'http://127.0.0.1:41732';
for (const engine of process.env.LEAF_TEST_ENGINE ? [process.env.LEAF_TEST_ENGINE] : ['chrome', 'webkit']) {
  const browser = await (engine === 'webkit' ? webkit.launch({headless:true}) : chromium.launch(launchOptions));
  try {
    const context = await browser.newContext({locale:'zh-CN', viewport:{width:900,height:480}});
    const page = await context.newPage(), peer = await context.newPage(), errors = [];
    for (const target of [page, peer]) {
      target.on('pageerror', error => errors.push(error.message));
      await target.goto(base);
      await target.locator('#welcomeNewButton').waitFor();
    }
    await page.click('#welcomeNewButton');
    await page.locator('.cm-content').fill('# Synthetic document\n\nKeep this unsaved text.');
    const documentState = () => page.evaluate(async () => {
      const {EditorView} = await import('/node_modules/@codemirror/view/dist/index.js');
      const {undoDepth, redoDepth} = await import('/node_modules/@codemirror/commands/dist/index.js');
      const view = EditorView.findFromDOM(document.querySelector('.cm-content'));
      return {text:view.state.doc.toString(), selection:view.state.selection.toJSON(), undo:undoDepth(view.state), redo:redoDepth(view.state)};
    });
    for (const drafts of [true, false]) {
      await page.evaluate(async drafts => {
        const {showRecovery} = await import('/src/recovery-dialog.js');
        window.recoveryCalls = [];
        await showRecovery({drafts, restore:() => {throw Error('Unexpected restore');}, invoke:async (command,args) => {
          recoveryCalls.push(command);
          if (command === 'recovery_list') return [1,2].map(n => ({key:'synthetic', id:String(n), kind:drafts?'draft':'saved', source:`/samples/Version ${n}.md`, timestamp:n*1000, bytes:20}));
          if (command === 'recovery_read') return `# Version ${args.id}\n\nSynthetic recovery text.`;
          throw Error(`Unexpected recovery action: ${command}`);
        }});
      }, drafts);
      await page.locator('.recovery-list').press('End');
      await page.waitForFunction(() => document.querySelector('.recovery-dialog textarea').value.startsWith('# Version 2'));
      const before = await documentState();
      for (const language of ['en', 'zh-Hant-TW', 'zh-Hans']) {
        // A second window changes the shared preference while the dialog stays open.
        await peer.evaluate(async language => (await import('/src/i18n.js')).setLanguagePreference(language), language);
        await page.waitForFunction(language => document.documentElement.lang === language, language);
        const expected = await page.evaluate(async drafts => {
          const {t} = await import('/src/i18n.js');
          return [t(drafts?'recovery_dialog.recover_drafts':'recovery_dialog.versions_drafts'), t(drafts?'recovery_dialog.preview_and_open_as_a_new_document':'recovery_dialog.restoring_replaces_the_content_in_the_editor'), t(drafts?'recovery_dialog.open_as_new_document':'recovery_dialog.restore_to_editor')];
        }, drafts);
        assert.deepEqual(await page.locator('#recovery-title, .recovery-intro, .recovery-dialog [data-apply]').allTextContents(), expected);
        assert.equal(await page.locator('.recovery-dialog textarea').inputValue(), '# Version 2\n\nSynthetic recovery text.');
        assert.equal(await page.locator('.recovery-list [aria-selected=true]').getAttribute('data-index'), '1');
        assert.equal(await page.locator('.recovery-list').evaluate(el => el === document.activeElement), true);
        assert.equal(await page.locator('.recovery-dialog [data-apply]').isEnabled(), true);
        assert.deepEqual(await documentState(), before);
      }
      assert.deepEqual(await page.evaluate(() => [...new Set(recoveryCalls)].sort()), ['recovery_list','recovery_read']);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.recovery-dialog').count(), 0);
    }
    assert.deepEqual(errors, []);
    await context.close();

    for (const os of ['macos','windows']) {
      const ai = await nativePage(browser, os);
      await ai.locator('#mcpEnabled').check();
      await ai.locator('#aiAdvanced summary').click();
      await ai.locator('#aiTunnelProxy').fill('http://proxy.example:8080');
      const savedBefore = await ai.evaluate(() => JSON.stringify(aiMock.clients));
      for (const language of ['en','zh-Hant-TW','zh-Hans']) {
        await ai.evaluate(async language => (await import('/src/i18n.js')).setLanguagePreference(language), language);
        const expected = {'en':'Leave blank to detect automatically','zh-Hant-TW':'留空時自動偵測','zh-Hans':'留空时自动检测'}[language];
        assert.equal(await ai.locator('#aiTunnelProxy').getAttribute('placeholder'), expected);
        assert.equal(await ai.locator('#aiTunnelProxy').inputValue(), 'http://proxy.example:8080');
        assert.equal(await ai.evaluate(() => JSON.stringify(aiMock.clients)), savedBefore);
      }
      await ai.close();
    }
    console.log(`PASS ${engine}: live draft/version dialog translations across windows preserve selection, preview, focus and document history; simulated Mac/Windows proxy copy preserves input and configuration`);
  } finally { await browser.close(); }
}
