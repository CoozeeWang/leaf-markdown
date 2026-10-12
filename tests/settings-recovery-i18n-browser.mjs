import assert from 'node:assert/strict';
import { webkit } from 'playwright';
import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';

for (const engine of (process.env.LEAF_TEST_ENGINE ? [process.env.LEAF_TEST_ENGINE] : ['chrome', 'webkit'])) {
  const browser = await (engine === 'webkit' ? webkit.launch({ headless: true }) : chromium.launch(launchOptions));
  try {
    for (const native of [true, false]) {
      const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1100, height: 800 } });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('crash', () => console.error(`${engine}: renderer crashed`));
      if (native) await page.addInitScript(() => {
        window.isTauri = true;
        const callbacks = {}, handlers = {}; let id = 0;
        let language = { preference: 'en', language: 'en', revision: 0 };
        window.__TAURI_INTERNALS__ = {
          metadata: { currentWindow: { label: 'document-test' }, currentWebview: { label: 'document-test' } },
          transformCallback: fn => { callbacks[++id] = fn; return id; },
          invoke: async (command, args) => {
            if (command === 'language_get') return language;
            if (command === 'language_set') return (language = { preference: args.preference, language: args.preference, revision: language.revision + 1 });
            if (command === 'plugin:event|listen') { handlers[args.event] = callbacks[args.handler]; return ++id; }
            if (command === 'initial_path') return '/samples/settings.md';
            if (command === 'observe_document') return { path: '/samples/settings.md', content: '# Sample\n\nUnchanged body.' };
            if (command === 'read_document') return '# Sample\n\nUnchanged body.';
            if (command === 'recovery_list' || command === 'recent_list') return [];
            if (command === 'recovery_retention') return 30;
            return null;
          },
        };
      });
      await page.goto('http://127.0.0.1:41732/?document=1');
      if (!native) await page.click('#welcomeNewButton');
      await page.click('#appearanceButton');
      await page.click('#settingsTab-recovery');
      await page.locator('#settingsTab-appearance').hover();
      await page.waitForTimeout(180);
      assert.notEqual(await page.locator('#settingsTab-appearance').evaluate(el => getComputedStyle(el).backgroundColor), await page.locator('#settingsTab-recovery').evaluate(el => getComputedStyle(el).backgroundColor), 'Hover and selected tabs stay distinct');
      await page.mouse.move(5, 5);
      for (const language of ['zh-Hans', 'zh-Hant-TW', 'en', 'zh-Hans']) {
        await page.click('#settingsTab-appearance');
        await page.click('#editorLanguageSelect');
      await page.click(`#languagePopover [data-language=\"${language}\"]`);
      await page.click('#appearanceButton');
        await page.waitForFunction(language => document.documentElement.lang === language, language);
        const expected = await page.evaluate(async native => {
          const { t } = await import('/src/i18n.js');
          return [t(native ? 'main.view_recoverable_drafts' : 'main.restore_version_before_last_save'), t(native ? 'main.versions_drafts' : 'main.restore_version_before_last_save_ui0107')];
        }, native);
        await page.click('#settingsTab-recovery');
        assert.equal(await page.locator('#settingsRecovery').innerText(), expected[0], 'Recovery action follows each language switch');
        assert.equal(await page.locator('#documentHistory').textContent(), expected[1], 'Document menu follows the same switch');
        for (const theme of ['light', 'dark']) for (const width of [1100, 900]) {
          await page.setViewportSize({ width, height: width === 900 ? 480 : 800 });
          await page.waitForTimeout(100);
          // Resizing intentionally dismisses popovers; reopen the settings for measurement.
          if (await page.locator('#appearancePopover').isHidden()) await page.click('#appearanceButton');
          await page.click('#settingsTab-recovery');
          await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
          const geometry = await page.locator('#settingsRecovery').evaluate(el => {
            const r = el.getBoundingClientRect(), panel = document.querySelector('#settingsPanel-recovery').getBoundingClientRect(), select = document.querySelector('#recoveryRetentionSelect')?.getBoundingClientRect(), footer = document.querySelector('.settings-about').getBoundingClientRect();
            return { right: r.right, expectedRight: select?.right ?? panel.right, bottom: r.bottom, footerTop: footer.top, fits: r.right <= innerWidth && r.bottom <= innerHeight, horizontalOverflow: el.scrollWidth > el.clientWidth };
          });
          assert.ok(Math.abs(geometry.right - geometry.expectedRight) < 1);
          assert.ok(geometry.fits && !geometry.horizontalOverflow && geometry.bottom < geometry.footerTop, JSON.stringify({engine,native,language,theme,width,...geometry}));
          if (native && width === 900) await page.screenshot({ animations: 'disabled', path: artifactPath(`settings-recovery-${engine}-${language}-${theme}.png`) });
        }
      }
      // The action still opens the draft list; no real files or recovery data are used.
      if (native) {
        await page.click('#settingsRecovery');
        await page.locator('.recovery-dialog').waitFor();
        await page.keyboard.press('Escape');
        await page.click('#appearanceButton');
      }
      await page.click('#settingsTab-appearance');
      await page.click('#editorLanguageSelect');
      await page.click(`#languagePopover [data-language=\"${'en'}\"]`);
      await page.click('#appearanceButton');
      await page.waitForFunction(() => document.documentElement.lang === 'en');
      await page.click('#settingsTab-recovery');
      // Exercise actual wrapping, not just a CSS property: every line begins at the same x.
      const button = page.locator('#settingsRecovery');
      await button.evaluate(el => { el.style.width = '120px'; });
      const lines = await button.locator('span').evaluate(el => {
        const range = document.createRange(); range.selectNodeContents(el);
        return [...range.getClientRects()].filter(r => r.width > 0).map(r => ({ x: r.x, y: r.y }));
      });
      assert.ok(lines.length >= 2, 'Long English action wraps in constrained width');
      assert.ok(lines.every(r => Math.abs(r.x - lines[0].x) < 1), 'Wrapped lines align to the start');
      await button.evaluate(el => { el.style.width = ''; });
      assert.deepEqual(errors, []);
      console.log(`PASS ${engine} ${native ? 'desktop-mocked' : 'web'} branch`);
      await page.close();
    }
    console.log(`PASS ${engine}: desktop-mocked/web recovery translations, layout, wrapped English and distinct hover`);
  } catch (error) { console.error(error); throw error; } finally { await browser.close(); }
}
