import { uiIcon } from './ui-icons.js';
let readLocal = null;
let revealLocal = null;
export function setResourceReader(reader) { readLocal = reader; refreshImages(); }
export function setResourceRevealer(revealer) { revealLocal = revealer; }
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
  throw new Error('不支持的图片格式');
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
function platformName() {
  const ua = navigator.userAgent || '';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return '当前平台';
}
// Four different things go wrong and each needs its own sentence: a format this
// platform cannot decode, a format Leaf does not recognise, a file that is no
// longer there, and bytes that are damaged. The note answers what happens next
// or reassures that nothing was lost -- never how loading works.
function failureText(kind, target) {
  const file = fileNameOf(target);
  const ext = (file.match(/\.([^.]+)$/)?.[1] || '').toUpperCase();
  if (kind === 'unsupported-here') return [`无法预览 ${ext} 图片：${file}`, `${platformName()} 版暂不支持这个格式，图片已存入文档旁的 assets 目录`];
  if (kind === 'format') return [`无法预览：${file}`, '暂不支持这个图片格式，转换成 PNG 或 JPEG 后可显示'];
  if (kind === 'missing') return [`找不到图片：${file}`, '文件可能已被移动、重命名或删除'];
  if (kind === 'desktop') return [`无法预览：${file}`, '本地图片需在桌面版打开'];
  if (kind === 'path') return [`无法预览：${file}`, '这个图片路径不受支持'];
  return [`无法加载：${file}`, '图片内容可能已损坏，或读取超时'];
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
  title.className = 'leaf-image-status-head'; title.textContent = head;
  const detail = document.createElement('span');
  detail.className = 'leaf-image-status-note'; detail.textContent = note;
  const lines = document.createElement('span');
  lines.append(title, detail);
  card.append(icon, lines);
  const relative = decodedPath(img.dataset.resource);
  if (!revealLocal || /^https?:/i.test(relative)) return;
  const name = fileNameOf(img.dataset.resource);
  card.dataset.clickable = 'yes';
  card.title = '在文件管理器中显示';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `在文件管理器中显示 ${name}`);
  const open = () => {
    void revealLocal(relative).catch(() => {
      img.dispatchEvent(new CustomEvent('leaf-image-reveal-failed', { bubbles: true, detail: name }));
    });
  };
  card.addEventListener('click', open);
  card.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault(); open();
  });
}
export function imageNode(alt, path) {
  const holder = document.createElement('span'); holder.className = 'leaf-image';
  const img = document.createElement('img'); img.alt = alt; img.dataset.resource = path;
  img.referrerPolicy = 'no-referrer';
  const status = document.createElement('span'); status.className = 'leaf-image-status';
  holder.append(img, status); loadImage(img); return holder;
}
export async function loadImage(img) {
  const token = {}; img._resourceToken = token;
  const status = img.parentElement.querySelector('.leaf-image-status');
  status.textContent = '图片加载中…'; img.hidden = true; img.dataset.loaded = 'pending';
  delete img.dataset.failure;
  try {
    const target = safeTarget(img.dataset.resource, true); if (!target) throw fail('path');
    const local = !/^https?:/i.test(target);
    if (local && !readLocal) throw fail('desktop');
    let url = target, revoke = false, type = '';
    if (local) {
      let bytes;
      try { bytes = new Uint8Array(await readLocal(decodeURIComponent(target))); }
      catch { throw fail('missing'); }
      try { type = mime(bytes); }
      catch { throw fail('format'); }
      url = URL.createObjectURL(new Blob([bytes], { type })); revoke = true;
    }
    try {
      if (img._resourceToken !== token) return;
      img.src = url;
      await Promise.race([img.decode(), new Promise((_, reject) => setTimeout(() => reject(new Error('图片加载超时')), 15000))]);
      if (img._resourceToken !== token) return;
      img.hidden = false; status.textContent = ''; img.dataset.loaded = 'yes';
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
export async function waitForImages(root) {
  const until = Date.now() + 16000;
  while ([...root.querySelectorAll('img[data-resource]')].some(img => img.dataset.loaded === 'pending')) {
    if (Date.now() > until) throw new Error('图片仍在加载，请稍后重试');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // A format this platform cannot decode is exported as its placeholder: the
  // file is intact and the reader can find it. A missing or damaged file would
  // export a document whose gap is invisible, so that still stops the export.
  if (root.querySelector('img[data-failure="missing"], img[data-failure="broken"]')) throw new Error('有图片无法加载，请修正路径后导出');
}
export function markdownLink(label, path, image = false) {
  const url = safeTarget(path, image); if (!url) throw new Error('请输入网页、邮件、标题锚点或文档目录内的相对路径');
  return `${image ? '!' : ''}[${label.replace(/[\\\[\]]/g, '\\$&').replace(/\r?\n/g, ' ')}](${url.replace(/[()]/g, c => c === '(' ? '%28' : '%29')})`;
}
