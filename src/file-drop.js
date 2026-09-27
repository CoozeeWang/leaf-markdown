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
  const hit=view.posAndSideAtCoords({x,y:point.y},false),floor=bodyStart(view.state.doc.toString());
  if(!hit)return null;
  // A soft-wrap boundary has one source position but two visual rows. Keep
  // the hit's side so a row-end marker doesn't jump to the following row.
  return {pos:Math.max(hit.pos,floor),assoc:hit.pos<floor?1:hit.assoc,protected:hit.pos<floor};
}

const mapTarget=(value,changes)=>value===null?null:{...value,pos:changes.mapPos(value.pos,value.assoc)};
export const setFileDropTarget=StateEffect.define({map:mapTarget});
export const setFileDragging=StateEffect.define();
const dragging=StateField.define({
  create:()=>false,
  update(value,tr){for(const effect of tr.effects)if(effect.is(setFileDragging))value=effect.value;return value;},
});
const target=StateField.define({
  create:()=>null,
  update(value,tr){
    if(value!==null&&tr.docChanged)value=mapTarget(value,tr.changes);
    for(const effect of tr.effects)if(effect.is(setFileDropTarget))value=effect.value;
    return value;
  },
});
const marker=ViewPlugin.fromClass(class {
  constructor(view){
    this.view=view;this.cursor=null;
    this.measure={read:()=>this.read(),write:rect=>this.draw(rect)};
  }
  update(update){
    const value=update.state.field(target);
    if(value===null){this.cursor?.remove();this.cursor=null;return;}
    if(!this.cursor){
      this.cursor=document.createElement('div');this.cursor.className='cm-dropCursor leaf-file-drop-cursor';
      this.cursor.setAttribute('aria-hidden','true');this.view.scrollDOM.append(this.cursor);
    }
    if(update.docChanged||update.geometryChanged||update.startState.field(target)!==value)this.view.requestMeasure(this.measure);
  }
  read(){
    const value=this.view.state.field(target),rect=value===null?null:this.view.coordsAtPos(value.pos,value.assoc);
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
