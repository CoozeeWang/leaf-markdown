import { t, message as translatedMessage } from './i18n.js';
import { createDocumentSession } from './document-session.js';
import {createUpdateParticipant,requireNativeStatus} from './update-participant.js';
import {localResourcePaths} from './resource-paths.js';
import { fileNameFromPath } from './file-path.js';
import { isWindowsNewShortcut } from './platform-shortcuts.js';
import { nativeDropPoint } from './native-drop-point.js';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { confirmDocumentClose } from './close-document-dialog.js';
import { open, save } from '@tauri-apps/plugin-dialog';

export const desktop = isTauri();
const filters = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown'] }];
let session,participant,participantFactory,participantReady=false,prepareTest=false;
let prepareTrace=[];
function recordPrepare(stage){
  if(!prepareTest)return;
  prepareTrace.push({stage,...hooks.traceUpdate?.()});
  if(prepareTrace.length>64)prepareTrace.shift();
}
let draftTimer;
let closing = false;
let closingQuitId = null;
let hooks;
let restoreQueue=Promise.resolve(),restoreContext=null;

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
    const path = await save({defaultPath: t("desktop.untitled_md"), filters});
    if (path) {
      await invoke('new_document', {path});
      await invoke('open_document', {path});
    }
  } finally { creatingDocument = false; }
}

export async function desktopTestPrepare(action) {
  if(!prepareTest)throw Error('test_disabled');
  if(action==='dispose')participant.dispose();
  if(action==='restart'){participant.dispose();participant=participantFactory();await participant.start();}
  if(action==='reconcile')await participant.reconcile();
  if(action==='settle-released'){
    await participant.reconcile({runPending:false});
    if(participant.preparing)throw Error('update_prepare_stale');
    for(;;){
      const pending=session.idle(),restoring=restoreQueue;
      await Promise.all([pending,restoring.catch(()=>{})]);
      if(pending===session.idle()&&restoring===restoreQueue)break;
    }
    await participant.reconcile({runPending:false});
    if(participant.preparing)throw Error('update_prepare_stale');
  }
  return {preparing:participant.preparing,activeId:participant.activeId,manual_driver:participant.manualDriver,path:session.path,trace:prepareTrace};
}
export function desktopPreparing() { return participant?.preparing ?? false; }
export async function desktopParticipantReady() {
  if(!participant)return;participantReady=true;await participant.ready();
}
export function desktopSave(as = false, manual = true) {
  if(desktopPreparing())return Promise.resolve(false);
  return session?.save({ as, manual }) ?? Promise.resolve(false);
}
export function desktopPrepareSave(transaction) { return createUpdateParticipant({session}).save(transaction); }
export function desktopAiApplied(receipt) { session?.aiApplied(receipt); }
export function desktopFileState() { return session ? {path:session.path,paused:session.paused,aiEditResult:session.aiEditResult} : null; }
export function desktopRename(name) { return session.rename(name); }
export function desktopRelocate() { return session?.relocate() ?? Promise.resolve(false); }
export function desktopRun(action) { return desktopPreparing()?Promise.reject(Error('document_locked')):session.run(action); }
export async function chooseAttachments(image) { return open({ multiple: true, ...(image ? { filters: [{ name: t("desktop.images"), extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "svg"] }] } : {}) }); }
export async function desktopExportBundle() {
  if (!session?.path && !await session.save()) return null;
  const directory = await open({directory:true,multiple:false,title:t("desktop.choose_export_folder")});
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
  if(desktopPreparing())return;
  draftTimer = setTimeout(() => session?.checkpoint().catch(error => hooks.status(translatedMessage("desktop.could_not_protect_the_draft", {"error": error}), 'error')), 250);
}
export function desktopRestore(content,context=hooks.captureMutation()) {
  if (desktopPreparing()||!hooks.mutationAllowed()) return Promise.reject(new Error('document_locked'));
  const operation=restoreQueue.catch(()=>{}).then(async()=>{
    hooks.assertMutationCurrent(context);restoreContext=context;
    try {return await session.restore(content);}finally{restoreContext=null;}
  });
  restoreQueue=operation;return operation;
}

