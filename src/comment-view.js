import {StateField,StateEffect,MapMode} from '@codemirror/state';
import {Decoration,EditorView,WidgetType,ViewPlugin} from '@codemirror/view';
import {sourceMode} from './view-mode.js';
import {indexComments} from './comments.js';
import {t,setAttr} from './i18n.js';
import {uiIcon} from './ui-icons.js';
let serial=0;
export const activeComment=StateEffect.define();
export const locateComment=StateEffect.define();
export const commentIndex=StateField.define({
 create(state){return {...indexComments(state.doc.toString()),notes:indexComments(state.doc.toString()).notes.map(n=>({...n,id:'comment-'+(++serial)})),active:null,located:null};},
 update(value,tr){
  let active=value.active,located=value.located;for(const effect of tr.effects){if(effect.is(activeComment))active=effect.value;if(effect.is(locateComment))located=effect.value;}
  if(!tr.docChanged)return active===value.active&&located===value.located?value:{...value,active,located};
  const index=indexComments(tr.newDoc.toString());
  const notes=index.notes.map(n=>{const old=value.notes.find(old=>old.kind===n.kind&&tr.changes.mapPos(old.from,1,MapMode.TrackAfter)===n.from);return {...n,id:old?.id??'comment-'+(++serial)};});
  return {...index,notes,active:notes.some(n=>n.id===active)?active:null,located:null};
 },
});
export function commentBubble(note){
 const button=document.createElement('button');button.type='button';button.className='leaf-comment-bubble';button.dataset.commentId=note.id;
 button.innerHTML=uiIcon('comment',12);setAttr(button,'aria-label',()=>t('comments.show'));setAttr(button,'data-tooltip',()=>t('comments.show'));
 return button;
}
class CommentBubble extends WidgetType {
 constructor(note){super();this.note=note;}
 eq(other){return other.note.id===this.note.id;}
 toDOM(view){const button=commentBubble(this.note);button.addEventListener('mousedown',e=>e.preventDefault());button.addEventListener('click',e=>{e.preventDefault();view.dom.dispatchEvent(new CustomEvent('leaf-comment-activate',{bubbles:true,detail:{id:this.note.id}}));});return button;}
 ignoreEvent(){return true;}
}
function decorations(state){
 const index=state.field(commentIndex),shown=[],atomic=[];
 if(state.field(sourceMode)){
  const note=index.notes.find(n=>n.id===index.located);
  return {shown:note?Decoration.set([Decoration.mark({class:'leaf-comment-located'}).range(note.from,note.to)]):Decoration.none,atomic:Decoration.none};
 }
 const replace=(from,to,widget)=>{if(to>from){const r=Decoration.replace(widget?{widget}:{}).range(from,to);shown.push(r);atomic.push(r);}};
 for(const range of index.ranges){
  const note=index.notes.find(n=>n.range?.from===range.from);
  replace(range.from,range.bodyFrom);replace(range.bodyTo,range.to);
  if(range.bodyTo>range.bodyFrom)shown.push(Decoration.mark({class:note?'leaf-comment-range'+(note.id===index.active?' active':''):'leaf-critic-highlight',attributes:note?{'data-comment-id':note.id}:{}}).range(range.bodyFrom,range.bodyTo));
 }
 for(const note of index.notes){
  if(note.kind==='hidden')shown.push(Decoration.mark({class:'leaf-hidden-comment'+(note.id===index.located?' leaf-comment-located':''),attributes:{'data-comment-id':note.id}}).range(note.from,note.to));
  else replace(note.from,note.to,new CommentBubble(note));
 }
 return {shown:Decoration.set(shown,true),atomic:Decoration.set(atomic,true)};
}
export const commentDecorations=StateField.define({create:decorations,update(_v,tr){return decorations(tr.state);},provide:field=>[
 EditorView.decorations.from(field,v=>v.shown),EditorView.atomicRanges.of(view=>view.state.field(field).atomic),
]});
// A locating cue belongs to the view, never to the document or undo history.
export const commentLocation=ViewPlugin.fromClass(class {
 constructor(){this.timer=null;}
 update(update){
  if(!update.state.field(commentIndex).located){clearTimeout(this.timer);this.timer=null;return;}
  if(!update.transactions.some(tr=>tr.effects.some(effect=>effect.is(locateComment))))return;
  clearTimeout(this.timer);const id=update.state.field(commentIndex).located;
  this.timer=setTimeout(()=>{this.timer=null;if(update.view.state.field(commentIndex).located===id)update.view.dispatch({effects:locateComment.of(null)});},1800);
 }
 destroy(){clearTimeout(this.timer);}
});
export const commentShortcuts=(platform=globalThis.navigator?.platform??'')=>/win/i.test(platform)?'Ctrl+Alt+M':'⌥⌘A';
export function isCommentShortcut(event,platform=globalThis.navigator?.platform??''){
 if(event.isComposing||event.repeat||event.shiftKey)return false;
 return /win/i.test(platform)?event.ctrlKey&&event.altKey&&!event.metaKey&&(event.code==='KeyM'||event.key?.toLowerCase()==='m'):
  event.metaKey&&event.altKey&&!event.ctrlKey&&(event.code==='KeyA'||event.key?.toLowerCase()==='a');
}
