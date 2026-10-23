import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { t, onLanguageChange } from './i18n.js';
import { mergeUpdateSnapshot } from './update-state.js';
import { splitUpdateResult } from './update-result.js';
import './style.css';
import './update-window.css';

document.body.classList.add('update-window');
const app = document.querySelector('#app');
// Static markup only: remote, native and localized values always use textContent.
app.innerHTML = '<header><h1></h1><p id="update-version"></p></header><main id="update-content"><section aria-live="polite" aria-atomic="true"><h2 id="update-result" tabindex="-1"></h2><p id="update-message"></p><p id="update-recovery-location" hidden></p><p id="update-error"></p></section><div id="update-progress" hidden><progress aria-hidden="true"></progress><p id="update-progress-text"></p></div><button id="update-cancel-download" class="text-action" hidden></button><details hidden><summary></summary><pre id="update-notes"></pre></details></main><footer id="update-footer"><button id="update-releases" class="text-action"></button><span class="update-actions"><button id="update-close"></button><button id="update-action" class="primary"></button></span></footer>';
const find = id => document.getElementById(id), action = find('update-action');
const busy = new Set(['checking','downloading','verifying','preparing','committing']);
const confirms = new Set(['available','download_failed','ready','prepare_failed','install_failed']);
const resumes = new Set(['ready','prepare_failed','install_failed']);
const actions = {idle:'check',checking:'checking',current:'check_again',available:'start',no_package:'check_again',check_failed:'retry',downloading:'download_busy',verifying:'verifying',download_failed:'retry_update',ready:'resume',preparing:'preparing',prepare_failed:'retry_prepare',committing:'committing',install_failed:'retry_update',rolled_back:'check_again',rollback_failed:'releases',installed:'check'};
const errors = {update_timeout:'error_timeout',update_rate_limited:'error_rate_limit',update_prepare_timeout:'error_prepare_timeout',update_mcp_busy:'error_mcp_busy',update_save_failed:'prepare_failed',update_download_unavailable:'error_download_unavailable',update_prepare_unavailable:'error_prepare_unavailable',update_signature_invalid:'error_signature',update_package_invalid:'error_signature',update_cancelled:'prepare_failed',update_signing_identity_pending:'error_identity_pending',update_identity_invalid:'error_identity_pending'};
const recoveredInstallFailure = () => snapshot?.state === 'install_failed' && !snapshot.candidate_id;
const manualInstallation = () => ['update_signing_identity_pending','update_identity_invalid'].includes(snapshot?.error_code);
let snapshot = null, pending = false, closePending = false, confirmation = null, nativePanel = false, localError = null;
const tracing = new URLSearchParams(location.search).has('updateTracer');
function text(element,value) {if(element.textContent!==value) element.textContent=value;}
function theme() {
  const value = localStorage.getItem('leaf-theme') || 'system';
  document.documentElement.dataset.theme = value === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : value;
}
theme();
window.addEventListener('storage', e => {if(e.key === 'leaf-theme') theme();});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',theme);
function render() {
  if(!snapshot) {
    document.querySelector('h1').textContent=t('updates.title');
    find('update-version').textContent=t('updates.version',{version:t('updates.unknown_version')});
    find('update-releases').textContent=t('updates.releases');find('update-close').textContent=t('updates.close');
    action.textContent=t('updates.retry');action.disabled=pending;
    return;
  }
  const state = snapshot.state, version = snapshot.target_version || t('updates.unknown_version');
  app.dataset.updateState = state; app.dataset.stateRevision = snapshot.state_revision;
  document.querySelector('h1').textContent = t('updates.title');
  find('update-version').textContent = t('updates.version',{version:snapshot.installed_version});
  const result=t('updates.'+(actions[state] ? state : 'check_failed'),{version});
  const resultCopy=['install_failed','rolled_back','rollback_failed'].includes(state)?splitUpdateResult(result):{title:result,detail:''};
  text(find('update-result'),resultCopy.title);
  text(find('update-message'),resultCopy.detail || (
    state === 'available' ? t('updates.target',{version}) :
    state === 'current' ? t('updates.current_help',{version:snapshot.installed_version}) :
    ['ready','downloading','no_package','check_failed'].includes(state) ? t('updates.'+state+'_help',{version}) :
    confirms.has(state) && !snapshot.target_version ? t('updates.missing_candidate') : ''));
  const recovery=['install_failed','rollback_failed'].includes(state) && typeof snapshot.recovery_location==='string' ? snapshot.recovery_location : '';
  find('update-recovery-location').hidden=!recovery;
  text(find('update-recovery-location'),recovery?t('updates.recovery_location',{path:recovery}):'');
  const code = manualInstallation() ? snapshot.error_code : resultCopy.detail && !localError ? null : localError || snapshot.error_code;
  find('update-error').hidden = !code;
  text(find('update-error'),code ? t('updates.'+(['install_failed','rolled_back','rollback_failed'].includes(state) ? 'error_after_exit' : errors[code] || (state === 'check_failed' ? 'check_failed_help' : 'error_generic'))) : '');
  document.querySelector('details').hidden = !snapshot.target_version && !confirms.has(state);
  document.querySelector('summary').textContent = t('updates.notes');
  find('update-notes').textContent = snapshot.notes || t('updates.no_notes');
  find('update-releases').textContent = t('updates.releases');
  find('update-close').textContent = t(state === 'preparing' ? 'updates.cancel_prepare' : 'updates.close');
  find('update-close').disabled = state === 'committing' || closePending || nativePanel;
  find('update-cancel-download').hidden = state !== 'downloading';
  find('update-cancel-download').textContent = t('updates.cancel_download');
  find('update-cancel-download').disabled = pending;
  action.textContent = t('updates.'+(manualInstallation() ? 'releases' : recoveredInstallFailure() ? 'check_again' : actions[state] || 'retry'));
  action.disabled = pending || busy.has(state) || (!manualInstallation() && !recoveredInstallFailure() && confirms.has(state) && !snapshot.candidate_id);
  const progress = find('update-progress'), meter = progress.querySelector('progress');
  progress.hidden = !['downloading','verifying','preparing'].includes(state);
  const received = Number.isSafeInteger(snapshot.downloaded_bytes) && snapshot.downloaded_bytes >= 0 ? snapshot.downloaded_bytes : 0;
  const total = Number.isSafeInteger(snapshot.total_bytes) && snapshot.total_bytes > 0 ? snapshot.total_bytes : null;
  if(state === 'downloading' && total && received <= total) {meter.max=total;meter.value=received;} else meter.removeAttribute('value');
  // Chunk/byte updates are outside the live region to avoid repeated announcements.
  find('update-progress-text').textContent = state === 'downloading' ? t(total ? 'updates.bytes_total' : 'updates.bytes_received',{received,total}) :
    state === 'preparing' && Number.isSafeInteger(snapshot.prepared_documents) && Number.isSafeInteger(snapshot.total_documents) ? t('updates.documents_prepared',{done:snapshot.prepared_documents,total:snapshot.total_documents}) : '';
  if(confirmation && (confirmation.revision !== snapshot.state_revision || confirmation.candidate !== snapshot.candidate_id)) dismiss();
  if(tracing && !pending) void invoke('update_test_observe',{revision:snapshot.state_revision,state,editorLoaded:!!document.querySelector('.cm-editor'),title:find('update-result').textContent}).catch(()=>{});
}
function merge(next) {
  const value=mergeUpdateSnapshot(snapshot,next);
  if(value === snapshot) return;
  snapshot=value;localError=null;render();
}
async function request(command,args={}) {
  if(pending || nativePanel) return;
  pending=true;localError=null;render();
  try {merge(await invoke(command,args));}
  catch {
    // A lost/rejected reply can follow an accepted native action. Reconcile before retry.
    try {merge(await invoke('update_status'));} catch { /* Keep the last native snapshot. */ }
    localError='update_request_failed';
  }
  finally {pending=false;render();}
}
function dismiss() {
  if(!confirmation) return;
  const {backdrop,trigger}=confirmation;confirmation=null;backdrop.remove();app.inert=false;
  if(trigger.isConnected && !trigger.disabled) trigger.focus(); else find('update-result').focus();
}
function confirm() {
  if(confirmation || pending || nativePanel || manualInstallation() || !confirms.has(snapshot?.state) || !snapshot.candidate_id) return;
  const backdrop=document.createElement('div');backdrop.className='update-confirm-backdrop';
  backdrop.innerHTML='<section class="update-confirm" role="alertdialog" aria-modal="true" aria-labelledby="update-confirm-title" aria-describedby="update-confirm-description"><h2 id="update-confirm-title"></h2><p id="update-confirm-description"></p><footer><button id="update-confirm-cancel"></button><button id="update-confirm-submit" class="primary"></button></footer></section>';
  backdrop.querySelector('h2').textContent=t('updates.confirm_title',{version:snapshot.target_version || t('updates.unknown_version')});
  backdrop.querySelector('p').textContent=t('updates.confirm_description');
  const cancel=backdrop.querySelector('#update-confirm-cancel'),submit=backdrop.querySelector('#update-confirm-submit');
  cancel.textContent=t('updates.cancel');submit.textContent=t('updates.confirm_submit');
  confirmation={backdrop,trigger:action,revision:snapshot.state_revision,candidate:snapshot.candidate_id,state:snapshot.state};
  cancel.onclick=dismiss;
  submit.onclick=()=>{
    const permit=confirmation;
    if(!permit || pending || permit.revision !== snapshot.state_revision || permit.candidate !== snapshot.candidate_id) return;
    dismiss();void request(resumes.has(permit.state)?'update_resume':'update_start',{candidateId:permit.candidate,stateRevision:permit.revision});
  };
  app.inert=true;document.body.append(backdrop);cancel.focus();
}
action.onclick=()=>{
  if(action.disabled || nativePanel) return;
  if(!snapshot) {void request('update_status');return;}
  if(manualInstallation()) {void request('update_open_releases');return;}
  if(confirms.has(snapshot.state) && !recoveredInstallFailure()) confirm();
  else void request(snapshot.state === 'rollback_failed'?'update_open_releases':'update_check');
};
async function close() {
  if(snapshot?.state === 'committing' || nativePanel || confirmation || closePending) return;
  closePending=true;render();
  // Close must bypass the ordinary request lock: revocation outranks in-flight start.
  try {await invoke('update_close');} catch {localError='update_request_failed';}
  finally {closePending=false;render();}
}
find('update-close').onclick=close;
find('update-cancel-download').onclick=()=>void request('update_cancel_download');
find('update-releases').onclick=()=>void request('update_open_releases');
document.addEventListener('keydown',event=>{
  if(event.defaultPrevented || nativePanel || event.isComposing || event.keyCode===229 || event.repeat) return;
  if(confirmation) {
    event.stopImmediatePropagation();
    if(event.key==='Escape') {event.preventDefault();dismiss();}
    if(event.key==='Tab') {
      event.preventDefault();
      const buttons=[...confirmation.backdrop.querySelectorAll('button')],i=buttons.indexOf(document.activeElement);
      buttons[(i+(event.shiftKey?-1:1)+buttons.length)%buttons.length].focus();
    }
    return;
  }
  if(event.key==='Escape') {event.preventDefault();event.stopPropagation();close();}
});
onLanguageChange(()=>{dismiss();render();});
// Subscribe before status: late snapshots must not overwrite newer events.
async function initialize() {
  await listen('leaf-update-state',({payload})=>merge(payload));
  await listen('leaf-update-native-panel',({payload})=>{nativePanel=payload===true;if(nativePanel) dismiss();render();});
  await getCurrentWindow().onFocusChanged(({payload})=>{
    if(!payload) return;
    theme();
    // Hidden windows may miss events. Native revisions also order this reply
    // against any event received while the status request was in flight.
    void invoke('update_status').then(merge).catch(()=>{}).finally(()=>{
      if(confirmation) find('update-confirm-cancel').focus();else find('update-result').focus();
    });
  });
  merge(await invoke('update_status'));find('update-result').focus();
}
render();
void initialize().catch(()=>{render();find('update-result').textContent=t('updates.check_failed');find('update-error').hidden=false;find('update-error').textContent=t('updates.check_failed_help');find('update-result').focus();});
