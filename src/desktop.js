import { createDocumentSession } from './document-session.js';
import {localResourcePaths} from './resource-paths.js';
import { fileNameFromPath } from './file-path.js';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { confirmDocumentClose } from './close-document-dialog.js';
import { open, save } from '@tauri-apps/plugin-dialog';

export const desktop = isTauri();
const filters = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown'] }];
let session;
let draftTimer;
let closing = false;
let hooks;

function rememberDesktopFile(file) {
  try {
    const previous=JSON.parse(localStorage.getItem('leaf-desktop-recent')||'[]');
    localStorage.setItem('leaf-desktop-recent',JSON.stringify([{path:file,name:fileNameFromPath(file)},...previous.filter(item=>item.path!==file)].slice(0,8)));
  } catch { /* Recent history must not block opening or saving. */ }
}

export async function desktopOpen() {
  const selected = await open({ multiple: true, filters });
  for (const file of selected ? (Array.isArray(selected) ? selected : [selected]) : []) {
    await invoke('open_document', { path: file });
  }
}

let creatingDocument = false;
export async function desktopNew() {
  if (creatingDocument) return;
  creatingDocument = true;
  try {
    const path = await save({defaultPath: '未命名.md', filters});
    if (path) {
      await invoke('new_document', {path});
      await invoke('open_document', {path});
    }
  } finally { creatingDocument = false; }
}

export function desktopSave(as = false, manual = true) {
  return session?.save({ as, manual }) ?? Promise.resolve(false);
}
export function desktopRename(name) { return session.rename(name); }
export function desktopRun(action) { return session.run(action); }
export async function chooseAttachments(image) { return open({ multiple: true, ...(image ? { filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }] } : {}) }); }
export async function desktopExportBundle() {
  if (!session?.path && !await session.save()) return null;
  const directory = await open({directory:true,multiple:false,title:'选择导出文件夹'});
  if (!directory) return null;
  return session.run(() => {
    const content=hooks.content();
    return invoke('export_bundle',{directory,content,resources:localResourcePaths(content)});
  });
}
export function desktopHasPath() { return !!session?.path; }
export function desktopRecoveryPaused() { return !!session?.paused; }
export function desktopEdited() {
  session?.edited();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => session?.checkpoint().catch(error => hooks.status(`草稿保护失败：${error}`, 'error')), 250);
}
export function desktopRestore(content) { return session.restore(content); }

async function closeDocument() {
  if (closing) return;
  closing = true;
  try {
    clearTimeout(draftTimer);
    await session?.idle();
    if (session?.ready) {
      try { await session.checkpoint(); }
      catch (error) { hooks.status(`草稿保护失败：${error}`, 'error'); }
    }
    if (hooks.dirty()) {
      const choice = await confirmDocumentClose(session?.path ? fileNameFromPath(session.path) : '未命名文档');
      if (choice === 'cancel') return;
      if (choice === 'save') {
        if (!await desktopSave() || hooks.dirty()) return;
      }
    }
    await getCurrentWindow().destroy();
  } finally { closing = false; }
}

