export function inlineRename({anchor,value,apply}) {
  if(!anchor||document.querySelector('.inline-rename'))return;
  const field=document.createElement('input'),error=document.createElement('span');
  field.className='inline-rename';field.value=value;field.setAttribute('aria-label','新文件名');
  error.className='inline-rename-error';error.setAttribute('role','status');
  const box=anchor.getBoundingClientRect(),style=getComputedStyle(anchor),inset=parseFloat(style.paddingLeft)||0,height=parseFloat(style.lineHeight)||box.height;
  field.style.cssText=`position:fixed;left:${box.left+inset}px;top:${box.top}px;width:${box.width-inset}px;height:${height}px;`;
  field.style.font=style.font;field.style.color=style.color;
  error.style.cssText=`position:fixed;left:${box.left+inset}px;top:${box.top+height+4}px;max-width:${box.width-inset}px;`;
  let busy=false,closed=false;
  const close=()=>{if(closed)return;closed=true;document.removeEventListener('keydown',key,true);window.removeEventListener('resize',close);document.removeEventListener('scroll',close,true);field.remove();error.remove();anchor.style.visibility='';};
  const submit=async()=>{if(busy||closed)return;const name=field.value.trim();if(!name){error.textContent='请输入文件名';return;}busy=true;field.readOnly=true;try{await apply(name);close();}catch(e){error.textContent=String(e.message||e);busy=false;field.readOnly=false;field.focus();}};
  const key=e=>{e.stopPropagation();if(e.isComposing)return;if(e.key==='Enter'){e.preventDefault();void submit();}if(e.key==='Escape'){e.preventDefault();if(!busy)close();}};
  field.onblur=()=>{if(!busy)close();};anchor.style.visibility='hidden';document.body.append(field,error);
  document.addEventListener('keydown',key,true);window.addEventListener('resize',close);document.addEventListener('scroll',close,true);field.focus();field.select();
}