async function closeDocument(quitId = null) {
  if (Number.isSafeInteger(quitId) && quitId > 0) closingQuitId = quitId;
  if (closing||participant?.manualDriver) return;
  closing = true;
  let destroyed = false,action=null;
  try {
    action=await invoke('update_close_disposition');
    if(!action.allowed)return;
    await invoke('mcp_document_boundary',{reason:'close',closeActionId:action.action_id});
    clearTimeout(draftTimer);
    await session?.idle();
    if (session?.ready) {
      try { await session.checkpoint(); }
      catch (error) { hooks.status(translatedMessage("desktop.could_not_protect_the_draft", {"error": error}), 'error'); }
    }
    if (hooks.dirty()) {
      const choice = await confirmDocumentClose(session?.path ? fileNameFromPath(session.path) : t("desktop.untitled_document"));
      if (choice === 'cancel') return;
      if (choice === 'save') {
        if (!await desktopSave() || hooks.dirty()) return;
      }
    }
    await getCurrentWindow().destroy();
    destroyed = true;
  } catch(error) {
    if(!['update_prepare_cancelled','update_commit_in_progress'].includes(String(error)))hooks.status(String(error),'error');
  } finally {
    if(!destroyed&&action)await invoke('update_close_complete',{actionId:action.action_id,windowNonce:action.window_nonce}).catch(()=>{});
    const completedQuit = closingQuitId;
    closingQuitId = null;
    if (!destroyed && completedQuit !== null) {
      // Native validates both this actual window and the current quit generation.
      await invoke('ordinary_quit_cancelled', { quitId: completedQuit }).catch(() => {});
    }
    closing = false;
    // A later Quit arriving during the cancellation acknowledgement is a new action.
    if (!destroyed && closingQuitId !== null) void closeDocument(closingQuitId);
  }
}