export async function initDesktop(callbacks) {
  hooks = callbacks;
  session = createDocumentSession({
    content: hooks.content, status: hooks.status,
    load: (content, source) => hooks.load(content, source ? fileNameFromPath(source) : '未命名.md', source),
    restore: hooks.restore,
    select: path => save({ defaultPath: path || '未命名.md', filters }),
    read: path => invoke('read_document', { path }),
    async readTarget(path) { try { return await invoke('read_document', { path }); } catch { return null; } },
    rename: (path,name,expected,content) => invoke('rename_document',{path,name,expected,content}),
    renamed(content,path,previous) {
      try { const items=JSON.parse(localStorage.getItem('leaf-desktop-recent')||'[]');localStorage.setItem('leaf-desktop-recent',JSON.stringify(items.filter(x=>x.path!==previous))); } catch {}
      rememberDesktopFile(path);hooks.saved(content,fileNameFromPath(path),path);
    },
    write: (path, content, expected) => invoke('write_document', { path, content, expected, resources: localResourcePaths(content) }),
    checkpoint: (content, preserve = false) => invoke('recovery_checkpoint', { content, preserve }),
    saved(content, path) { rememberDesktopFile(path); hooks.saved(content, fileNameFromPath(path), path); },
  });
  const window = getCurrentWindow();
  await window.onCloseRequested(event => { event.preventDefault(); void closeDocument(); });
  await listen('leaf-close', closeDocument);
  await window.listen('leaf-native-rename',({payload})=>hooks.renameNative?.(payload));
  await window.listen('leaf-menu', async ({ payload }) => {
    if (payload === 'new') {
      try { await desktopNew(); } catch (error) { hooks.status(`新建失败：${error}`, 'error'); }
    }
    if (payload === 'open') await desktopOpen();
    if (payload === 'save') await desktopSave();
    if (payload === 'save-as') await desktopSave(true);
    if (payload === 'find') hooks.find();
    if (payload === 'settings') hooks.settings?.();
    if (payload === 'copy-rich') hooks.copyRich?.();
    if (payload === 'paste-plain') hooks.pastePlain?.();
    if (payload === 'recovery') hooks.recovery();
    if (payload === 'export-pdf') hooks.exportPdf();
    if (payload === 'rename') hooks.rename?.();
    if (payload === 'cycle-mode') hooks.cycleMode?.();
    if (payload === 'undo') hooks.undo?.();
    if (payload === 'redo') hooks.redo?.();
  });
  await window.onDragDropEvent(async ({ payload }) => {
    hooks.drag?.(payload.type==='enter'||payload.type==='over');
    if (payload.type === 'drop') {
      const docs = payload.paths.filter(path => /\.(md|markdown|mdown)$/i.test(path));
      for (const file of docs) await invoke('open_document', { path: file });
      const attachments = payload.paths.filter(path => !docs.includes(path));
      if (attachments.length) await hooks.attach?.(attachments, payload.position);
    }
  });
  const path = await invoke('initial_path');
  if (path) {
    try {
      const content = await invoke('read_document', { path });
      await session.initialize(path, content);
      rememberDesktopFile(path);
    } catch (error) {
      // A failed load never binds an empty/welcome buffer to the failed path.
      await session.initialize(null, '');
      hooks.status(`打开失败：${error}`, 'error');
    }
  } else if (location.search.includes('document=1')) {
    await session.initialize(null, '');
    const recovered = await invoke('recovery_initial');
    if (recovered !== null) await session.restore(recovered);
  }
  let recoveryRequest = 0;
  async function refreshRecoveryNotice() {
    const token = ++recoveryRequest;
    if (!session.path) { hooks.recoveryAvailable?.(false); return; }
    try {
      const versions = await invoke('recovery_list', { drafts: false });
      if (token === recoveryRequest) hooks.recoveryAvailable?.(versions.some(v => v.kind === 'draft'));
    } catch (error) { hooks.status(`恢复记录读取失败：${error}`, 'error'); }
  }
  document.addEventListener('leaf-recovery-changed', refreshRecoveryNotice);
  globalThis.addEventListener('focus', refreshRecoveryNotice);
  await refreshRecoveryNotice();
  await listen('leaf-retention-days',({payload})=>document.dispatchEvent(new CustomEvent('leaf-retention-days',{detail:payload})));
  try { document.dispatchEvent(new CustomEvent('leaf-retention-days',{detail:await invoke('recovery_retention')})); }
  catch(error){hooks.status(`恢复时限设置读取失败：${error}`,'error');}
  const expire=()=>invoke('recovery_expire').catch(error=>hooks.status(`恢复记录自动清理失败：${error}`,'error'));
  await expire();
  setInterval(expire,60*60*1000);
  setInterval(() => { void session.poll(); }, 3000);
}

export function desktopTitle(title) { if (desktop) void getCurrentWindow().setTitle(title); }
