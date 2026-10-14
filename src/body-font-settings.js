import { t, onLanguageChange } from './i18n.js';
import { BODY_FONTS, BODY_FONT_STORAGE, readBodyFonts, loadBodyFonts, resolveBodyFonts, bodyFontChoices } from './body-fonts.js';
import { setupFontPicker } from './body-font-picker.js';

export function setupBodyFontSettings({ root, storage = localStorage, eventTarget = window, load = loadBodyFonts }) {
  let preferences = readBodyFonts(storage), catalog = null, lastStack = '';
  const controls = { zh: root.querySelector('#chineseFontSelect'), en: root.querySelector('#englishFontSelect') };
  const status = root.querySelector('#bodyFontStatus');
  const label = font => font.label.startsWith('fonts.') ? t(font.label) : font.label;
  const pickers = Object.fromEntries(['zh','en'].map(script => [script,
    setupFontPicker(controls[script], { label: () => t(script === 'zh' ? 'fonts.chinese' : 'fonts.english') })]));
  const familyLabel = (script, id) => {
    const font = BODY_FONTS[script].find(font => font.id === id);
    const family = catalog?.[script]?.[id]?.family;
    return font?.generic ? family || t('fonts.default')
      : family && family !== font.families[0] ? family : label(font);
  };
  function render() {
    for (const script of ['zh','en']) {
      const select = controls[script];
      // Keep each option/selection stable while local checks complete or language changes.
      if (!select.options.length) for (const font of BODY_FONTS[script]) {
        const option = document.createElement('option'); option.value = font.id; select.add(option);
      }
      for (const font of BODY_FONTS[script]) {
        const option = [...select.options].find(option => option.value === font.id);
        const unavailable = !font.generic && !catalog?.[script]?.[font.id]?.available;
        option.disabled = unavailable;
        option.textContent = label(font) + (unavailable ? ` · ${t(catalog ? 'fonts.unavailable' : 'fonts.checking')}` : '');
      }
      select.value = preferences[script];
      const choices = bodyFontChoices(script, catalog).map(font => ({ ...font, label: familyLabel(script, font.id) }));
      const resolved = catalog ? resolveBodyFonts(preferences, catalog) : null;
      const active = resolved?.active[script];
      const family = catalog?.[script]?.[active]?.family;
      const selected = choices.find(font => font.id === active) || choices.find(font => font.family === family);
      pickers[script].update(choices, selected?.id, catalog ? familyLabel(script, active) : t('fonts.checking'));
    }
    if (!catalog) {
      // Preserve the exact legacy preset until local faces have finished loading.
      root.dataset.font = ['sans','serif','mono'].includes(storage.getItem('leaf-reading-v2-font'))
        ? storage.getItem('leaf-reading-v2-font') : 'sans';
      status.textContent = t('fonts.checking_local');
      return;
    }
    const resolved = resolveBodyFonts(preferences, catalog);
    root.style.setProperty('--body-font', resolved.stack);
    root.dataset.bodyFonts = 'ready';
    status.textContent = resolved.missing.length
      ? resolved.missing.map(({script,id}) => t('fonts.fallback', {
        font: label(BODY_FONTS[script].find(font => font.id === id)),
        fallback: familyLabel(script, resolved.active[script]),
      })).join(' ')
      : t('fonts.local_only');
    if (resolved.stack !== lastStack) {
      lastStack = resolved.stack;
      eventTarget.dispatchEvent(new Event('leaf-body-fonts-change'));
    }
  }
  for (const script of ['zh','en']) controls[script].addEventListener('change', () => {
    const id = controls[script].value;
    const option = BODY_FONTS[script].find(font => font.id === id);
    if (!option || (!option.generic && !catalog?.[script]?.[id]?.available)) { render(); return; }
    const next = { ...readBodyFonts(storage), [script]: id };
    try { storage.setItem(BODY_FONT_STORAGE, JSON.stringify(next)); }
    catch { render(); status.textContent = t('fonts.save_failed'); return; }
    preferences = next;
    render();
  });
  eventTarget.addEventListener('storage', event => {
    if (event.storageArea && event.storageArea !== storage) return;
    if (event.key !== BODY_FONT_STORAGE && event.key !== 'leaf-reading-v2-font' && event.key !== null) return;
    preferences = readBodyFonts(storage); render();
  });
  onLanguageChange(render);
  render();
  const ready = Promise.resolve().then(load).catch(() => ({ en: {}, zh: {} })).then(value => { catalog = value; render(); });
  return { render, ready };
}
