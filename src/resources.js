import { safeAppLink } from './app-links.js';
import { t, setText, setAttr, formatError } from './i18n.js';
import { uiIcon } from './ui-icons.js';
import { positionMenu } from './menu-position.js';
let readLocal = null;
let revealLocal = null;
let movedMissing = new Set();
export function setResourceReader(reader) { readLocal = reader; refreshImages(); }
export function setResourceRevealer(revealer) {
  revealLocal = revealer;
  if (!revealer) closeImageMenu();
  document.querySelectorAll('.leaf-image').forEach(updateImageActions);
}
export function loadedLocalImagePaths(root = document) {
  return [...new Set([...root.querySelectorAll('img[data-resource][data-loaded="yes"]')]
    .map(img => safeTarget(img.dataset.resource, true))
    .filter(path => path && !/^https?:\/\//i.test(path))
    .map(decodeURIComponent))];
}
export function setMovedMissingImages(paths = []) { movedMissing = new Set(paths); }
export function safeLinkTarget(value) {
  return safeAppLink(value) || safeTarget(value);
}
export function safeTarget(value, image = false) {
  let target = String(value || '').trim().replace(/^<|>$/g, '');
  if (/[\u0000-\u001f\u007f]/.test(target)) return null;
  if (target.includes(' ')) target = target.replace(/ /g, '%20');
  if (!target || /[\u0000-\u0020\u007f]/.test(target)) return null;
  if (/^https?:\/\//i.test(target)) { try { const url = new URL(target); return url.username || url.password ? null : target; } catch { return null; } }
  if (!image && (/^mailto:[^\s]+$/i.test(target) || target.startsWith('#'))) return target;
  if (/^[a-z][a-z\d+.-]*:|^\/|\\/i.test(target)) return null;
  let decoded; try { decoded = decodeURIComponent(target); } catch { return null; }
  if (/[\0\\:]/.test(decoded) || decoded.split('/').includes('..') || decoded.startsWith('/')) return null;
  return target;
}
// The blob needs a real type: neither WebKit nor Chromium decodes an image
// without one, and a file extension alone says nothing about the content.
export function mime(data) {
  if (data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  const ascii = String.fromCharCode(...data.slice(0, 12));
  if (ascii.startsWith('GIF8')) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.endsWith('WEBP')) return 'image/webp';
  if (ascii.startsWith('BM')) return 'image/bmp';
  // HEIF: the box type sits at 4..8 and the brand right after it. iPhone photos
  // use "heic"; the same container carries stills and sequences under other
  // brands, and only some platforms decode any of them.
  if (ascii.slice(4, 8) === 'ftyp' && /^(?:heic|heix|heim|heis|hevc|hevx|hevm|hevs|mif1|msf1)$/.test(ascii.slice(8, 12))) return 'image/heic';
  // SVG is text, so it has no magic bytes: an XML declaration is optional and
  // the root tag is the only reliable mark.
  if (/^(?:<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(new TextDecoder().decode(data.slice(0, 1024)).trim())) return 'image/svg+xml';
  throw new Error(t("resources.unsupported_image_format"));
}
function decodedPath(target) {
  // A malformed escape must not turn "cannot show this" into a crash: the raw
  // text is still the most useful thing to print.
  try { return decodeURIComponent(String(target || '')); } catch { return String(target || ''); }
}
function fileNameOf(target) {
  const decoded = decodedPath(target);
  return decoded.split(/[\\/]/).pop() || decoded;
}
function localImagePath(img) {
  const target = safeTarget(img.dataset.resource, true);
  return target && !/^https?:\/\//i.test(target) ? decodeURIComponent(target) : null;
}
function revealLabel() { return /Mac|iPhone|iPad/i.test(navigator.userAgentData?.platform || navigator.platform) ? t("resources.show_in_finder") : t("resources.show_in_file_manager"); }
function revealImage(img) {
  if (!img.isConnected) return;
  const relative = localImagePath(img);
  if (!relative || !revealLocal) return;
  void revealLocal(relative).catch(error => {
    (img.isConnected ? img : document).dispatchEvent(new CustomEvent('leaf-image-reveal-failed', {
      bubbles: true,
      detail: `${fileNameOf(img.dataset.resource)}：${formatError(error)}`,
    }));
  });
}
let imageMenu = null;
let imageMenuTrigger = null;
let imageMenuImage = null;
function closeImageMenu(restoreFocus = false) {
  if (!imageMenu || imageMenu.hidden) return;
  imageMenu.hidden = true;
  if (restoreFocus && imageMenuTrigger?.isConnected) imageMenuTrigger.focus();
  imageMenuTrigger = null;
  imageMenuImage = null;
}
function ensureImageMenu() {
  if (imageMenu) return imageMenu;
  imageMenu = document.createElement('section');
  imageMenu.className = 'leaf-image-menu';
  imageMenu.setAttribute('role', 'menu');
  setAttr(imageMenu, 'aria-label', () => t("resources.image_actions"));
  imageMenu.hidden = true;
  const reveal = document.createElement('button');
  reveal.type = 'button';
  reveal.setAttribute('role', 'menuitem');
  setText(reveal, revealLabel);
  reveal.addEventListener('click', () => {
    const img = imageMenuImage;
    closeImageMenu(true);
    if (img) revealImage(img);
  });
  imageMenu.append(reveal);
  document.body.append(imageMenu);
  document.addEventListener('pointerdown', event => {
    if (!imageMenu.hidden && !imageMenu.contains(event.target) && !imageMenuTrigger?.contains(event.target)) closeImageMenu();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !imageMenu.hidden) {
      event.preventDefault(); event.stopPropagation(); closeImageMenu(true);
    }
  }, true);
  return imageMenu;
}
function openImageMenu(img, trigger, anchor) {
  if (!revealLocal || !localImagePath(img)) return;
  closeImageMenu();
  const menu = ensureImageMenu();
  imageMenuImage = img;
  imageMenuTrigger = trigger;
  menu.hidden = false;
  positionMenu(menu, anchor);
  menu.querySelector('button').focus();
}
function updateImageActions(holder) {
  const img = holder.querySelector('img[data-resource]');
  const button = holder.querySelector('.leaf-image-actions');
  if (img && button) button.hidden = !revealLocal || !localImagePath(img);
}
function platformName() {
  const ua = navigator.userAgent || '';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return t("resources.this_platform");
}
// Each failure needs its own sentence: a format this platform cannot decode, a
// format Leaf does not recognise, a file that is no longer there, one over the
// size limit, and bytes that are damaged. The note answers what happens next or
// reassures that nothing was lost -- never how loading works.
function failureText(kind, target) {
  const file = fileNameOf(target);
  const ext = (file.match(/\.([^.]+)$/)?.[1] || '').toUpperCase();
  if (kind === 'unsupported-here') return [t("resources.cannot_preview_image", {"ext": ext, "file": file}), t('MO0148')];
  if (kind === 'format') return [t("resources.cannot_preview", {"file": file}), t("resources.this_image_format_is_not_supported_yet")];
  if (kind === 'missing') return [t("resources.image_not_found", {"file": file}), t("resources.the_image_file_may_have_been_moved")];
  if (kind === 'moved-missing') return [t("resources.image_not_found", {"file": file}), t("resources.the_document_has_moved_but_the_image")];
  if (kind === 'large') return [t("resources.image_too_large", {"file": file}), t("resources.the_image_exceeds_the_32_mb_limit")];
  if (kind === 'desktop') return [t("resources.cannot_preview", {"file": file}), t("resources.open_local_images_in_the_desktop_app")];
  if (kind === 'path') return [t("resources.cannot_preview", {"file": file}), t("resources.this_image_path_is_not_supported")];
  return [t("resources.cannot_load", {"file": file}), t("resources.the_image_may_be_damaged_or_loading")];
}
function fail(kind) { const error = new Error(kind); error.leafFailure = kind; return error; }
// Rebuilt from scratch every time: a reload must not stack a second click
// handler on the same status element.
function renderFailure(status, img, kind) {
  const card = document.createElement('span');
  card.className = 'leaf-image-status';
  card.dataset.kind = kind;
  status.replaceWith(card);
  const [head, note] = failureText(kind, img.dataset.resource);
  const icon = document.createElement('span');
  icon.className = 'leaf-image-status-icon';
  icon.innerHTML = uiIcon('image', 16);
  const title = document.createElement('span');
  title.className = 'leaf-image-status-head'; setText(title, () => failureText(kind, img.dataset.resource)[0]);
  const detail = document.createElement('span');
  detail.className = 'leaf-image-status-note'; setText(detail, () => failureText(kind, img.dataset.resource)[1]);
  const lines = document.createElement('span');
  lines.append(title, detail);
  card.append(icon, lines);
  if (!revealLocal || !localImagePath(img)) return;
  const name = fileNameOf(img.dataset.resource);
  card.dataset.clickable = 'yes';
  setAttr(card, 'data-tooltip', revealLabel);
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  setAttr(card, 'aria-label', () => `${revealLabel()} ${name}`);
  const open = () => revealImage(img);
  // The preview widget turns every press inside it into a caret move and then
  // swaps itself for source text, which would destroy the card before its click
  // ever fires. Catching the press on the way down keeps the card alive.
  card.addEventListener('mousedown', event => {
    event.preventDefault(); event.stopPropagation(); open();
  });
  card.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault(); open();
  });
}
export function imageNode(alt, path) {
  const holder = document.createElement('span'); holder.className = 'leaf-image';
  const img = document.createElement('img'); img.alt = alt; img.dataset.resource = path;
  img.referrerPolicy = 'no-referrer';
  const actions = document.createElement('button');
  actions.type = 'button'; actions.className = 'leaf-image-actions';
  actions.innerHTML = uiIcon('folder', 14);
  setAttr(actions, 'data-tooltip', revealLabel);
  actions.dataset.tooltipKind = 'control';
  setAttr(actions, 'aria-label', revealLabel);
  actions.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
  actions.addEventListener('click', event => {
    event.stopPropagation();
    revealImage(img);
  });
  img.addEventListener('contextmenu', event => {
    if (!revealLocal || !localImagePath(img)) return;
    event.preventDefault(); event.stopPropagation();
    openImageMenu(img, actions, {left:event.clientX,right:event.clientX,top:event.clientY,bottom:event.clientY});
  });
  const status = document.createElement('span'); status.className = 'leaf-image-status';
  holder.append(img, actions, status); updateImageActions(holder); loadImage(img); return holder;
}
export async function loadImage(img) {
  const token = {}; img._resourceToken = token;
  // A retry starts with a plain status, without failure styles, focus targets
  // or reveal handlers left by the previous attempt.
  const status = document.createElement('span'); status.className = 'leaf-image-status';
  img.parentElement.querySelector('.leaf-image-status').replaceWith(status);
  setText(status, () => t("resources.loading_image")); img.hidden = true; img.dataset.loaded = 'pending';
  delete img.dataset.failure;
  try {
    const target = safeTarget(img.dataset.resource, true); if (!target) throw fail('path');
    const local = !/^https?:/i.test(target);
    if (local && !readLocal) throw fail('desktop');
    let url = target, revoke = false, type = '';
    if (local) {
      let bytes;
      try { bytes = new Uint8Array(await readLocal(decodeURIComponent(target))); }
      // "Missing" is the everyday case, but the reader also refuses oversized
      // files, and that needs its own sentence rather than a wrong accusation.
      // Tauri rejects commands with a bare string, not an Error.
      catch (error) {
        const detail = String(error?.message ?? error);
        const absent = /\b(?:ENOENT|os error 2)\b|no such file or directory|the system cannot find the (?:file|path) specified/i.test(detail);
        throw fail(/32 MB/.test(detail) ? 'large' : absent && movedMissing.has(decodeURIComponent(target)) ? 'moved-missing' : 'missing');
      }
      try { type = mime(bytes); }
      catch { throw fail('format'); }
      url = URL.createObjectURL(new Blob([bytes], { type })); revoke = true;
    }
    try {
      if (img._resourceToken !== token) return;
      img.src = url;
      await Promise.race([img.decode(), new Promise((_, reject) => setTimeout(() => reject(new Error(t("resources.image_loading_timed_out"))), 15000))]);
      if (img._resourceToken !== token) return;
      img.hidden = false; setText(status, () => ''); img.dataset.loaded = 'yes';
      movedMissing.delete(decodeURIComponent(target));
    } catch (error) {
      // A known type that still will not decode is this platform refusing the
      // format, not a damaged file -- HEIC on Windows is the expected case.
      throw fail(/^image\/hei[cf]$/.test(type) ? 'unsupported-here' : 'broken');
    } finally { if (revoke) URL.revokeObjectURL(url); }
  } catch (error) {
    if (img._resourceToken !== token) return;
    const kind = error.leafFailure || 'broken';
    img.dataset.loaded = 'error'; img.dataset.failure = kind;
    renderFailure(status, img, kind);
  }
  img.dispatchEvent(new Event('leaf-image-ready', { bubbles: true }));
}
export function refreshImages(root = document) { root.querySelectorAll('img[data-resource]').forEach(loadImage); }
export function retryMissingImages(root = document) { root.querySelectorAll('img[data-failure="missing"], img[data-failure="moved-missing"]').forEach(loadImage); }
export async function waitForImages(root, { allowPlaceholders = false } = {}) {
  const until = Date.now() + 16000;
  while ([...root.querySelectorAll('img[data-resource]')].some(img => img.dataset.loaded === 'pending')) {
    if (Date.now() > until) throw new Error(t("resources.the_image_is_still_loading_try_again"));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // A format this platform cannot decode is exported as its placeholder: the
  // file is intact and the reader can find it. A missing or damaged file would
  // export a document whose gap is invisible, so that still stops the export.
  if (!allowPlaceholders && root.querySelector('img[data-failure="missing"], img[data-failure="broken"]')) throw new Error(t("resources.some_images_could_not_be_loaded_check"));
}
export function markdownLink(label, path, image = false) {
  const url = image ? safeTarget(path, true) : safeLinkTarget(path); if (!url) throw new Error(t("resources.enter_a_web_address_email_address_heading"));
  return `${image ? '!' : ''}[${label.replace(/[\\\[\]]/g, '\\$&').replace(/\r?\n/g, ' ')}](${url.replace(/[()]/g, c => c === '(' ? '%28' : '%29')})`;
}
