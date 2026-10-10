// Finder uses the system language, independently of Leaf's app preference.
// zh-Hant carries the approved Taiwan wording for all Traditional Chinese systems.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export const serviceKey = 'Info.create_a_markdown_document_with_leaf';
export const macLocales = {en: 'en', 'zh-Hans': 'zh-Hans', 'zh-Hant': 'zh-Hant-TW'};
export function serviceStrings(key, value) {
  return `/* Generated from src/locales; run node scripts/sync-macos-locales.mjs. */\n${JSON.stringify(key)} = ${JSON.stringify(value)};\n`;
}

export async function syncMacLocales({check = false} = {}) {
  const english = JSON.parse(await readFile(new URL('../src/locales/en.json', import.meta.url), 'utf8'));
  const key = english[serviceKey];
  if (typeof key !== 'string' || !key.trim()) throw new Error('Missing English Finder service name');
  for (const [bundleLocale, resourceLocale] of Object.entries(macLocales)) {
    const resources = JSON.parse(await readFile(new URL(`../src/locales/${resourceLocale}.json`, import.meta.url), 'utf8'));
    const value = resources[serviceKey];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing Finder service name: ${resourceLocale}`);
    const destination = new URL(`../src-tauri/locales/${bundleLocale}.lproj/ServicesMenu.strings`, import.meta.url);
    const expected = serviceStrings(key, value);
    if (check) {
      if (await readFile(destination, 'utf8') !== expected) throw new Error(`Stale macOS resource: ${bundleLocale}; run node scripts/sync-macos-locales.mjs`);
    } else {
      await mkdir(new URL('.', destination), {recursive: true});
      await writeFile(destination, expected);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncMacLocales({check: process.argv.includes('--check')});
}