export async function initDesktop(callbacks) {
  hooks = callbacks;
  // Reset a previously registered renderer before reading its durable file.
  // Native invalidates update authority first and waits for owned I/O to finish.
  if(location.search.includes('document=1'))requireNativeStatus(await invoke('update_participant_status',{protocolReady:false}));
  globalThis.window.addEventListener('keydown', event => {
    if (!isWindowsNewShortcut(event)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void desktopNew().catch(error => hooks.status(translatedMessage("desktop.could_not_create_the_document", {error}), 'error'));
  }, true);
  // Import the former per-WebView list once. Keep the old copy as a migration
  // fallback because development and installed WebViews can share storage.
  try {
    const items = JSON.parse(localStorage.getItem('leaf-desktop-recent') || '[]');
    await invoke('recent_import', { items: Array.isArray(items) ? items.filter(item => typeof item.path === 'string' && typeof item.name === 'string') : [] });
  } catch (error) { console.warn('Recent-file migration failed', error); }
  session = createDocumentSession({
    localizedMessages: true,
    content: hooks.content, status: hooks.status,
    saveContext:hooks.saveContext,
    aiActive:()=>!hooks.mutationAllowed(),
    aiConflict:()=>invoke('mcp_document_boundary',{reason:'external-conflict'}),
    aiSaveResult:async result=>{
      const context=result.saveContext ?? hooks.saveContext?.();
      if(context?.session_id && result.diskResult.state!=='saved')await invoke('mcp_save_result',{sessionId:context.session_id,revision:context.revision,checkpoint:result.checkpoint.state==='protected',failed:result.diskResult.state==='failed'});
    },
    load: (content, source) => hooks.load(content, source ? fileNameFromPath(source) : t("desktop.untitled_md"), source),
    restore:(content,transaction)=>hooks.restore(content,restoreContext,transaction),
    select: (path,transaction) => {
      if(prepareTest&&transaction){recordPrepare('selector_after_native_focus');return invoke('update_test_prepare_select',{prepareId:transaction.prepare_id});}
      return save({ defaultPath: path || t("desktop.untitled_md"), filters });
    },
    selectExisting: () => open({ multiple: false, filters, title: t("desktop.locate_original_file") }),
    relocate: (path, expected) => invoke('relocate_document', { path, expected, loadedImages: hooks.loadedImages?.() ?? [] }),
    unavailableActions: () => [
      { get label() { return t("desktop.locate_original_file"); }, run: desktopRelocate },
      { get label() { return t("desktop.save_as"); }, run: () => desktopSave(true) },
    ],
    read: path => invoke('read_document', { path }),
    observe: () => invoke('observe_document', { loadedImages: hooks.loadedImages?.() ?? [] }),
    async readTarget(path) { try { return await invoke('read_document', { path }); } catch { return null; } },
    rename: (path,name,expected,content) => invoke('rename_document',{path,name,expected,content}),
    renamed(content,path,previous) {
      hooks.saved(content,fileNameFromPath(path),path);
    },
    followed(content,path,previous,movedImages) {
      hooks.followed?.(content,fileNameFromPath(path),path,movedImages);
    },
    write: (path, content, expected,saveBinding,transaction) => invoke('write_document', { path, content, expected,prepareId:transaction?.prepare_id ?? null,saveBinding:saveBinding ? {session_id:saveBinding.session_id,document_id:saveBinding.document_id,revision:saveBinding.revision} : null, resources: localResourcePaths(content) }),
    checkpoint: (content, preserve = false,transaction) => invoke('recovery_checkpoint', { content, preserve,prepareId:transaction?.prepare_id ?? null }),
    saved(content, path) { hooks.saved(content, fileNameFromPath(path), path); },
  });
  const window = getCurrentWindow();
  // Only native document windows own save prompts and update close actions.
  // The empty launcher keeps the OS close path and never requests document IPC.
  if (window.label.startsWith('document-')) {
    await window.onCloseRequested(event => { event.preventDefault(); void closeDocument(); });
    await window.listen('leaf-close', ({ payload }) => { void closeDocument(payload?.quit_id); });
  }
  await window.listen('leaf-native-rename',({payload})=>hooks.renameNative?.(payload));
  await window.listen('leaf-menu', async ({ payload }) => {
    const command=typeof payload==='string'?payload:payload.command;
    if (['cut','paste','paste-plain','add-comment','undo','redo','recovery'].includes(command) && typeof payload!=='string' && !hooks.menuCurrent(payload.binding))return;
    if (['cut','paste','paste-plain','add-comment','undo','redo','recovery'].includes(command) && !hooks.mutationAllowed()) return;
    payload=command;
    if (payload === 'new') {
      try { await desktopNew(); } catch (error) { hooks.status(translatedMessage("desktop.could_not_create_the_document", {"error": error}), 'error'); }
    }
    if (payload === 'open') await desktopOpen();
    if (payload === 'save') await desktopSave();
    if (payload === 'save-as') await desktopSave(true);
    if (payload === 'reveal-document') await hooks.reveal?.();
    if (payload === 'find') hooks.find();
    if (payload === 'settings') hooks.settings?.();
    if (payload === 'copy-rich') hooks.copyRich?.();
    if (payload === 'paste-plain') hooks.pastePlain?.();
    if (payload === 'add-comment') hooks.addComment?.();
    if (payload === 'recovery') hooks.recovery();
    if (payload === 'export-pdf') hooks.exportPdf();
    if (payload === 'rename') hooks.rename?.();
    if (payload === 'cycle-mode') hooks.cycleMode?.();
    if (payload === 'undo') hooks.undo?.();
    if (payload === 'redo') hooks.redo?.();
    if (payload === 'cut' || payload === 'paste') hooks.clipboard?.(payload);
  });
  let draggedPaths=[];
  await window.onDragDropEvent(async ({ payload }) => {
    if(payload.paths)draggedPaths=payload.paths;
    const point=nativeDropPoint(payload.position);
    hooks.drag?.(payload.type==='enter'||payload.type==='over', point,draggedPaths);
    if(payload.type==='leave'||payload.type==='drop')draggedPaths=[];
    if (payload.type === 'drop') {
      const docs = payload.paths.filter(path => /\.(md|markdown|mdown)$/i.test(path));
      for (const file of docs) await invoke('open_document', { path: file });
      const attachments = payload.paths.filter(path => !docs.includes(path));
      if (attachments.length) await hooks.attach?.(attachments, point);
    }
  });
  const path = await invoke('initial_path');
  if (path) {
    try {
      const observed = await invoke('observe_document', { loadedImages: [] });
      await session.initialize(observed.path, observed.content);
    } catch (error) {
      // A failed load never binds an empty/welcome buffer to the failed path.
      await session.initialize(null, '');
      hooks.status(translatedMessage("desktop.could_not_open_the_document", {"error": error}), 'error');
    }
  } else if (location.search.includes('document=1')) {
    await session.initialize(null, '');
    const recovered = await invoke('recovery_initial');
    if (recovered !== null) await session.restore(recovered);
  }
  if(session.ready){
    prepareTest=await invoke('update_test_prepare_mode').catch(()=>false);
    participantFactory=()=>createUpdateParticipant({session,invoke,listen:(name,handler)=>window.listen(name,handler),
      editor:{settle:()=>hooks.settleUpdate(),
        freeze:id=>{recordPrepare('before_freeze');hooks.freezeUpdate(id);recordPrepare('after_freeze');},
        release:id=>{recordPrepare('before_release');hooks.releaseUpdate(id);recordPrepare('after_release');}},
      pause:id=>{recordPrepare('begin');clearTimeout(draftTimer);hooks.pauseUpdate(id);},
      resume:id=>hooks.resumeUpdate(id),
      beforeSave:()=>window.setFocus(),
      async drain(){
        // Producers are paused before reading queues. Await the actual queue
        // identities until no already admitted callback added more work.
        for(;;){
          const pending=session.idle(),restoring=restoreQueue;
          await Promise.all([pending,restoring.catch(()=>{})]);
          if(pending===session.idle()&&restoring===restoreQueue)return;
        }
      },
      watch:callback=>{const timer=setInterval(callback,1000);return()=>clearInterval(timer);},
      error:error=>{if(String(error?.message||error)!=='update_prepare_stale')console.warn('Document preparation did not complete');},
    });
    participant=participantFactory();
    // Native snapshot requests need main's existing MCP listener/registration.
    // Listeners attach now; ready() is called only after that bridge is ready.
    await participant.start({protocolReady:false});
    globalThis.addEventListener('focus',()=>{if(participantReady)void participant.reconcile().catch(()=>{});});
    globalThis.addEventListener('pageshow',()=>{if(participantReady)void participant.reconcile().catch(()=>{});});
    globalThis.addEventListener('pagehide',()=>participant.dispose(),{once:true});
  }
  let recoveryRequest = 0;
  async function refreshRecoveryNotice() {
    const token = ++recoveryRequest;
    if (!session.path) { hooks.recoveryAvailable?.(false); return; }
    try {
      const versions = await invoke('recovery_list', { drafts: false });
      if (token === recoveryRequest) hooks.recoveryAvailable?.(versions.some(v => v.kind === 'draft'));
    } catch (error) { hooks.status(translatedMessage("desktop.could_not_read_recovery_records", {"error": error}), 'error'); }
  }
  document.addEventListener('leaf-recovery-changed', refreshRecoveryNotice);
  globalThis.addEventListener('focus', refreshRecoveryNotice);
  globalThis.addEventListener('focus', () => hooks.retryMissingImages?.());
  await refreshRecoveryNotice();
  await listen('leaf-retention-days',({payload})=>document.dispatchEvent(new CustomEvent('leaf-retention-days',{detail:payload})));
  try { document.dispatchEvent(new CustomEvent('leaf-retention-days',{detail:await invoke('recovery_retention')})); }
  catch(error){hooks.status(translatedMessage("desktop.could_not_read_the_recovery_retention_setting", {"error": error}),'error');}
  const expire=()=>desktopPreparing()?Promise.resolve():invoke('recovery_expire').catch(error=>hooks.status(translatedMessage("desktop.could_not_automatically_clean_up_recovery_records", {"error": error}),'error'));
  await expire();
  setInterval(expire,60*60*1000);
  setInterval(() => { if(!desktopPreparing())void session.poll(); }, 3000);
}

export function desktopTitle(title) { if (desktop) void getCurrentWindow().setTitle(title); }

export async function desktopRevealDocument() {
  const platform = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '';
  if (desktop && /win/i.test(platform) && new URLSearchParams(location.search).get('document') === '1') {
    const window = getCurrentWindow();
    await window.show();
    await window.setFocus();
  }
}
