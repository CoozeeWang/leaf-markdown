import {parseOutline, planSectionMove} from './outline-sections.js';

export function setupOutlineDrag(list, {editor, reading}) {
  let drag = null, marker = null, frame = 0, pointerY = 0, ignoreClickUntil = 0;
  const clearMarker = () => {marker?.classList.remove('outline-drop-before','outline-drop-after'); marker=null;};
  const clear = () => {
    clearMarker(); cancelAnimationFrame(frame); frame=0;
    list.querySelector('.outline-dragging')?.classList.remove('outline-dragging');
    drag=null;
  };
  const valid = () => drag && !reading() && editor().sectionMoveAllowed()
    && editor().view.state.doc === drag.snapshot && editor().mutationDocumentGeneration() === drag.generation;
  const autoScroll = () => {
    if (!valid()) {clear();return;}
    const box=list.getBoundingClientRect();
    const delta=pointerY<box.top+32 ? -10 : pointerY>box.bottom-32 ? 10 : 0;
    if(delta) {list.scrollTop+=delta;clearMarker();}
    frame=requestAnimationFrame(autoScroll);
  };
  list.addEventListener('dragstart', event => {
    const button=event.target.closest('.outline-item');
    if(!button || reading() || !editor().sectionMoveAllowed()) {event.preventDefault();return;}
    clear();
    const snapshot=editor().view.state.doc, source=snapshot.toString();
    drag={snapshot, source, headings:parseOutline(source), from:Number(button.dataset.from),
      generation:editor().mutationDocumentGeneration(), plans:new Map()};
    button.classList.add('outline-dragging');
    event.dataTransfer.effectAllowed='move';
    // No Markdown payload: dropping outside the outline cannot insert a copy.
    event.dataTransfer.setData('application/x-leaf-outline','section');
    event.stopPropagation();
    pointerY=event.clientY; frame=requestAnimationFrame(autoScroll);
  });
  const locate = event => {
    clearMarker();
    if(!valid()) return null;
    const button=event.target.closest('.outline-item');
    if(!button || !list.contains(button)) return null;
    const box=button.getBoundingClientRect(), side=event.clientY<box.top+box.height/2?'before':'after';
    const target=Number(button.dataset.from), key=`${target}:${side}`;
    if(!drag.plans.has(key)) {
      drag.plans.clear(); // Retain at most one potentially large replacement.
      drag.plans.set(key,planSectionMove(drag.source,drag.from,target,side,drag.headings));
    }
    if(!drag.plans.get(key)) return null;
    marker=button.closest(side==='after'?'li':'.outline-row');marker.classList.add(`outline-drop-${side}`);
    return {target,side};
  };
  list.addEventListener('dragover',event=>{
    if(!drag)return;
    pointerY=event.clientY;
    const target=locate(event);
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect=target?'move':'none';
  });
  list.addEventListener('drop',event=>{
    if(!drag)return;
    event.preventDefault();event.stopPropagation();
    const target=locate(event), saved=drag;
    clear();ignoreClickUntil=performance.now()+300;
    if(target)editor().moveSection(saved.snapshot,saved.generation,saved.from,target.target,target.side);
  });
  list.addEventListener('dragleave',event=>{if(!list.contains(event.relatedTarget)){clearMarker();pointerY=NaN;}});
  window.addEventListener('dragend',()=>{if(drag)ignoreClickUntil=performance.now()+300;clear();});
  window.addEventListener('blur',clear);
  window.addEventListener('keydown',event=>{if(event.key==='Escape'&&drag){event.preventDefault();clear();}},true);
  return {suppressClick:()=>performance.now()<ignoreClickUntil};
}
