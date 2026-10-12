import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {macLocales, serviceIdentity, serviceKey, serviceStrings, syncMacLocales} from '../scripts/sync-macos-locales.mjs';

test('Finder service resources and package declarations stay aligned with approved copy', async () => {
  await syncMacLocales({check: true});
  // macOS can retain this pre-i18n identity after an application upgrade.
  // Translating the identity breaks cached requests, even if the menu remains.
  assert.equal(serviceIdentity, '使用 Leaf 新建 Markdown 文档');
  const plist = await readFile(new URL('../src-tauri/Info.plist', import.meta.url), 'utf8');
  assert.ok(plist.includes(`<key>default</key><string>${serviceIdentity}</string>`));
  assert.match(plist, /<key>CFBundleDevelopmentRegion<\/key><string>en<\/string>/);
  const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.macos.conf.json', import.meta.url), 'utf8'));
  for (const locale of Object.keys(macLocales)) {
    const destination = `${locale}.lproj/ServicesMenu.strings`;
    assert.equal(config.bundle.resources[`locales/${destination}`], destination);
    assert.ok(plist.includes(`<string>${locale}</string>`));
  }
  assert.ok(config.build.beforeBuildCommand.includes('sync-macos-locales.mjs --check'));
});

test('ServicesMenu strings escape quotes, backslashes and multiline text without changing copy', () => {
  const key = 'Create "Leaf"';
  const value = '第一行\n"第二行"\\附件';
  const line = serviceStrings(key, value).split('\n')[1];
  const [, encodedKey, encodedValue] = line.match(/^("(?:[^"\\]|\\.)*") = ("(?:[^"\\]|\\.)*");$/);
  assert.equal(JSON.parse(encodedKey), key);
  assert.equal(JSON.parse(encodedValue), value);
});
