import {StateEffect,StateField} from '@codemirror/state';
import {EditorView,ViewPlugin} from '@codemirror/view';
import {bodyStart} from './markdown-model.js';

// Coordinates here are CSS pixels. Native Tauri events are converted by the
// caller; the feedback and the final insertion use exactly the same resolver.
export function fileDropTarget(view, point) {
  const bounds=view.scrollDOM.getBoundingClientRect();
  if(!point || point.x<bounds.left || point.x>bounds.right || point.y<bounds.top || point.y>bounds.bottom)return null;
  const content=view.contentDOM.getBoundingClientRect();
  const x=Math.max(content.left+1,Math.min(point.x,content.right-1));
  const raw=view.posAtCoords({x,y:point.y},false),floor=bodyStart(view.state.doc.toString());
  return {pos:Math.max(raw,floor),protected:raw<floor};
}

export const setFileDropTarget=StateEffect.define({map:(pos,changes)=>pos===null?null:changes.mapPos(pos)});
export const setFileDragging=StateEffect.define();
const dragging=StateField.define({
  create:()=>false,
  update(value,tr){for(const effect of tr.effects)if(effect.is(setFileDragging))value=effect.value;return value;},
});
const target=StateField.define({
  create:()=>null,
  update(pos,tr){
    if(pos!==null)pos=tr.changes.mapPos(pos);
    for(const effect of tr.effects)if(effect.is(setFileDropTarget))pos=effect.value;
    return pos;
  },
});
const marker=ViewPlugin.fromClass(class {
  constructor(view){
    this.view=view;this.cursor=null;
    this.measure={read:()=>this.read(),write:rect=>this.draw(rect)};
  }
  update(update){
    const pos=update.state.field(target);
    if(pos===null){this.cursor?.remove();this.cursor=null;return;}
    if(!this.cursor){
      this.cursor=document.createElement('div');this.cursor.className='cm-dropCursor leaf-file-drop-cursor';
      this.cursor.setAttribute('aria-hidden','true');this.view.scrollDOM.append(this.cursor);
    }
    if(update.docChanged||update.geometryChanged||update.startState.field(target)!==pos)this.view.requestMeasure(this.measure);
  }
  read(){
    const pos=this.view.state.field(target),rect=pos===null?null:this.view.coordsAtPos(pos);
    if(!rect)return null;
    const outer=this.view.scrollDOM.getBoundingClientRect();
    return {left:(rect.left-outer.left)/this.view.scaleX+this.view.scrollDOM.scrollLeft,
      top:(rect.top-outer.top)/this.view.scaleY+this.view.scrollDOM.scrollTop,height:(rect.bottom-rect.top)/this.view.scaleY};
  }
  draw(rect){
    if(!this.cursor)return;
    this.cursor.hidden=!rect;
    if(rect)Object.assign(this.cursor.style,{left:rect.left+'px',top:rect.top+'px',height:rect.height+'px'});
  }
  destroy(){this.cursor?.remove();}
});
export const fileDropFeedback=[target,dragging,marker,
EditorView.editorAttributes.compute([dragging],state=>({class:state.field(dragging)?'leaf-file-dragging':''})),EditorView.theme({
  '.leaf-file-drop-cursor':{borderLeft:'2px solid var(--accent)',pointerEvents:'none'},
  '&.leaf-file-dragging .cm-cursorLayer':{visibility:'hidden'},
  '&.leaf-file-dragging .cm-content':{caretColor:'transparent !important'},
  '&.leaf-file-dragging .cm-dropCursor:not(.leaf-file-drop-cursor)':{display:'none'},
})];
