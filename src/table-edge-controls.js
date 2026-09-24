import {shortcutText} from './platform-shortcuts.js';
import {uiIcon} from './ui-icons.js';
// Controls live outside the scrolling table; they never take layout space.
export function tableEdgeControls(root, table, act) {
  const control=(label,text)=>{
    const b=document.createElement('button'); b.type='button'; b.className='leaf-table-edge';
    b.setAttribute('aria-label',label); b.title=label; b.textContent=text; b.hidden=true;
    b.addEventListener('mousedown',e=>e.preventDefault()); root.append(b); return b;
  };
  const insert=control('插入行或列','+'), row=control('行操作','⋯'), col=control('列操作','⋯');
  insert.innerHTML=uiIcon('plus',14);
  const guide=document.createElement('div');guide.className='leaf-table-insert-guide';guide.hidden=true;root.append(guide);
  const menu=document.createElement('div'); menu.className='leaf-table-menu'; menu.hidden=true; root.append(menu);
  // Keep CodeMirror from moving focus and closing the menu before mouseup.
  menu.addEventListener('mousedown',e=>e.preventDefault());
  menu.addEventListener('keydown',()=>menu.classList.remove('pointer-open'));
  let currentRow=0,currentCol=0,target=null,menuTrigger=null;
  const position=(el,x,y)=>{el.style.left=`${x}px`;el.style.top=`${y}px`;el.hidden=false;};
  const hide=()=>{if(!menu.hidden)return;guide.hidden=insert.hidden=true;if(!root.contains(document.activeElement))row.hidden=col.hidden=true;};
  const close=()=>{menu.hidden=true;hide();};
  root.addEventListener('mouseleave',hide);
  root.addEventListener('focusout',()=>setTimeout(()=>{if(!root.contains(document.activeElement))close();},0));
  root.addEventListener('keydown',e=>{if(e.key==='Escape'&&!menu.hidden){e.preventDefault();e.stopPropagation();close();menuTrigger?.focus();}});
  table.parentElement.addEventListener('scroll',close);
  table.addEventListener('focusin',e=>{
    const cell=e.target.closest('th,td');if(!cell)return;
    currentRow=cell.parentElement.rowIndex;currentCol=cell.cellIndex;
    const r=cell.getBoundingClientRect(),box=root.getBoundingClientRect();
    position(row,0,r.top-box.top+r.height/2);position(col,r.left-box.left+r.width/2,0);
  });
  table.addEventListener('mousemove',e=>{
    if(!menu.hidden)return;
    const cell=e.target.closest('th,td');if(!cell)return;
    currentRow=cell.parentElement.rowIndex;currentCol=cell.cellIndex;
    const r=cell.getBoundingClientRect(), box=root.getBoundingClientRect();
    const x=r.left-box.left,y=r.top-box.top;
    position(row,0,y+r.height/2);position(col,x+r.width/2,0);
    const edges=[['col',currentCol,Math.abs(e.clientX-r.left),x,y+r.height/2],['col',currentCol+1,Math.abs(e.clientX-r.right),x+r.width,y+r.height/2],
      ['row',currentRow,Math.abs(e.clientY-r.top),x+r.width/2,y],['row',currentRow+1,Math.abs(e.clientY-r.bottom),x+r.width/2,y+r.height]]
      .filter(([axis,i])=>axis!=='row'||i>0).sort((a,b)=>a[2]-b[2]);
    target=edges[0];
    if(target[2]<10){position(insert,target[3],target[4]);insert.setAttribute('aria-label',target[0]==='row'?'在此插入行':'在此插入列');insert.title=insert.getAttribute('aria-label');
      guide.hidden=false;guide.style.cssText=target[0]==='row'?`left:0;right:0;top:${target[4]}px;height:2px`:`top:0;bottom:0;left:${target[3]}px;width:2px`;
    }
    else guide.hidden=insert.hidden=true;
  });
  insert.onclick=()=>{if(target)act(target[0],target[1],false,currentRow,currentCol);};
  const open=(axis,handle,pointer=false)=>{
    menuTrigger=handle;
    menu.classList.toggle('pointer-open',pointer);
    const index=axis==='row'?currentRow:currentCol;
    menu.replaceChildren();
    const actions=axis==='row' ? [['删除此行','row',index,true],['左侧添加列','col',0,false]]
      : [['删除此列','col',index,true],['上方添加行','row',1,false]];
    for(const [label,actionAxis,i,remove] of actions){
      const b=document.createElement('button');b.type='button';b.textContent=label;
      b.title=remove?shortcutText(`${label}（⌘Z 撤销）`):label;
      b.disabled=remove&&(actionAxis==='row'&&i===0 || actionAxis==='col'&&table.rows[0].cells.length===1);
      b.onclick=()=>{close();act(actionAxis,i,remove,currentRow,currentCol);};menu.append(b);
    }
    menu.hidden=false;menu.style.left=`${Math.max(0,Math.min(parseFloat(handle.style.left),root.clientWidth-150))}px`;
    menu.style.top=`${Math.max(0,parseFloat(handle.style.top)+12)}px`;menu.querySelector('button:not(:disabled)').focus();
  };
  row.onclick=e=>open('row',row,e.detail>0);col.onclick=e=>open('col',col,e.detail>0);
}
