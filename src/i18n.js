import { shortcutText } from './platform-shortcuts.js';
import i18next from 'i18next';
import zh from './locales/zh-Hans.json' with { type: 'json' };
import tw from './locales/zh-Hant-TW.json' with { type: 'json' };
import en from './locales/en.json' with { type: 'json' };
import copyKeys from './locales/copy-keys.json' with { type: 'json' };

export const languages = ['zh-Hans', 'zh-Hant-TW', 'en'];
export const preferences = ['system', ...languages];
export const resources = { 'zh-Hans': zh, 'zh-Hant-TW': tw, en };
export { copyKeys };
export const languageName = { 'zh-Hans': '简体中文', 'zh-Hant-TW': '繁體中文（台灣）', en: 'English' };
export function resolveLanguage(tag = '') {
  const parts = String(tag).replaceAll('_', '-').toLowerCase().split('-');
  if (parts[0] !== 'zh') return 'en';
  if (parts.includes('hant')) return 'zh-Hant-TW';
  if (parts.includes('hans')) return 'zh-Hans';
  return parts.some(p => ['tw', 'hk', 'mo'].includes(p)) ? 'zh-Hant-TW' : 'zh-Hans';
}
export const normalizePreference = value => preferences.includes(value) ? value : 'system';
// Standalone model tests keep their existing Simplified Chinese default. The
// application entry awaits initializeLanguage before importing either UI.
i18next.init({ initAsync: false, lng: 'zh-Hans', fallbackLng: 'en', supportedLngs: languages,
  load: 'currentOnly', keySeparator: false, interpolation: { escapeValue: false },
  resources: Object.fromEntries(Object.entries(resources).map(([lng, translation]) => [lng, { translation }])) });
export function errorCode(value) {
  try { const error = typeof value === 'object' && value?.leafError ? value : JSON.parse(String(value?.message ?? value)); return error?.leafError === 1 && resources.en[error.code] ? error : null; } catch { return null; }
}
export function formatError(value) {
  const error = errorCode(value); return error ? t(error.code, error.params) : String(value?.message ?? value ?? '');
}
export function t(key, values = {}) {
  const args = { ...values };
  if ((copyKeys[key] || key) === 'search_panel.matches') args.count = args.total;
  for (const name of ['error','detail','reason']) if (name in args) args[name] = formatError(args[name]);
  return i18next.t(copyKeys[key] || key, args);
}
export function aliases(key) { return languages.map(lng => t(key, { lng })); }
export const currentLanguage = () => i18next.language;
export const htmlEscape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export function h(key, values = {}) {
  const args = Object.keys(values).length ? ` data-i18n-values="${htmlEscape(JSON.stringify(values))}"` : '';
  return `<span data-i18n="${key}"${args}>${htmlEscape(shortcutText(t(key, values)))}</span>`;
}
export function message(key, values = {}) { return { key, values, toString: () => t(key, values) }; }
export function resolveMessage(value) { return value?.key ? t(value.key, value.values) : formatError(value); }

let preference = 'system', native = false, revision = -1, initialized = false;
let invoke, refreshInFlight;
const listeners = new Set();
let pendingChange = false;
function notifyLanguage() {
  if (composing) { pendingChange = true; return; }
  refreshTranslations();
  for (const callback of listeners) callback(currentLanguage());
}
const bindings = new Set();
const records = new WeakMap();
export const languagePreference = () => preference;
export function onLanguageChange(callback) { listeners.add(callback); return () => listeners.delete(callback); }
function bind(element, attribute, render) {
  if (attribute) element.removeAttribute(`data-i18n-${attribute}`);
  let map = records.get(element);
  if (!map) { map = new Map(); records.set(element, map); bindings.add(new WeakRef(element)); }
  const get = () => attribute ? element.getAttribute(attribute) : element.textContent;
  const put = value => attribute ? element.setAttribute(attribute, value) : (element.textContent = value);
  const record = { render, get, put, last: String(render()) };
  map.set(attribute || 'text', record); put(record.last); return element;
}
export const setText = (element, render) => bind(element, '', render);
export const setAttr = (element, attribute, render) => bind(element, attribute, render);
export function localizedElement(tag, className, render) {
  const element = document.createElement(tag); if (className) element.className = className;
  return setText(element, render);
}
export function refreshTranslations(root = globalThis.document) {
  if (!root) return;
  for (const element of root.querySelectorAll('[data-i18n]')) {
    const value = shortcutText(t(element.dataset.i18n, JSON.parse(element.dataset.i18nValues || '{}')));
    if (element.textContent !== value) element.textContent = value;
  }
  for (const attr of ['aria-label', 'title', 'placeholder', 'data-tooltip']) {
    for (const element of root.querySelectorAll(`[data-i18n-${attr}]`)) element.setAttribute(attr, shortcutText(t(element.getAttribute(`data-i18n-${attr}`))));
  }
  for (const reference of bindings) {
    const element = reference.deref();
    if (!element) { bindings.delete(reference); continue; }
    if (!element.isConnected) continue;
    for (const record of records.get(element).values()) {
      // A later user/data assignment owns the node. Never overwrite it with a
      // stale binding (e.g. a filename replacing a former fallback label).
      if (record.get() !== record.last) continue;
      const value = String(record.render()); record.put(value); record.last = value;
    }
  }
}
async function apply(snapshot) {
  if (typeof snapshot.revision === 'number' && snapshot.revision < revision) return;
  revision = snapshot.revision ?? revision;
  const previousPreference = preference;
  preference = normalizePreference(snapshot.preference);
  const language = languages.includes(snapshot.language) ? snapshot.language
    : preference === 'system' ? resolveLanguage(navigator.language) : preference;
  const changed = language !== currentLanguage();
  await i18next.changeLanguage(language);
  if (globalThis.document) document.documentElement.lang = language;
  if (changed || previousPreference !== preference) notifyLanguage();
}
let composing = false, pendingRefresh = false;
export async function initializeLanguage() {
  if (initialized) return;
  const api = await import('@tauri-apps/api/core'); native = api.isTauri(); invoke = api.invoke;
  if (native) {
    const { listen } = await import('@tauri-apps/api/event');
    await listen('leaf-language-changed', ({ payload }) => { void apply(payload); });
    await apply(await invoke('language_get'));
  } else {
    await apply({ preference: localStorage.getItem('leaf-language') });
    window.addEventListener('storage', event => { if (event.key === 'leaf-language') void apply({ preference: event.newValue }); });
  }
  document.addEventListener('compositionstart', () => { composing = true; }, true);
  document.addEventListener('compositionend', () => { composing = false; if (pendingChange) { pendingChange = false; notifyLanguage(); } if (pendingRefresh) { pendingRefresh = false; void refreshSystemLanguage(); } refreshTranslations(); }, true);
  window.addEventListener('focus', () => { void refreshSystemLanguage(); });
  initialized = true;
}
export async function refreshSystemLanguage() {
  if (!initialized || (!native && preference !== 'system')) return;
  if (composing) { pendingRefresh = true; return; }
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (native ? invoke('language_get').then(apply) : apply({ preference })).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}
export async function setLanguagePreference(value) {
  if (!preferences.includes(value)) throw new Error('Invalid language preference');
  // Persistence happens first. Failure leaves both preference and UI unchanged.
  if (native) await apply(await invoke('language_set', { preference: value }));
  else { localStorage.setItem('leaf-language', value); await apply({ preference: value }); }
}
