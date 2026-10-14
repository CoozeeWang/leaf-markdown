// Display preferences only. Local faces are never downloaded or copied into a document.
export const BODY_FONT_STORAGE = 'leaf-body-fonts-v1';
export const LATIN_RANGE = 'U+0000-036F,U+1AB0-1AFF,U+1DC0-1EFF,U+FE20-FE2F';
export const CHINESE_RANGE = 'U+0370-1AAF,U+1B00-1DBF,U+1F00-FE1F,U+FE30-10FFFF';
const generic = id => ({ id, label: `fonts.${id}`, generic: true });
export const BODY_FONTS = {
  en: [generic('sans'), generic('serif'), generic('mono'),
    { id: 'palatino', label: 'Palatino', families: ['Palatino', 'Palatino Linotype'] },
    { id: 'georgia', label: 'Georgia', families: ['Georgia'] },
    { id: 'nyt-imperial', label: 'NYT Imperial', families: ['NYT Imperial'] },
    { id: 'nyt-cheltenham', label: 'NYT Cheltenham', families: ['NYT Cheltenham'] }],
  zh: [generic('sans'), generic('serif'), generic('mono'),
    { id: 'songti', label: 'fonts.songti', families: ['Songti SC'] },
    { id: 'simsun', label: 'fonts.simsun', families: ['SimSun'] },
    { id: 'pingfang', label: 'fonts.pingfang', families: ['PingFang SC'] },
    { id: 'yahei', label: 'fonts.yahei', families: ['Microsoft YaHei'] }],
};
const presetFamilies = {
  en: { sans: ['SF Pro Text', 'Segoe UI', 'Arial', 'Liberation Sans'],
    serif: ['Georgia', 'Times New Roman', 'Liberation Serif'],
    mono: ['SF Mono', 'Menlo', 'Consolas', 'Liberation Mono'] },
  zh: { sans: ['PingFang SC', 'Noto Sans CJK SC', 'Microsoft YaHei'],
    serif: ['Songti SC', 'Noto Serif CJK SC', 'SimSun'],
    mono: ['Noto Sans Mono CJK SC', 'SimSun'] },
};
export function readBodyFonts(storage) {
  const legacy = storage.getItem('leaf-reading-v2-font');
  const fallback = ['sans', 'serif', 'mono'].includes(legacy) ? legacy : 'sans';
  let value;
  try { value = JSON.parse(storage.getItem(BODY_FONT_STORAGE)); } catch { /* Corrupt preference uses the existing preset. */ }
  return Object.fromEntries(['zh', 'en'].map(script => [script,
    BODY_FONTS[script].some(font => font.id === value?.[script]) ? value[script] : fallback]));
}
export function fontAlias(script, id) { return `Leaf Body ${script} ${id}`; }
// local() accepts full/PostScript face names. Include their common platform spellings,
// but never use an unrelated family as a named font's availability substitute.
function localSources(family, style, weight) {
  const compact = family.replaceAll(' ', '');
  const suffix = weight === '700' ? (style === 'italic' ? 'Bold Italic' : 'Bold') : (style === 'italic' ? 'Italic' : 'Regular');
  const psSuffix = suffix.replaceAll(' ', '');
  const names = [`${family} ${suffix}`, `${compact}-${psSuffix}`, `${compact}${psSuffix}`];
  if (style === 'normal' && weight === '400') names.unshift(family, compact, `${compact}-Roman`);
  if (family === 'Arial') names.push(style === 'normal' && weight === '400' ? 'ArialMT' : `Arial-${psSuffix}MT`);
  if (family === 'Times New Roman') names.push(style === 'normal' && weight === '400' ? 'TimesNewRomanPSMT' : `TimesNewRomanPS-${psSuffix}MT`);
  return [...new Set(names)].map(name => `local(${JSON.stringify(name)})`).join(', ');
}
async function loadFace(FontFaceType, alias, family, script, style, weight, timeout) {
  const face = new FontFaceType(alias, localSources(family, style, weight), {
    unicodeRange: script === 'en' ? LATIN_RANGE : CHINESE_RANGE, style, weight,
  });
  let timer;
  try {
    return await Promise.race([face.load(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Local font lookup timed out')), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
export async function loadBodyFonts({ FontFaceType = globalThis.FontFace, fontSet = globalThis.document?.fonts, timeout = 2000 } = {}) {
  const result = { en: {}, zh: {} };
  await Promise.all(['en', 'zh'].flatMap(script => BODY_FONTS[script].map(async font => {
    const record = result[script][font.id] = { available: !!font.generic, alias: null, family: null };
    if (!FontFaceType || !fontSet) return;
    const alias = fontAlias(script, font.id);
    for (const family of font.families || presetFamilies[script][font.id]) {
      try {
        const normal = await loadFace(FontFaceType, alias, family, script, 'normal', '400', timeout);
        fontSet.add(normal);
        Object.assign(record, { available: true, alias, family });
        // Genuine italic/bold faces are preferred. Browsers synthesize an absent style.
        await Promise.all([['normal','700'], ['italic','400'], ['italic','700']].map(async ([style, weight]) => {
          try { fontSet.add(await loadFace(FontFaceType, alias, family, script, style, weight, timeout)); }
          catch { /* This family may not supply the requested style. */ }
        }));
        break;
      } catch { /* Try only the next documented local face/family. */ }
    }
  })));
  return result;
}
export function resolveBodyFonts(preferences, catalog) {
  const active = {}, missing = [];
  for (const script of ['en', 'zh']) {
    const requested = preferences[script];
    const option = BODY_FONTS[script].find(font => font.id === requested);
    const valid = !!option;
    active[script] = valid && (option.generic || catalog?.[script]?.[requested]?.available) ? requested : 'sans';
    if (valid && active[script] !== requested) missing.push({ script, id: requested });
  }
  const faces = ['en', 'zh'].map(script => catalog?.[script]?.[active[script]]?.alias).filter(Boolean);
  // If the local CJK preset isn't known, let the browser resolve its generic
  // family. A loaded, range-limited English face still governs Latin glyphs.
  const fallbackScript = catalog?.en?.[active.en]?.alias && !catalog?.zh?.[active.zh]?.alias ? 'zh' : 'en';
  const preset = active[fallbackScript];
  const fallback = preset === 'mono' ? 'var(--ui-mono)' : preset === 'serif' ? 'serif' : 'var(--ui-font)';
  return { active, missing, stack: [...faces.map(face => JSON.stringify(face)), fallback].join(', ') };
}
