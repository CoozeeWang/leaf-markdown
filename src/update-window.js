import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {t,onLanguageChange} from './i18n.js';
import {mergeUpdateSnapshot} from './update-state.js';
import './style.css';
import './update-window.css';

document.body.classList.add('update-window');
const app=document.querySelector('#app');
app.innerHTML='<header><h1></h1><p id="update-version"></p></header><main id="update-content"><section aria-live="polite" aria-atomic="true"><h2 id="update-result" tabindex="-1"></h2><p id="update-message"></p><p id="update-error" hidden></p></section><details hidden><summary></summary><pre id="update-notes"></pre></details></main><footer id="update-footer"><button id="update-releases" class="text-action"></button><span class="update-actions"><button id="update-close"></button><button id="update-action" class="primary"></button></span></footer>';
const find=id=>document.getElementById(id);
let snapshot=null,pending=false,localError=null;
function theme(){const value=localStorage.getItem('leaf-theme')||'system';document.documentElement.dataset.theme=value==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):value;}
theme();window.addEventListener('storage',e=>{if(e.key==='leaf-theme')theme();});matchMedia('(prefers-color-scheme: dark)').addEventListener('change',theme);
function render(){
 const state=snapshot?.state||'idle',checking=state==='checking',available=state==='available';
 app.dataset.updateState=state;app.dataset.stateRevision=snapshot?.state_revision??0;
 document.querySelector('h1').textContent=t('updates.title');
 find('update-version').textContent=t('updates.version',{version:snapshot?.installed_version||t('updates.unknown_version')});
 find('update-result').textContent=t('updates.'+(['idle','checking','current','available','no_package','check_failed'].includes(state)?state:'check_failed'));
 find('update-message').textContent=available?t('updates.manual_help',{version:snapshot.target_version}):state==='current'?t('updates.current_help',{version:snapshot.installed_version}):state==='no_package'?t('updates.no_package_help'):state==='check_failed'?t('updates.check_failed_help'):'';
 const error=localError||snapshot?.error_code;
 find('update-error').hidden=!error;
 find('update-error').textContent=error?t('updates.'+(error==='update_rate_limited'?'error_rate_limit':error==='update_timeout'?'error_timeout':error==='update_releases_unavailable'?'error_browser':error==='update_stale_confirmation'?'error_stale_download':'check_failed_help')):'';
 document.querySelector('details').hidden=!snapshot?.notes;
 document.querySelector('summary').textContent=t('updates.notes');find('update-notes').textContent=snapshot?.notes||'';
 find('update-releases').textContent=t('updates.releases');find('update-close').textContent=t('updates.close');
 const platforms={'darwin-aarch64':'macos_arm64','darwin-x86_64':'macos_x64','windows-x86_64':'windows_x64'};
 find('update-action').textContent=t('updates.'+(available?'download_'+(platforms[snapshot.platform]||'platform'):checking?'checking':state==='check_failed'?'retry':'check_again'));
 find('update-action').disabled=pending||checking||(available&&!snapshot.candidate_id);
 find('update-releases').disabled=pending;
}
function merge(next){const value=mergeUpdateSnapshot(snapshot,next);if(value===snapshot)return;snapshot=value;localError=null;render();}
async function request(command,args={}){
 if(pending)return;pending=true;localError=null;render();
 try{const value=await invoke(command,args);if(value)merge(value);}catch(error){localError=String(error);}
 finally{pending=false;render();}
}
find('update-action').onclick=()=>{
 if(find('update-action').disabled)return;
 if(snapshot?.state==='available')void request('update_open_download',{candidateId:snapshot.candidate_id,stateRevision:snapshot.state_revision});
 else void request('update_check');
};
find('update-releases').onclick=()=>void request('update_open_releases');
async function close(){try{await invoke('update_close');}catch{localError='update_releases_unavailable';render();}}
find('update-close').onclick=close;
document.addEventListener('keydown',event=>{if(!event.defaultPrevented&&!event.isComposing&&event.key==='Escape'){event.preventDefault();void close();}});
onLanguageChange(render);
async function initialize(){
 await listen('leaf-update-state',({payload})=>merge(payload));
 await getCurrentWindow().onFocusChanged(({payload})=>{if(payload){theme();void invoke('update_status').then(merge).catch(()=>{});}});
 await request('update_status');find('update-result').focus();
}
void initialize().catch(()=>{localError='update_request_failed';render();});
