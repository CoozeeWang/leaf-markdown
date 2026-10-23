import {renderPrintDocument} from '../print-document.js';
import {resolveLanguage,languages,t} from '../i18n.js';
import i18next from 'i18next';
import {createReaderBridge} from './bridge.js';
import '../reading.css';
import '../callout.css';
import './style.css';

const panelKeys={
 "view":"mcp_panel.view",
 "browser":"mcp_panel.browser",
 "refresh":"mcp_panel.refresh",
 "stop":"mcp_panel.stop",
 "empty":"mcp_panel.empty",
 "disconnected":"mcp_panel.disconnected",
 "invalid":"mcp_panel.invalid",
 "unsupported":"mcp_panel.unsupported",
 "current":"mcp_panel.current",
 "unsaved":"mcp_panel.unsaved",
 "task":"mcp_panel.task",
 "idle":"mcp_panel.idle",
 "locate":"mcp_panel.locate",
 "diff":"mcp_panel.diff",
 "none":"mcp_panel.none",
 "source":"mcp_panel.source",
 "waiting":"mcp_panel.waiting",
 "saved":"main.saved",
 "comments":"comments.title",
 "hidden":"comments.hidden",
 "reader":"mcp_panel.reader_aria",
};
const copy=Object.fromEntries(languages.map(lng=>[lng,Object.fromEntries(Object.entries(panelKeys).map(([name,key])=>[name,t(key,{lng})]))]));
const setLanguage=language=>{void i18next.changeLanguage(language);};
let language='en',last=null,difference='',terminal=false;
const q=id=>document.getElementById(id),text=(id,value)=>q(id).textContent=value;
const browserView=new URL(location.href).pathname==='/reader';
function labels(){const c=copy[language];q('reader').setAttribute('aria-label',c.reader);document.documentElement.lang=language;text('viewKind',browserView?c.browser:c.view);text('refresh',c.refresh);text('stop',c.stop);text('diffTitle',c.diff);text('sourceTitle',c.source);}
function invalidate(reason='invalid'){terminal=true;last=null;difference='';q('reader').replaceChildren();q('comments').replaceChildren();text('source','');text('sourceMetadata','');q('sourceBox').hidden=true;text('diff','');text('identity','');text('status',copy[language][reason]??copy[language].invalid);q('stop').disabled=true;q('refresh').disabled=true;}
function context(value){language=resolveLanguage(value.locale??language);setLanguage(language);document.documentElement.dataset.theme=value.theme==='dark'?'dark':'light';labels();if(last)render(last);}
function render(value){
 if(terminal)return;
 if(!value?.binding||!value.snapshot){invalidate('empty');return;}
 const snapshot=value.snapshot,c=copy[language];
 if(last&&snapshot.revision>last.snapshot.revision)difference=`− ${last.snapshot.content}\n+ ${snapshot.content}`;
 last=value;
 if(snapshot.language)language=resolveLanguage(snapshot.language);
 if(browserView&&snapshot.theme)document.documentElement.dataset.theme=snapshot.theme==='dark'?'dark':'light';
 setLanguage(language);labels();
 text('status',`${copy[language].current} · ${snapshot.saved?copy[language].saved:copy[language].unsaved} · ${value.task?copy[language].task:copy[language].idle}`);
 text('identity',`${snapshot.name??value.binding.document_id} · ${t('mcp_panel.revision',{lng:language,revision:snapshot.revision})}`);
 text('sourceMetadata',`${snapshot.line_ending==='\r\n'?'CRLF':'LF'} · UTF-16`);
 renderPrintDocument(q('reader'),snapshot.content,{properties:true,fallbackTitle:false,sourcePositions:true,annotations:true,annotationNotes:value.comments??[],resources:false});
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
else{adapter=createReaderBridge({render,invalidate,context});try{await adapter.connect();if(!last&&!terminal)text('status',copy[language].empty);}catch{invalidate('disconnected');}}
q('refresh').onclick=()=>adapter.refresh();q('stop').onclick=()=>adapter.stop();
const timer=setInterval(()=>adapter.refresh(),1500);
window.addEventListener('pagehide',()=>{clearInterval(timer);adapter.close();},{once:true});
}
void start();
