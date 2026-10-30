import {parseOutline,planOutlineMove} from './outline-sections.js';

export function setupOutlineDrag(list,{editor,reading,hideTooltip=()=>{}}) {
  let drag=null,plan=null,frame=0,suppress=false;
  const marker=document.createElement('div');marker.className='outline-drop-line';marker.hidden=true;marker.setAttribute('aria-hidden','true');document.body.append(marker);
  const mac=()=>/mac|iphone|ipad/i.test(navigator.userAgentData?.platform||navigator.platform);
  const modifier=e=>mac()?e.metaKey:e.ctrlKey;
  const clearMarker=()=>{plan=null;marker.hidden=true;delete marker.dataset.level;delete marker.dataset.parent;};
  const clear=()=>{const saved=drag;drag=null;cancelAnimationFrame(frame);frame=0;clearMarker();list.classList.remove('outline-dragging');if(saved?.button.hasPointerCapture(saved.pointer))saved.button.releasePointerCapture(saved.pointer);};
  const valid=()=>drag&&!reading()&&editor().sectionMoveAllowed()&&editor().view.state.doc===drag.snapshot&&editor().mutationDocumentGeneration()===drag.generation;
  const locate=()=>{
    clearMarker();if(!valid()){clear();return;}
    const box=list.getBoundingClientRect(),{x,y}=drag;
    if(!list.getClientRects().length||x<box.left||x>box.right||y<box.top||y>box.bottom){clear();return;}
    const rows=[...list.querySelectorAll('.outline-row')].filter(r=>r.getClientRects().length);
    let previous=null,next=null,line=box.top+10;
    for(const row of rows){const r=row.getBoundingClientRect();if(y<r.top+r.height/2){next=row;line=r.top;break;}previous=row;line=r.bottom;}
    const fromRow=r=>Number(r.querySelector('.outline-item')?.dataset.from);
    const prev=previous&&drag.headings.find(h=>h.from===fromRow(previous));
    let before=next?fromRow(next):null;
    if(previous?.querySelector('[aria-expanded=false]'))before=prev.end===drag.source.length?null:prev.end;
    const level=Math.max(1,Math.min(6,drag.level+Math.round((x-drag.startX)/14)));
    if(level>(prev?prev.level+1:1)||line<box.top+2||line>box.bottom-2)return;
    const key=`${before}:${level}`;
    if(key!==drag.key){drag.key=key;drag.cached=planOutlineMove(drag.source,drag.from,before,level,drag.headings);}
    if(!drag.cached)return;
    plan={...drag.cached,before};
    const first=list.querySelector('.outline-item'),base=first.getBoundingClientRect().left+parseFloat(getComputedStyle(first).paddingLeft);
    marker.style.left=`${base+(level-1)*14}px`;marker.style.top=`${line-1}px`;marker.style.width=`${Math.max(8,box.right-8-base-(level-1)*14)}px`;
    marker.dataset.level=level;marker.dataset.parent=plan.parent??'';marker.hidden=false;
  };
  const scroll=()=>{if(!valid()){clear();return;}const box=list.getBoundingClientRect(),delta=drag.y<box.top+24?-6:drag.y>box.bottom-24?6:0;if(delta){list.scrollTop+=delta;locate();}if(drag)frame=requestAnimationFrame(scroll);};
  list.addEventListener('pointerdown',e=>{
    const button=e.target.closest('.outline-item');
    if(!button||e.button!==0||!modifier(e)||reading()||!editor().sectionMoveAllowed())return;
    clear();const snapshot=editor().view.state.doc,source=snapshot.toString(),headings=parseOutline(source),from=Number(button.dataset.from),item=headings.find(h=>h.from===from);
    if(!item||headings.some((h,i)=>h.level>(i?headings[i-1].level:0)+1))return;
    drag={button,snapshot,source,headings,from,level:item.level,generation:editor().mutationDocumentGeneration(),pointer:e.pointerId,startX:e.clientX,startY:e.clientY,x:e.clientX,y:e.clientY,active:false};
    e.preventDefault(); // Keep editor focus/selection stable throughout the gesture.
    button.setPointerCapture(e.pointerId);
  });
  document.addEventListener('pointermove',e=>{
    if(!drag||e.pointerId!==drag.pointer)return;if(!valid()){clear();return;}
    drag.x=e.clientX;drag.y=e.clientY;
    if(!drag.active){if(Math.hypot(drag.x-drag.startX,drag.y-drag.startY)<5)return;drag.active=true;suppress=true;hideTooltip();list.classList.add('outline-dragging');frame=requestAnimationFrame(scroll);}
    e.preventDefault();locate();
  });
  document.addEventListener('pointerup',e=>{
    if(drag&&e.pointerId===drag.pointer){if(drag.active)locate();const saved=drag,target=plan;clear();if(saved&&target)editor().moveOutlineSection(saved.snapshot,saved.generation,saved.from,target.before,target.level);}
    setTimeout(()=>suppress=false,0);
  });
  list.addEventListener('dragstart',e=>{if(e.target.closest('.outline-item'))e.preventDefault();});
  document.addEventListener('pointercancel',()=>{clear();suppress=false;});
  window.addEventListener('blur',()=>{clear();suppress=false;});window.addEventListener('resize',clear);
  window.addEventListener('keydown',e=>{if(e.key==='Escape'&&drag){e.preventDefault();clear();}},true);
  return {suppressClick:()=>suppress,active:()=>!!drag?.active};
}
