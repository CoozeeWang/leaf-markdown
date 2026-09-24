import {propertyTypes,today,inferType,convertProperty,propertySource,preferences,savePreference} from './property-types.js';
import {uiIcon} from './ui-icons.js';
const el=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text!==undefined)n.textContent=text;return n;};
const input=(label)=>{const n=el('input');n.setAttribute('aria-label',label);return n;};
const button=(label,action)=>{const n=el('button','leaf-block-button',label);n.type='button';n.setAttribute('aria-label',label);n.onclick=action;return n;};
function typeSelect(label,value) {
  const n=el('select','leaf-property-type');n.setAttribute('aria-label',label);n.title='属性类型';
  for(const [key,name] of Object.entries(propertyTypes)){const o=el('option','',name);o.value=key;n.append(o);}n.value=value;
  const describe=()=>{n.title=`属性类型：${propertyTypes[n.value]}（点击更改）`;};describe();n.addEventListener('change',describe);return n;
}
function propertyNameControl(name,type) {
  const paths={
    text:'<path d="M4 6h16M4 12h11M4 18h14"/>',
    date:'<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
    list:'<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
    enum:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 12h5m3-1 2 2 2-2"/>',
    checkbox:'<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>',
    number:'<path d="m10 3-2 18M16 3l-2 18M4 9h16M3 15h16"/>',
  };
  const wrap=el('div','leaf-property-name-control'),trigger=el('span','leaf-property-type-trigger'),glyph=el('span','leaf-property-type-glyph');
  glyph.setAttribute('aria-hidden','true');
  const update=()=>{
    glyph.innerHTML=`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[type.value]}</svg>`;
    trigger.dataset.type=type.value;
    type.title=`属性类型：${propertyTypes[type.value]}（点击更改）`;
  };
  update();type.addEventListener('change',()=>queueMicrotask(update));
  trigger.append(glyph,type);wrap.append(trigger,name);return wrap;
}
function valueControl(type,value,label,save,choices=[]) {
  if(type==='list') {
    const wrap=el('div','leaf-property-list');
    value.forEach((text,index)=>{const chip=el('span','leaf-property-chip',text);chip.append(button(`删除 ${text}`,()=>save(value.filter((_,i)=>i!==index))));chip.lastChild.innerHTML=uiIcon('close', 12);wrap.append(chip);});
    const add=input(label);add.placeholder='输入一项后按回车';
    add.onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();e.stopPropagation();if(add.value.trim())save([...value,add.value.trim()]);}};
    wrap.append(add);return wrap;
  }
  if(type==='enum') {
    const wrap=el('div','leaf-property-enum'),select=el('select');select.setAttribute('aria-label',label);
    for(const v of [...new Set([String(value),...choices])]){const o=el('option','',v||'请选择');o.value=v;select.append(o);}select.value=value;
    select.onchange=()=>save(select.value);wrap.append(select);return wrap;
  }
  const n=input(label);n.type=type==='checkbox'?'checkbox':type==='date'?'date':type==='number'?'number':'text';
  if(type==='checkbox')n.checked=value;else n.value=value;
  if(type==='number')n.step='any';
  n.oninput=()=>{
    if(type==='date'&&!n.value)return;
    if(type==='number'&&(!n.value||!n.checkValidity()))return;
    save(type==='checkbox'?n.checked:type==='number'?Number(n.value):n.value);
  };return n;
}
export function renderProperties(body,getBlock,commit,focusEditor,discardEmpty=()=>{},removeField=()=>{}) {
  body.replaceChildren();const block=getBlock();
  if(!block.valid){body.append(el('p','leaf-property-unsupported','此 YAML 结构需要使用源码编辑，原文保持不变。'));return;}
  const error=el('div','leaf-property-error');error.setAttribute('role','status');
  const refresh=()=>renderProperties(body,getBlock,commit,focusEditor,discardEmpty,removeField);
  block.fields.forEach((field,index)=>{
    const row=el('div','leaf-property-row'),name=el('span','leaf-property-key',field.key);
    if(!field.editable){row.append(name,el('span','leaf-property-unsupported',field.value));body.append(row);return;}
    const pref=preferences(field.key),inferred=inferType(field.value);
    const type=(pref.type==='enum'&&typeof field.value==='string')?'enum':pref.type==='text'&&typeof field.value==='string'?'text':inferred;
    const keyInput=input(`属性名：${field.key}`);keyInput.className='leaf-property-key';keyInput.value=field.key;keyInput.title='修改属性名';
    let renaming=false,composing=false;
    const removeIfEmpty=()=>{
      if(renaming||composing||keyInput.value.trim())return false;
      const valueInput=control.matches('input')?control:control.querySelector('input');
      const current=getBlock().fields[index];
      const empty=current?.value==='' || Array.isArray(current?.value)&&!current.value.length;
      if(!(valueInput && valueInput.type!=='checkbox' && !valueInput.value.trim()) && !empty)return false;
      if(Array.isArray(current?.value)&&current.value.length)return false;
      renaming=true;error.textContent='';removeField(index);return true;
    };
    const renameKey=(explicit=false)=>{
      if(renaming)return;
      const key=keyInput.value.trim(),current=getBlock().fields[index];
      if(key===current.key)return;
      if(!key){if(removeIfEmpty())return;if(explicit)error.textContent='属性值仍有内容，请填写属性名；如需删除，请同时清空属性值。';return;}
      if(getBlock().fields.some((f,i)=>i!==index&&f.key===key)){
        error.textContent=key?'属性名已存在，请更换名称。':'属性名不能为空。';keyInput.value=current.key;return;
      }
      renaming=true;error.textContent='';savePreference(key,preferences(current.key));
      focusEditor();commit({from:current.keyFrom,to:current.keyTo},JSON.stringify(key));
      if(body.isConnected)refresh();
    };
    keyInput.oninput=()=>{error.textContent='';};
    keyInput.onblur=()=>{if(keyInput.value.trim())renameKey();};
    row.addEventListener('compositionstart',()=>composing=true);
    row.addEventListener('compositionend',()=>{composing=false;queueMicrotask(removeIfEmpty);});
    row.addEventListener('input',()=>queueMicrotask(removeIfEmpty));
    row.addEventListener('focusout',()=>setTimeout(()=>{
      if(!row.isConnected||row.contains(document.activeElement)||renaming)return;
      if(removeIfEmpty())return;
      if(!keyInput.value.trim()){
        error.textContent='属性值仍有内容，请填写属性名；如需删除，请同时清空属性值。';
        keyInput.value=getBlock().fields[index].key;
      }
    },0));
    keyInput.onkeydown=e=>{if(e.isComposing)return;if(e.key==='Enter'){e.preventDefault();e.stopPropagation();renameKey(true);}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();keyInput.value=getBlock().fields[index].key;focusEditor();}};
    const select=typeSelect(`${field.key} 类型`,type);
    const setValue=(value,structural=false)=>{
      const current=getBlock().fields[index];
      if(structural)focusEditor();
      commit(current,propertySource(value));
    };
    select.onchange=()=>{
      try {
        const next=convertProperty(getBlock().fields[index].value,select.value);
        savePreference(field.key,{...pref,type:select.value});
        setValue(next,true);if(body.isConnected)refresh();
      }catch(e){error.textContent=e.message;select.value=type;}
    };
    const control=valueControl(type,field.value,field.key,v=>setValue(v,type==='list'),pref.options||[]);
    // Retain focused scalar controls across CodeMirror transactions.
    const scalar=control.matches('input')?control:null;
    if(scalar){
      scalar.dataset.field=index;
      scalar.addEventListener('keydown',e=>{
        if(e.key==='Enter'&&!e.isComposing&&e.keyCode!==229&&scalar.checkValidity()){
          e.preventDefault();e.stopPropagation();focusEditor();
        }
      });
    }
    if(type==='enum'){
      control.querySelector('select').dataset.field=index;
      control.append(button('设置枚举选项',()=>{
        if(control.querySelector('form'))return;
        const form=el('form','leaf-enum-options'),options=input(`${field.key} 候选项`);
        options.placeholder='选项用分号分隔';options.value=(pref.options||[]).join('；');
        form.append(options,button('保存选项',()=>form.requestSubmit()));
        form.onsubmit=e=>{e.preventDefault();savePreference(field.key,{type:'enum',options:[...new Set(options.value.split(/[;；\n]/).map(x=>x.trim()).filter(Boolean))]});refresh();};
        control.append(form);options.focus();
      }));
    }
    row.append(propertyNameControl(keyInput,select),control);body.append(row);
  });
  body.append(error,button('添加文档属性',()=>{
    if(body.querySelector('.leaf-property-add'))return;
    const form=el('form','leaf-property-add'),key=input('新属性名'),holder=el('div','leaf-property-new-value');
    const type=typeSelect('新属性类型','text');let value='';
    key.placeholder='属性名';key.required=true;
    const draw=()=>{
      const editing=holder.contains(document.activeElement);
      holder.replaceChildren(valueControl(type.value,value,'新属性值',v=>{value=v;if(type.value==='list')draw();},[]));
      const valueInput = holder.querySelector('input');
      if (valueInput && type.value === 'text') valueInput.placeholder = '属性值';
      if(editing)valueInput?.focus();
    };draw();
    type.onchange=()=>{value=type.value==='date'?today():type.value==='checkbox'?false:type.value==='number'?0:type.value==='list'?[]:'';draw();};
    // Enum options can be configured on the created row. Initial value stays editable here.
    type.addEventListener('change',()=>{if(type.value==='enum'){const v=input('新属性值');v.placeholder='初始值';v.oninput=()=>value=v.value;holder.replaceChildren(v);}});
    form.append(propertyNameControl(key,type),holder);
    let submitted=false,composing=false;
    const finish=(explicit=false)=>{
      if(submitted||composing||!form.isConnected)return;
      const name=key.value.trim();
      if(!name){
        const pending=holder.querySelector('input')?.value.trim() ?? '';
        if(!pending && (value==='' || Array.isArray(value)&&!value.length)) {
          submitted=true;form.remove();discardEmpty();
        }
        return;
      }
      if(getBlock().fields.some(f=>f.key===name)){key.setCustomValidity('请输入不重复的属性名');error.textContent='属性名已存在，请更换名称。';if(explicit)key.reportValidity();return;}
      if(!form.checkValidity())return;
      if(type.value==='list'){
        const pending=holder.querySelector('input')?.value.trim();
        if(pending)value=[...value,pending];
      }
      submitted=true;
      savePreference(name,{...preferences(name),type:type.value});
      if(explicit)focusEditor();
      commit(null,`${JSON.stringify(name)}: ${propertySource(value)}\n`);
    };
    form.onsubmit=e=>{e.preventDefault();finish(true);};
    // WebKit does not implicitly submit a form with multiple text inputs and
    // no submit button. Handle Return explicitly, after IME confirmation.
    form.addEventListener('keydown',e=>{
      if(e.isComposing || composing || e.keyCode===229 || e.target.tagName==='SELECT')return;
      if(e.key==='Enter'){e.preventDefault();e.stopPropagation();finish(true);}
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();submitted=true;form.remove();discardEmpty();focusEditor();}
    },true);
    form.addEventListener('compositionstart',()=>composing=true);
    form.addEventListener('compositionend',()=>composing=false);
    form.addEventListener('focusout',()=>setTimeout(()=>{
      if(!form.contains(document.activeElement))finish();
    },0));
    key.oninput=()=>{key.setCustomValidity('');error.textContent='';};body.insertBefore(form,addButton);key.focus();
  }));
  const addButton=body.lastChild;
  addButton.classList.add('leaf-property-add-button');
  const addGlyph=el('span','leaf-property-add-glyph','+');addGlyph.setAttribute('aria-hidden','true');
  addButton.replaceChildren(addGlyph,el('span','','添加属性'));
}
