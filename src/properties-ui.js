import { resolveMessage, t, setText, setAttr, localizedElement, message as translatedMessage } from './i18n.js';
import {propertyTypes,today,inferType,convertProperty,propertySource,preferences,savePreference} from './property-types.js';
import {uiIcon} from './ui-icons.js';
const el=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text!==undefined)n.textContent=text;return n;};
const input=(label)=>{const n=el('input');setAttr(n,'aria-label',()=>resolveMessage(label));return n;};
const button=(label,action)=>{const n=el('button','leaf-block-button');n.type='button';setText(n,()=>resolveMessage(label));setAttr(n,'aria-label',()=>resolveMessage(label));n.onclick=action;return n;};
function typeSelect(label,value) {
  const n=el('select','leaf-property-type');setAttr(n,'aria-label',()=>resolveMessage(label));setAttr(n, 'title', () => t("properties_ui.property_type"));
  for(const [key,name] of Object.entries(propertyTypes)){const o=localizedElement('option','',()=>propertyTypes[key]);o.value=key;n.append(o);}n.value=value;
  const describe=()=>{setAttr(n, 'title', () => t("properties_ui.property_type_click_to_change", {"type": propertyTypes[n.value]}));};describe();n.addEventListener('change',describe);return n;
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
    setAttr(type, 'title', () => t("properties_ui.property_type_click_to_change", {"type": propertyTypes[type.value]}));
  };
  update();type.addEventListener('change',()=>queueMicrotask(update));
  trigger.append(glyph,type);wrap.append(trigger,name);return wrap;
}
function valueControl(type,value,label,save,choices=[],live=false) {
  if(type==='list') {
    const wrap=el('div','leaf-property-list');
    value.forEach((text,index)=>{const chip=el('span','leaf-property-chip',text);chip.append(button(translatedMessage("properties_ui.remove", {"text": text}),()=>save(value.filter((_,i)=>i!==index))));chip.lastChild.innerHTML=uiIcon('close', 12);wrap.append(chip);});
    const add=input(label);setAttr(add,'placeholder',()=>t("properties_ui.enter_an_item_then_press_enter"));
    add.onkeydown=e=>{if(e.isComposing)return;if(e.key==='Escape'){e.preventDefault();e.stopPropagation();add.value='';add.blur();}if(e.key==='Enter'){e.preventDefault();e.stopPropagation();if(add.value.trim())save([...value,add.value.trim()]);}};
    wrap.append(add);return wrap;
  }
  if(type==='enum') {
    const wrap=el('div','leaf-property-enum'),select=el('select');setAttr(select,'aria-label',()=>resolveMessage(label));
    for(const v of [...new Set([String(value),...choices])]){const o=v?el('option','',v):localizedElement('option','',()=>t("properties_ui.choose_an_option"));o.value=v;select.append(o);}select.value=value;
    select.onchange=()=>save(select.value);wrap.append(select);return wrap;
  }
  const n=input(label);n.type=type==='checkbox'?'checkbox':type==='date'?'date':type==='number'?'number':'text';
  if(type==='checkbox')n.checked=value;else n.value=value;
  if(type==='number')n.step='any';
  let original = value;
  n.onfocus=()=>{original=type==='checkbox'?n.checked:type==='number'?Number(n.value):n.value;};
  const submit=()=>{
    if(type==='date'&&!n.value){n.value=original;return;}
    if(type==='number'&&(!n.value||!n.checkValidity())){n.value=original;return;}
    const next=type==='checkbox'?n.checked:type==='number'?Number(n.value):n.value;
    if(next!==original){save(next);original=next;}
  };
  if(type==='checkbox')n.onchange=submit;
  else {
    if(live)n.oninput=submit;
    n.onblur=submit;
    n.onkeydown=e=>{
      if(e.isComposing||e.keyCode===229)return;
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();n.value=original;n.blur();}
      if(e.key==='Enter'){e.preventDefault();e.stopPropagation();submit();n.blur();}
    };
  }
  return n;
}
export function renderProperties(body,getBlock,commit,focusEditor,discardEmpty=()=>{},removeField=()=>{}) {
  body.replaceChildren();const block=getBlock();
  if(!block.valid){body.append(localizedElement('p', 'leaf-property-unsupported', () => t("properties_ui.edit_this_yaml_structure_in_source_mode")));return;}
  const error=el('div','leaf-property-error');error.setAttribute('role','status');
  const refresh=()=>renderProperties(body,getBlock,commit,focusEditor,discardEmpty,removeField);
  block.fields.forEach((field,index)=>{
    const error=el('div','leaf-property-error');error.setAttribute('role','status');
    const row=el('div','leaf-property-row'),name=el('span','leaf-property-key',field.key);
    if(!field.editable){row.append(name,el('span','leaf-property-unsupported',field.value));body.append(row);return;}
    const pref=preferences(field.key),inferred=inferType(field.value);
    const type=(pref.type==='enum'&&typeof field.value==='string')?'enum':pref.type==='text'&&typeof field.value==='string'?'text':inferred;
    const keyInput=input(translatedMessage("properties_ui.property_name", {"key": field.key}));keyInput.className='leaf-property-key';keyInput.value=field.key;setAttr(keyInput, 'title', () => t("properties_ui.rename_property"));
    let renaming=false,composing=false;
    const removeIfEmpty=()=>{
      if(renaming||composing||keyInput.value.trim())return false;
      const valueInput=control.matches('input')?control:control.querySelector('input');
      const current=getBlock().fields[index];
      const empty=current?.value==='' || Array.isArray(current?.value)&&!current.value.length;
      if(!(valueInput && valueInput.type!=='checkbox' && !valueInput.value.trim()) && !empty)return false;
      if(Array.isArray(current?.value)&&current.value.length)return false;
      renaming=true;setText(error,()=> '');removeField(index);return true;
    };
    const renameKey=(explicit=false)=>{
      if(renaming)return;
      const key=keyInput.value.trim(),current=getBlock().fields[index];
      if(key===current.key){setText(error,()=> '');return;}
      if(!key){if(removeIfEmpty())return;if(explicit)setText(error, () => t("properties_ui.this_property_still_has_a_value_enter"));return;}
      if(getBlock().fields.some((f,i)=>i!==index&&f.key===key)){
        setText(error, () => key?t("properties_ui.this_property_name_already_exists_choose_another"):t("properties_ui.the_property_name_cannot_be_empty"));keyInput.value=current.key;return;
      }
      renaming=true;setText(error,()=> '');savePreference(key,preferences(current.key));
      focusEditor();commit({from:current.keyFrom,to:current.keyTo},JSON.stringify(key));
      if(body.isConnected)refresh();
    };
    keyInput.oninput=()=>{setText(error,()=> '');};
    keyInput.onblur=()=>{if(keyInput.value.trim())renameKey();};
    row.addEventListener('compositionstart',()=>composing=true);
    row.addEventListener('compositionend',()=>{composing=false;queueMicrotask(removeIfEmpty);});
    row.addEventListener('input',()=>queueMicrotask(removeIfEmpty));
    row.addEventListener('focusout',()=>setTimeout(()=>{
      if(!row.isConnected||row.contains(document.activeElement)||renaming)return;
      if(removeIfEmpty())return;
      if(!keyInput.value.trim()){
        setText(error, () => t("properties_ui.this_property_still_has_a_value_enter"));
        keyInput.value=getBlock().fields[index].key;
      }
    },0));
    keyInput.onkeydown=e=>{if(e.isComposing)return;if(e.key==='Enter'){e.preventDefault();e.stopPropagation();renameKey(true);}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();keyInput.value=getBlock().fields[index].key;setText(error,()=> '');focusEditor();}};
    const select=typeSelect(translatedMessage("properties_ui.type_of", {"key": field.key}),type);
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
      control.append(button(translatedMessage("properties_ui.edit_choices"),()=>{
        if(control.querySelector('form'))return;
        const form=el('form','leaf-enum-options'),options=input(translatedMessage("properties_ui.options_for", {"key": field.key}));
        setAttr(options,'placeholder',()=>t("properties_ui.separate_options_with_semicolons"));options.value=(pref.options||[]).join('；');
        form.append(options,button(translatedMessage("properties_ui.save_options"),()=>form.requestSubmit()));
        form.onsubmit=e=>{e.preventDefault();savePreference(field.key,{type:'enum',options:[...new Set(options.value.split(/[;；\n]/).map(x=>x.trim()).filter(Boolean))]});refresh();};
        form.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.isComposing){e.preventDefault();e.stopPropagation();form.remove();control.querySelector('button')?.focus();}});
        control.append(form);options.focus();
      }));
    }
    row.append(propertyNameControl(keyInput,select),control,error);body.append(row);
  });
  body.append(error,button(translatedMessage("properties_ui.add_document_property"),()=>{
    if(body.querySelector('.leaf-property-add'))return;
    const form=el('form','leaf-property-add'),key=input(translatedMessage("properties_ui.new_property_name")),holder=el('div','leaf-property-new-value');
    const type=typeSelect(translatedMessage("properties_ui.new_property_type"),'text');let value='';
    setAttr(key,'placeholder',()=>t("properties_ui.property_name_mo0101"));key.required=true;
    const draw=()=>{
      const editing=holder.contains(document.activeElement);
      holder.replaceChildren(valueControl(type.value,value,translatedMessage("properties_ui.new_property_value"),v=>{value=v;if(type.value==='list')draw();},[],true));
      const valueInput = holder.querySelector('input');
      if (valueInput && type.value === 'text') setAttr(valueInput,'placeholder',()=>t("properties_ui.property_value"));
      if(editing)valueInput?.focus();
    };draw();
    type.onchange=()=>{value=type.value==='date'?today():type.value==='checkbox'?false:type.value==='number'?0:type.value==='list'?[]:'';draw();};
    // Enum options can be configured on the created row. Initial value stays editable here.
    type.addEventListener('change',()=>{if(type.value==='enum'){const v=input(translatedMessage("properties_ui.new_property_value"));setAttr(v,'placeholder',()=>t("properties_ui.initial_value"));v.oninput=()=>value=v.value;holder.replaceChildren(v);}});
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
      if(getBlock().fields.some(f=>f.key===name)){key.setCustomValidity(t("properties_ui.enter_a_unique_property_name"));setText(error, () => t("properties_ui.this_property_name_already_exists_choose_another"));if(explicit)key.reportValidity();return;}
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
    key.oninput=()=>{key.setCustomValidity('');setText(error,()=> '');};body.insertBefore(form,addButton);key.focus();
  }));
  const addButton=body.lastChild;
  addButton.classList.add('leaf-property-add-button');addButton.dataset.action='add-property';
  const addGlyph=el('span','leaf-property-add-glyph','+');addGlyph.setAttribute('aria-hidden','true');
  addButton.replaceChildren(addGlyph,localizedElement('span', '', () => t("properties_ui.add_property")));
}
