import {renderPrintDocument} from '../print-document.js';
import {resolveLanguage} from '../i18n.js';
import i18next from 'i18next';
import {createReaderBridge} from './bridge.js';
import './style.css';

const copy={
 'zh-Hans':{view:'只读实时视图',browser:'浏览器实时视图',refresh:'刷新',stop:'结束编辑',empty:'没有获准的文档。',disconnected:'连接已断开，视图已失效。',invalid:'授权已失效。',unsupported:'宿主未提供实时工具连接。',current:'当前稿',unsaved:'未保存稿',saved:'已保存',task:'正在辅助编辑',idle:'没有编辑任务',comments:'批注',hidden:'隐藏式批注',locate:'定位',diff:'差异',none:'没有差异。',source:'结构源码',waiting:'正在连接…'},
 'zh-Hant-TW':{view:'唯讀即時檢視',browser:'瀏覽器即時檢視',refresh:'重新整理',stop:'結束編輯',empty:'沒有獲准的文件。',disconnected:'連線已中斷，檢視已失效。',invalid:'授權已失效。',unsupported:'主機未提供即時工具連線。',current:'目前稿件',unsaved:'未儲存稿',saved:'已儲存',task:'正在輔助編輯',idle:'沒有編輯工作',comments:'批註',hidden:'隱藏式批註',locate:'定位',diff:'差異',none:'沒有差異。',source:'結構原始碼',waiting:'正在連線…'},
 en:{view:'Read-only live view',browser:'Browser live view',refresh:'Refresh',stop:'End Editing',empty:'No authorized document.',disconnected:'Disconnected. This view is no longer current.',invalid:'Authorization expired.',unsupported:'The host does not provide live tool access.',current:'Current draft',unsaved:'Unsaved draft',saved:'Saved',task:'AI editing in progress',idle:'No editing task',comments:'Comments',hidden:'Hidden comment',locate:'Locate',diff:'Changes',none:'No changes.',source:'Structure source',waiting:'Connecting…'},
};
const setLanguage=language=>{void i18next.changeLanguage(language);};
let language='en',last=null,difference='',terminal=false;
const q=id=>document.getElementById(id),text=(id,value)=>q(id).textContent=value;
const browserView=new URL(location.href).pathname==='/reader';
function labels(){const c=copy[language];document.documentElement.lang=language;text('viewKind',browserView?c.browser:c.view);text('refresh',c.refresh);text('stop',c.stop);text('diffTitle',c.diff);text('sourceTitle',c.source);}
function invalidate(reason='invalid'){terminal=true;last=null;difference='';q('reader').replaceChildren();q('comments').replaceChildren();text('source','');q('sourceBox').hidden=true;text('diff','');text('identity','');text('status',copy[language][reason]??copy[language].invalid);q('stop').disabled=true;q('refresh').disabled=true;}
function context(value){language=resolveLanguage(value.locale??language);setLanguage(language);document.documentElement.dataset.theme=value.theme==='dark'?'dark':'light';labels();if(last)render(last);}
function render(value){
 if(terminal)return;
 if(!value?.binding||!value.snapshot){invalidate('empty');return;}
 const snapshot=value.snapshot,c=copy[language];
 if(last&&snapshot.revision>last.snapshot.revision)difference=`− ${last.snapshot.content}\n+ ${snapshot.content}`;
 last=value;
 if(snapshot.language)language=resolveLanguage(snapshot.language);
 setLanguage(language);labels();
 text('status',`${copy[language].current} · ${snapshot.saved?copy[language].saved:copy[language].unsaved} · ${value.task?copy[language].task:copy[language].idle}`);
 text('identity',`${snapshot.name??value.binding.document_id} · revision ${snapshot.revision} · ${snapshot.line_ending==='\r\n'?'CRLF':'LF'} · UTF-16`);
 renderPrintDocument(q('reader'),snapshot.content,{properties:true,fallbackTitle:false,sourcePositions:true,annotations:true,annotationNotes:value.comments??[]});
 // Parser output remains inert. Never load attachments or navigate externally.
 for(const image of q('reader').querySelectorAll('img')){const span=document.createElement('span');span.textContent=image.alt;image.replaceWith(span);}
 for(const link of q('reader').querySelectorAll('a'))if(!link.getAttribute('href')?.startsWith('#'))link.removeAttribute('href');
 text('source',snapshot.content);q('sourceBox').hidden=false;text('diff',difference||copy[language].none);
 q('comments').replaceChildren();
 for(const note of value.comments??[]){const card=document.createElement('div');card.className='comment-card';card.dataset.kind=note.kind;const button=document.createElement('button');button.type='button';button.textContent=`${note.kind==='hidden'?copy[language].hidden:copy[language].locate} · ${note.quote||note.from}`;button.onclick=()=>{q('reader').querySelectorAll('.located').forEach(n=>n.classList.remove('located'));const offset=note.anchor.from-(snapshot.range?.from??0);const nodes=Array.from(q('reader').querySelectorAll('[data-source-from]'));const target=nodes.find(n=>Number(n.dataset.sourceFrom)<=offset&&Number(n.dataset.sourceTo)>=offset)||nodes.reduce((a,b)=>Math.abs(Number(b.dataset.sourceFrom)-offset)<Math.abs(Number(a?.dataset.sourceFrom??Infinity)-offset)?b:a,null);if(target){target.classList.add('located');target.scrollIntoView({block:'center'});}else{q('sourceBox').open=true;q('source').scrollIntoView({block:'center'});}};const body=document.createElement('p');body.textContent=note.text;card.append(button,body);q('comments').append(card);}
 q('stop').disabled=!value.task;adapter.bindingTask?.(value.task?.task_id);
}
let adapter;
async function start(){
labels();text('status',copy[language].waiting);
if(browserView){const {createLiveBrowser}=await import('./live-browser.js');adapter=createLiveBrowser({render,invalidate});await adapter.connect();}
else{adapter=createReaderBridge({render,invalidate,context});try{await adapter.connect();}catch{invalidate('disconnected');}}
q('refresh').onclick=()=>adapter.refresh();q('stop').onclick=()=>adapter.stop();
const timer=setInterval(()=>adapter.refresh(),1500);
window.addEventListener('pagehide',()=>{clearInterval(timer);adapter.close();},{once:true});
}
void start();
