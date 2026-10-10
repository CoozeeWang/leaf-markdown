import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {syncWindowsLocales, nsisEscape, windowsLanguages} from '../scripts/sync-windows-locales.mjs';
test('Windows shell resources stay synchronized with the approved three-language baseline', async () => {
  await syncWindowsLocales({check:true});
  assert.deepEqual(Object.keys(windowsLanguages), ['English','SimpChinese','TradChinese']);
  assert.equal(nsisEscape('Cost $5 "quoted"\r\nnext'), 'Cost $$5 $\\"quoted$\\"$\\r$\\nnext');
});
test('Windows installer reuses built-in languages with English fallback and selects language explicitly', async () => {
  const config=JSON.parse(await readFile('src-tauri/tauri.windows.conf.json','utf8'));
  const nsis=config.bundle.windows.nsis;
  assert.deepEqual(nsis.languages,Object.keys(windowsLanguages));
  assert.equal(nsis.displayLanguageSelector,true);
  assert.equal(nsis.installMode,'currentUser');
  assert.equal(nsis.customLanguageFiles,undefined);
  assert.equal(nsis.template,undefined);
  const hook=await readFile('src-tauri/windows-hooks.nsh','utf8');
  assert.equal((hook.match(/"\$\(LeafNewMarkdown\)"/g)||[]).length,2);
  assert.ok(hook.includes('windows-locales.nsh'));
  assert.ok(!hook.includes('language-v1.json'), 'Install language cannot overwrite app preferences');
});
