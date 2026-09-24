export const propertyTypes = {text:'文本',date:'日期',list:'列表',enum:'枚举',checkbox:'复选框',number:'数字'};
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
    throw new Error('请先将值改为 true 或 false，再转换为复选框。');
  }
  if(type==='number') {
    if(value==='')return 0;
    if((typeof value==='string'||typeof value==='number')&&Number.isFinite(Number(value)))return Number(value);
    throw new Error('当前值不是数字，未更改原文。');
  }
  if(type==='date') {
    if(value==='')return today();
    if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value)return value;
    throw new Error('请先填写 YYYY-MM-DD 格式的日期，未更改原文。');
  }
  throw new Error('未知属性类型');
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
