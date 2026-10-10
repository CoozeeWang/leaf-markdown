// Leaf-owned shell text only; Tauri's built-in NSIS translations remain authoritative.
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export const windowsLanguages = {English: {locale:'en', id:1033}, SimpChinese: {locale:'zh-Hans', id:2052}, TradChinese: {locale:'zh-Hant-TW', id:1028}};
export const shellKey = 'Info.create_a_markdown_document_with_leaf';
export function nsisEscape(value) {
  return String(value).replaceAll('$', () => '$$').replaceAll('"', '$\\"').replaceAll('\r', '$\\r').replaceAll('\n', '$\\n');
}
export async function windowsStrings() {
  const lines = ['; Generated from src/locales; run node scripts/sync-windows-locales.mjs.', '; Numeric NSIS language IDs work before Tauri inserts its MUI_LANGUAGE macros.'];
  for (const {locale,id} of Object.values(windowsLanguages)) {
    const resource = JSON.parse(await readFile(new URL(`../src/locales/${locale}.json`,import.meta.url),'utf8'));
    const value = resource[shellKey];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing Windows shell text: ${locale}`);
    lines.push(`LangString LeafNewMarkdown ${id} "${nsisEscape(value)}"`);
  }
  return '\uFEFF' + lines.join('\n') + '\n';
}
export async function syncWindowsLocales({check=false}={}) {
  const destination = new URL('../src-tauri/windows-locales.nsh',import.meta.url), expected = await windowsStrings();
  if (check) { if (await readFile(destination,'utf8') !== expected) throw new Error('Stale Windows resources; run node scripts/sync-windows-locales.mjs'); }
  else await writeFile(destination,expected);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await syncWindowsLocales({check:process.argv.includes('--check')});
