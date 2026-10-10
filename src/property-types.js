import { t } from './i18n.js';
export const propertyTypes = {get text() { return t("property_types.text"); },get date() { return t("property_types.date"); },get list() { return t("property_types.list"); },get enum() { return t("property_types.choice"); },get checkbox() { return t("property_types.checkbox"); },get number() { return t("property_types.number"); }};
export function today() {
  const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
export function inferType(value) {
  return Array.isArray(value)?'list':typeof value==='boolean'?'checkbox':typeof value==='number'?'number':/^\d{4}-\d{2}-\d{2}$/.test(value)?'date':'text';
}
export function convertProperty(value,type) {
  if(type==='text'||type==='enum')return Array.isArray(value)?value.join('；'):String(value);
  if(type==='list')return Array.isArray(value)?value:value===''?[]:[String(value)];
  if(type==='checkbox') {
    if(value===''||value===false||value==='false')return false;
    if(value===true||value==='true')return true;
    throw new Error(t("property_types.change_the_value_to_true_or_false"));
  }
  if(type==='number') {
    if(value==='')return 0;
    if((typeof value==='string'||typeof value==='number')&&Number.isFinite(Number(value)))return Number(value);
    throw new Error(t("property_types.the_current_value_is_not_a_number"));
  }
  if(type==='date') {
    if(value==='')return today();
    if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value)return value;
    throw new Error(t("property_types.enter_a_date_in_yyyy_mm_dd"));
  }
  throw new Error(t("property_types.unknown_property_type"));
}
export function propertySource(value) {return JSON.stringify(value);}
export function preferences(key) {
  try {return JSON.parse(localStorage.getItem('leaf-property-types')||'{}')[key]||{};}catch{return {};}
}
export function savePreference(key,value) {
  let data;try{data=JSON.parse(localStorage.getItem('leaf-property-types')||'{}');}catch{data={};}
  // Property names are user input; define an own property even for __proto__.
  Object.defineProperty(data,key,{value,enumerable:true,configurable:true,writable:true});
  localStorage.setItem('leaf-property-types',JSON.stringify(data));
}
