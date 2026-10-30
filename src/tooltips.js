import {renderShortcutText, renderTooltipText} from './platform-shortcuts.js';

const controllers = new WeakMap();
export const tooltipDelays = Object.freeze({control:600, operation:800});
export function tooltipPosition(anchor, size, viewport, operation = false) {
  const gap=8, edge=8;
  let left=operation ? anchor.right+gap : anchor.left+(anchor.width-size.width)/2;
  let top=operation ? anchor.top : anchor.bottom+gap;
  if(operation && left+size.width>viewport.right-edge) {
    left=anchor.left-size.width-gap;
    if(left<viewport.left+edge){
      // Wide content may leave neither side free: use an outer edge before
      // clamping, so a hint does not unnecessarily cover the content itself.
      left=anchor.right-size.width;
      top=anchor.top-size.height-gap;
      if(top<viewport.top+edge)top=anchor.bottom+gap;
    }
  }
  if(!operation && top+size.height>viewport.bottom-edge) top=anchor.top-size.height-gap;
  return {left:Math.max(viewport.left+edge, Math.min(left,viewport.right-size.width-edge)),
    top:Math.max(viewport.top+edge, Math.min(top,viewport.bottom-size.height-edge))};
}

export function dismissTooltips(doc = document) { controllers.get(doc)?.dismiss(); }
export function setupTooltips(doc = document) {
  if(controllers.has(doc))return controllers.get(doc);
  const win=doc.defaultView;
  const tip=doc.querySelector('#tooltip') || doc.body.appendChild(doc.createElement('div'));
  tip.id='tooltip';tip.className='ui-tooltip';tip.setAttribute('role','tooltip');tip.hidden=true;
  let target=null, hovered=null, timer=null, leaveTimer=null, keyboard=true, pointerActive=false, dragging=false;
  const suppressed=new Set();
  const trigger=node=>node?.closest?.('[data-tooltip]');
  const inside=(node,element)=>!!node && !!element?.contains(node);
  const operation=element=>element?.dataset.tooltipKind==='operation';
  function hide(){
    clearTimeout(timer);clearTimeout(leaveTimer);timer=null;
    if(target){
      const ids=(target.getAttribute('aria-describedby')||'').split(/\s+/).filter(id=>id&&id!==tip.id);
      if(ids.length)target.setAttribute('aria-describedby',ids.join(' '));else target.removeAttribute('aria-describedby');
    }
    target=null;tip.hidden=true;
  }
  function dismiss(){if(hovered)suppressed.add(hovered);hide();}
  function viewport(){const v=win.visualViewport;return {left:v?.offsetLeft||0,top:v?.offsetTop||0,right:(v?.offsetLeft||0)+(v?.width||win.innerWidth),bottom:(v?.offsetTop||0)+(v?.height||win.innerHeight)};}
  function place(){
    let zoom=1;for(let node=tip;node;node=node.parentElement)zoom*=parseFloat(win.getComputedStyle(node).zoom)||1;
    const bounds=viewport();tip.style.maxWidth=`${Math.max(0,Math.min(320,(bounds.right-bounds.left-16)/zoom))}px`;
    tip.style.maxHeight=`${Math.max(0,(bounds.bottom-bounds.top-16)/zoom)}px`;
    const rect=target.getBoundingClientRect();
    const anchor={left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width};
    const menu=!operation(target)&&target.closest('[role="menu"],.leaf-table-menu');
    if(menu){const box=menu.getBoundingClientRect();anchor.top=box.top;anchor.bottom=box.bottom;}
    const position=tooltipPosition(anchor,tip.getBoundingClientRect(),bounds,operation(target));
    tip.style.left=`${position.left/zoom}px`;tip.style.top=`${position.top/zoom}px`;
  }
  function show(element){
    timer=null;
    if(!element?.isConnected||!element.dataset.tooltip||suppressed.has(element)||doc.hidden||pointerActive||dragging)return;
    target=element;tip.dataset.source=element.dataset.tooltip;tip.dataset.kind=operation(element)?'operation':'control';
    if(operation(element))renderShortcutText(tip,element.dataset.tooltip,true);
    else renderTooltipText(tip,element.dataset.tooltip);
    tip.hidden=false;place();
    const ids=new Set((element.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean));ids.add(tip.id);
    element.setAttribute('aria-describedby',[...ids].join(' '));
  }
  function queue(element,immediate=false){
    clearTimeout(leaveTimer);
    if(element===target)return;
    hide();if(!element?.dataset.tooltip||suppressed.has(element))return;
    if(immediate)show(element);else timer=win.setTimeout(()=>show(element),tooltipDelays[operation(element)?'operation':'control']);
  }
  doc.addEventListener('pointerover',event=>{
    if(inside(event.target,tip)){clearTimeout(leaveTimer);return;}
    const next=trigger(event.target);
    if(!next||next===hovered)return;
    if(hovered)suppressed.delete(hovered);
    hovered=next;
    if(pointerActive||dragging){suppressed.add(next);hide();}else queue(next);
  });
  doc.addEventListener('pointerout',event=>{
    if(!inside(event.target,hovered)&&!inside(event.target,tip))return;
    if(inside(event.relatedTarget,hovered)||inside(event.relatedTarget,tip))return;
    // A small bridge across the fixed 8px gap permits moving into the tooltip.
    clearTimeout(leaveTimer);leaveTimer=win.setTimeout(()=>{
      if(hovered)suppressed.delete(hovered);hovered=null;hide();
    },120);
  });
  doc.addEventListener('focusin',event=>{const next=trigger(event.target);if(next&&(keyboard||next.matches(':focus-visible')))queue(next,true);});
  doc.addEventListener('focusout',event=>{if(inside(event.target,target)&&!inside(event.relatedTarget,target)&&!inside(event.relatedTarget,tip))hide();});
  doc.addEventListener('pointerdown',()=>{keyboard=false;pointerActive=true;dismiss();},true);
  win.addEventListener('pointerup',()=>{pointerActive=false;},true);
  win.addEventListener('pointercancel',()=>{pointerActive=false;dismiss();},true);
  doc.addEventListener('click',dismiss,true);
  doc.addEventListener('dragstart',()=>{dragging=true;dismiss();},true);
  win.addEventListener('dragend',()=>{dragging=false;},true);
  win.addEventListener('keydown',event=>{
    keyboard=true;
    if(event.key==='Escape'||['Meta','Control','Alt','Shift'].includes(event.key))dismiss();
  },true);
  win.addEventListener('blur',()=>{pointerActive=false;dragging=false;dismiss();});
  win.addEventListener('scroll',dismiss,true);
  win.addEventListener('resize',dismiss);
  win.visualViewport?.addEventListener('resize',dismiss);
  win.visualViewport?.addEventListener('scroll',dismiss);
  new MutationObserver(()=>{
    if(!target)return;
    if(!target.isConnected||!target.dataset.tooltip){hide();return;}
    // Language changes update the existing tooltip without disturbing focus.
    if(tip.dataset.source!==target.dataset.tooltip){tip.dataset.source=target.dataset.tooltip;show(target);}
  }).observe(doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-tooltip']});
  const controller={dismiss};controllers.set(doc,controller);return controller;
}
