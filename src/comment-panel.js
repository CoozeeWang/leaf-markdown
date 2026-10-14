import {t,setText,setAttr,onLanguageChange,message as translatedMessage} from './i18n.js';
import {documentHistoryShortcut} from './platform-shortcuts.js';
import {uiIcon} from './ui-icons.js';
import {isolateHistory} from '@codemirror/commands';
import {commentShortcuts,isCommentShortcut} from './comment-view.js';
import './comments.css';
import {commentQuote} from './comments.js';

export function setupCommentPanel({editor,getMode,open,status,locate}) {
 const list=document.querySelector('#commentsList'),commentsTab=document.querySelector('#commentsTab'),notesTab=document.querySelector('#notesTab'),notesList=document.querySelector('#notesList');
 let tab='comments',chosen=false,editing=null,current=null,rendering=false;
 const selectTab=(value,explicit=true)=>{tab=value;if(explicit)chosen=true;commentsTab.setAttribute('aria-selected',String(tab==='comments'));notesTab.setAttribute('aria-selected',String(tab==='notes'));list.hidden=tab!=='comments';notesList.hidden=tab!=='notes';};
 commentsTab.onclick=()=>{finish();selectTab('comments');render();};notesTab.onclick=()=>{finish();selectTab('notes');};
 for(const button of [commentsTab,notesTab])button.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();(button===commentsTab?notesTab:commentsTab).click();(tab==='comments'?commentsTab:notesTab).focus();});
 function finish(){if(!editing)return;editing=null;editor.view.dispatch({annotations:isolateHistory.of('full')});render();}
 function edit(id){if(getMode()==='reading')return;editing=id;current=id;editor.view.dispatch({annotations:isolateHistory.of('full')});render();list.querySelector(`[data-comment-id="${id}"] textarea`)?.focus();}
 function reveal(id,{edit:newEntry=false}={}){open();selectTab('comments');current=id;editor.activateComment(id);render();list.querySelector(`[data-comment-id="${id}"]`)?.scrollIntoView({block:'nearest'});if(newEntry)edit(id);}
 function render(){
  if(rendering)return;rendering=true;
  try{
   const notes=editor.comments().notes,reading=getMode()==='reading';
   document.querySelector('#commentInsert').disabled=reading;
   document.querySelector('#commentsCount').textContent=notes.length?String(notes.length):'';
   if(!chosen)selectTab(!notes.length&&document.querySelector('#notesCount').textContent?'notes':'comments',false);
   const ids=new Set(notes.map(n=>n.id));for(const card of list.querySelectorAll('.comment-card'))if(!ids.has(card.dataset.commentId))card.remove();list.querySelector('.empty-hint')?.remove();
   if(!notes.length){const empty=document.createElement('span');empty.className='empty-hint';setText(empty,()=>t('comments.empty'));list.append(empty);}
   notes.forEach((note,i)=>{
    let card=list.querySelector(`[data-comment-id="${note.id}"]`);
    if(!card){
     card=document.createElement('section');card.className='comment-card';card.dataset.commentId=note.id;
     const jump=document.createElement('button');jump.type='button';jump.className='comment-quote';jump.onclick=()=>{current=card.dataset.commentId;if(locate)locate(card._comment);else editor.goToComment(current);render();};card.append(jump);
     const body=document.createElement('div');body.className='comment-body';body.ondblclick=()=>edit(card.dataset.commentId);card.append(body);
     body.addEventListener('keydown',e=>{if(e.target===body&&!e.isComposing&&(e.key==='Enter'||e.key===' ')){e.preventDefault();edit(card.dataset.commentId);}});
     const actions=document.createElement('div');actions.className='comment-actions';actions.append(document.createElement('span'));
     const remove=document.createElement('button');remove.type='button';remove.className='comment-delete';remove.innerHTML=uiIcon('trash',14);setAttr(remove,'aria-label',()=>t('comments.delete'));setAttr(remove,'data-tooltip',()=>t('comments.delete'));remove.onclick=()=>{editing=null;editor.deleteComment(card.dataset.commentId);render();};actions.append(remove);card.append(actions);
    }
    card._comment=note;card.classList.toggle('active',note.id===current);card.querySelector('.comment-quote').textContent=commentQuote(note.quote)||t('comments.position');setText(card.querySelector('.comment-actions span'),()=>t('comments.'+note.kind));
    const body=card.querySelector('.comment-body'),input=body.querySelector('textarea');
    body.tabIndex=reading||editing===note.id?-1:0;setAttr(body,'data-tooltip',()=>reading?'':t('comments.edit_hint'));setAttr(body,'aria-description',()=>reading?'':t('comments.edit_hint'));
    if(editing===note.id&&!reading){
     if(!input){
      const area=document.createElement('textarea');area.value=note.text;area.rows=2;setAttr(area,'aria-label',()=>t('comments.body'));body.replaceChildren(area);
      area.addEventListener('input',()=>{if(!editor.setCommentBody(card.dataset.commentId,area.value)){area.value=card._comment.text;status(translatedMessage('comments.terminator'),'error');}});
      area.addEventListener('keydown',e=>{const action=documentHistoryShortcut(e);if(action){e.preventDefault();e.stopPropagation();editor[action]();return;}if(e.key==='Escape'&&!e.isComposing){e.preventDefault();finish();card.querySelector('.comment-quote').focus();}});
      area.addEventListener('blur',()=>{if(editing===card.dataset.commentId&&!area._composing)finish();});area.addEventListener('compositionstart',()=>area._composing=true);area.addEventListener('compositionend',()=>{area._composing=false;render();});
     }else if(!input._composing&&input.value!==note.text){const pos=input.selectionStart;input.value=note.text;input.setSelectionRange(Math.min(pos,note.text.length),Math.min(pos,note.text.length));}
    }else if(input||body.textContent!==note.text)body.textContent=note.text;
    card.querySelector('.comment-delete').hidden=reading;
    // A focused textarea must not be reparented during composition.
    const expected=list.children[i];if(expected!==card)list.insertBefore(card,expected??null);
   });
  }finally{rendering=false;}
 }
 function add(){if(getMode()==='reading'||document.querySelector('.shell.welcome-state'))return;const result=editor.addComment();if(result.error){status(translatedMessage(result.error==='overlap'?'comments.overlap':result.error==='position'?'comments.position_invalid':'comments.selection'),'error');return;}if(result.note)reveal(result.note.id,{edit:true});}
 const button=document.querySelector('#commentInsert');setAttr(button,'data-tooltip',()=>t('comments.add_shortcut',{shortcut:commentShortcuts()}));button.onclick=add;button.addEventListener('mousedown',e=>e.preventDefault());
 window.addEventListener('keydown',e=>{if(!isCommentShortcut(e)||document.querySelector('.shell.welcome-state')||document.activeElement?.closest('.comment-card textarea, #paletteInput, .search-panel, .properties-panel')||document.querySelector('#palette:not([hidden]), #appearancePopover:not([hidden])')||editor.view.compositionStarted)return;e.preventDefault();add();},true);
 document.querySelector('#readingPane').addEventListener('click',e=>{const id=e.target.closest('.leaf-comment-bubble[data-comment-id]')?.dataset.commentId;if(id){e.preventDefault();reveal(id);}});
 onLanguageChange(render);
 return {render,reveal,selectTab,add,finish,ownsHistoryTarget:target=>!!target?.closest?.('#commentsList textarea')};
}
