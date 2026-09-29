import { ViewPlugin } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import { fileDropTarget, setFileDropTarget, setFileDragging } from './file-drop.js';
import { imageMove } from './image-move.js';

export const imageDrag = editable => ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.down = event => this.start(event);
    this.move = event => {
      if (!(event.buttons & 1)) return this.cancel();
      if (!this.modifier(event)) return this.cancel();
      this.point = {x:event.clientX,y:event.clientY};
      if (!this.active && Math.hypot(this.point.x-this.origin.x,this.point.y-this.origin.y) < 5) return;
      this.active = true; event.preventDefault(); this.show();
    };
    this.up = event => {
      if (event.button !== 0) return;
      const plan = this.active && this.modifier(event) && this.plan({x:event.clientX,y:event.clientY});
      this.cancel();
      if (plan) { view.dispatch({changes:plan.changes,selection:{anchor:plan.anchor},annotations:isolateHistory.of('full'),userEvent:'move.image',scrollIntoView:true}); view.focus(); }
    };
    this.key = event => { if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); this.cancel();} };
    this.keyup = event => {if (!this.modifier(event)) this.cancel();};
    this.blur = () => this.cancel();
    view.dom.addEventListener('mousedown',this.down,true);
    this.nativeDrag = event => {if(event.target.closest?.('.leaf-image')) event.preventDefault();};
    view.dom.addEventListener('dragstart',this.nativeDrag,true);
  }
  start(event) {
    if (event.button !== 0 || !this.modifier(event) || event.altKey || !editable() || !event.target.matches?.('.leaf-image img')) return;
    let span = event.target.parentElement;
    while (span && span !== this.view.dom && !span._preview && !span._widget) span = span.parentElement;
    const preview = span?._preview, block = span?._widget?.block;
    if (!preview && !block) return;
    const index = [...span.querySelectorAll('.leaf-image img')].indexOf(event.target);
    const ranges = [], from = preview?.from ?? block.from, to = preview ? from+preview.text.length : block.to;
    syntaxTree(this.view.state).iterate({from,to,enter(node) {
      if(node.name === 'Image' && node.node.getChild('URL')) {ranges.push({from:node.from,to:node.to});return false;}
    }});
    if (!ranges[index]) return;
    event.preventDefault(); event.stopPropagation();
    this.range = ranges[index]; this.doc = this.view.state.doc;
    this.origin = this.point = {x:event.clientX,y:event.clientY}; this.active = false;
    window.addEventListener('mousemove',this.move,true);
    window.addEventListener('mouseup',this.up,true);
    window.addEventListener('keydown',this.key,true);
    window.addEventListener('keyup',this.keyup,true);
    window.addEventListener('blur',this.blur);
    this.tick();
  }
  modifier(event) {
    const platform = navigator.userAgentData?.platform || navigator.platform;
    return /mac|iphone|ipad|ipod/i.test(platform) ? event.metaKey : event.ctrlKey;
  }
  update(update) {
    // A save reload, undo, or another edit invalidates the captured source.
    // Defer dispatch until CodeMirror has completed its current update.
    if (this.range && update.docChanged) {
      const doc = this.doc;
      queueMicrotask(() => {if (this.range && this.doc === doc) this.cancel();});
    }
  }
  plan(point) {
    if (!this.range || this.doc !== this.view.state.doc || !editable()) return null;
    const target = fileDropTarget(this.view,point);
    return target && !target.protected ? imageMove(this.doc.toString(),this.range,target.pos) : null;
  }
  show() {
    const target = fileDropTarget(this.view,this.point);
    this.view.dispatch({effects:[setFileDropTarget.of(this.plan(this.point) ? target : null),setFileDragging.of(true)]});
  }
  tick() {
    this.frame = requestAnimationFrame(() => {
      if (this.active) {
        const box = this.view.scrollDOM.getBoundingClientRect(), p = this.point;
        if (p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom) {
          const delta = p.y < box.top+32 ? -10 : p.y > box.bottom-32 ? 10 : 0;
          if (delta) {this.view.scrollDOM.scrollTop += delta;this.show();}
        }
      }
      this.tick();
    });
  }
  cancel() {
    cancelAnimationFrame(this.frame);
    window.removeEventListener('mousemove',this.move,true);
    window.removeEventListener('mouseup',this.up,true);
    window.removeEventListener('keydown',this.key,true);
    window.removeEventListener('keyup',this.keyup,true);
    window.removeEventListener('blur',this.blur);
    this.range = null; this.active = false;
    this.view.dispatch({effects:[setFileDropTarget.of(null),setFileDragging.of(false)]});
  }
  destroy() {
    this.range = null;
    cancelAnimationFrame(this.frame);
    window.removeEventListener('mousemove',this.move,true);
    window.removeEventListener('mouseup',this.up,true);
    window.removeEventListener('keydown',this.key,true);
    window.removeEventListener('keyup',this.keyup,true);
    window.removeEventListener('blur',this.blur);
    this.view.dom.removeEventListener('mousedown',this.down,true);
    this.view.dom.removeEventListener('dragstart',this.nativeDrag,true);
  }
});
