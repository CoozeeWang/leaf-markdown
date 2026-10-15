import {t} from './i18n.js';
import {commentShortcuts} from './comment-view.js';
import {positionMenu} from './menu-position.js';
export function setupCommentContext({editor,add,desktop,invoke,editable}){
 let menu=null;
 const close=()=>{menu?.remove();menu=null;};
 editor.view.dom.addEventListener('contextmenu',async event=>{
  if(event.target.closest('textarea,input,.leaf-image,.leaf-table,.leaf-callout-widget'))return;
  if(!editable()||!editor.mutationAllowed())return;
  event.preventDefault();
  const range=editor.view.state.selection.main,pos=editor.view.posAtCoords({x:event.clientX,y:event.clientY});
  if(pos!==null&&(range.empty||pos<range.from||pos>range.to))editor.view.dispatch({selection:{anchor:pos}});
  if(desktop){await invoke('show_comment_context');return;}
  close();menu=document.createElement('section');menu.className='popover action-popover comment-context-menu';menu.setAttribute('role','menu');
  const action=document.createElement('button');action.type='button';action.setAttribute('role','menuitem');action.textContent=t('comments.add');const key=document.createElement('kbd');key.textContent=commentShortcuts();action.append(key);action.onclick=()=>{close();if(editor.mutationAllowed())add();};menu.append(action);
  for(const [key,command]of [['native.cut','cut'],['native.copy','copy'],['native.paste','paste']]){const button=document.createElement('button');button.type='button';button.textContent=t(key);button.setAttribute('role','menuitem');button.onclick=()=>{close();editor.focus();document.execCommand(command);};menu.append(button);}
  menu.onmousedown=e=>e.preventDefault();menu.onkeydown=e=>{if(e.key==='Escape'){close();editor.focus();}if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const buttons=[...menu.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);buttons[(index+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length].focus();}};
  document.body.append(menu);positionMenu(menu,{left:event.clientX,top:event.clientY,bottom:event.clientY});action.focus();
 });
 document.addEventListener('mousedown',e=>{if(menu&&!menu.contains(e.target))close();});
 window.addEventListener('blur',close);editor.view.scrollDOM.addEventListener('scroll',close);
}
