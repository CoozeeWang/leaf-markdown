let readLocal = null;
export function setResourceReader(reader) { readLocal = reader; refreshImages(); }
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
function mime(data) {
  if (data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  const ascii = String.fromCharCode(...data.slice(0, 12));
  if (ascii.startsWith('GIF8')) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.endsWith('WEBP')) return 'image/webp';
  if (ascii.startsWith('BM')) return 'image/bmp';
  throw new Error('图片格式不支持或内容损坏');
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
  try {
    const target = safeTarget(img.dataset.resource, true); if (!target) throw new Error('图片路径不支持');
    let url = target, revoke = false;
    if (!/^https?:/i.test(target)) {
      if (!readLocal) throw new Error('本地图片需在桌面版打开');
      const bytes = new Uint8Array(await readLocal(decodeURIComponent(target)));
      url = URL.createObjectURL(new Blob([bytes], { type: mime(bytes) })); revoke = true;
    }
    try {
      if (img._resourceToken !== token) return;
      img.src = url;
      await Promise.race([img.decode(), new Promise((_, reject) => setTimeout(() => reject(new Error('图片加载超时')), 15000))]);
      if (img._resourceToken !== token) return;
      img.hidden = false; status.textContent = ''; img.dataset.loaded = 'yes';
    } finally { if (revoke) URL.revokeObjectURL(url); }
  } catch (error) {
    if (img._resourceToken !== token) return;
    status.textContent = `图片无法加载：${img.alt || img.dataset.resource}（${error.message || error}）`; img.dataset.loaded = 'error';
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
  if (root.querySelector('img[data-loaded="error"]')) throw new Error('有图片无法加载，请修正路径后导出');
}
export function markdownLink(label, path, image = false) {
  const url = safeTarget(path, image); if (!url) throw new Error('请输入网页、邮件、标题锚点或文档目录内的相对路径');
  return `${image ? '!' : ''}[${label.replace(/[\\\[\]]/g, '\\$&').replace(/\r?\n/g, ' ')}](${url.replace(/[()]/g, c => c === '(' ? '%28' : '%29')})`;
}
