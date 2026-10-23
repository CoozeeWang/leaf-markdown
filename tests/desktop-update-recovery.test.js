import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import i18next from 'i18next';
import {splitUpdateResult} from '../src/update-result.js';
const source=readFileSync(new URL('../src/update-window.js',import.meta.url),'utf8');
const start=source.indexOf("  const result=t('updates.'");
const end=source.indexOf("  document.querySelector('details').hidden",start);
assert.ok(start>=0&&end>start);
function render(language,state,recovery_location){
 const locale=JSON.parse(readFileSync(new URL('./../src/locales/'+language+'.json',import.meta.url),'utf8'));
 const nodes=Object.fromEntries(['update-result','update-message','update-recovery-location','update-error'].map(id=>[id,{textContent:'',hidden:false}]));
 const translator=i18next.createInstance();
 translator.init({initAsync:false,lng:language,keySeparator:false,interpolation:{escapeValue:false},resources:{[language]:{translation:locale}}});
 const t=(key,values={})=>translator.t(key,values);
 runInNewContext(source.slice(start,end),{splitUpdateResult,actions:{install_failed:true,rolled_back:true,rollback_failed:true},state,snapshot:{state,target_version:'2.0.0',error_code:'native_install_failed',recovery_location},version:'2.0.0',confirms:new Set(['install_failed']),manualInstallation:()=>false,localError:null,errors:{},find:id=>nodes[id],text:(node,value)=>{node.textContent=value;},t});
 return {nodes,t};
}
test('recovery UI shows the native recovery path adjacent to the result in all locales',()=>{
 for(const language of ['zh-Hans','zh-Hant-TW','en'])for(const state of ['install_failed','rollback_failed']){
  const path='/Synthetic/Retained <Leaf>/Previous.app';const {nodes}=render(language,state,path);
  assert.ok(nodes['update-recovery-location'].textContent.includes(path),language+' '+state);
  assert.equal(nodes['update-recovery-location'].hidden,false);
  assert.ok(source.includes("text(find('update-recovery-location')"), 'untrusted native path remains text content');
 }
});
test('recovery UI never claims documents remain open after an installation exit',()=>{
 for(const language of ['zh-Hans','zh-Hant-TW','en'])for(const state of ['install_failed','rolled_back','rollback_failed']){
  const {nodes,t}=render(language,state,null);
  const combined=nodes['update-result'].textContent+nodes['update-message'].textContent;
  assert.equal(combined.replace(/\s/g,''),t('updates.'+state,{version:'2.0.0'}).replace(/\s/g,''),language+' '+state);
  assert.equal(nodes['update-error'].hidden,true,'approved recovery instructions replace the duplicate generic error');
  assert.equal(nodes['update-recovery-location'].hidden,true,'no absent recovery path is shown');
  assert.ok(!combined.includes(t('updates.error_generic')),'no claim that documents are still open');
 }
});

test('recovery UI allows a fresh check after restart without reusing an absent candidate',()=>{
 const renderStart=source.indexOf("  action.textContent = t('updates.'");
 const renderEnd=source.indexOf("  const progress =",renderStart);
 const clickStart=source.indexOf('action.onclick=()=>{');
 const clickEnd=source.indexOf('async function close()',clickStart);
 const action={disabled:true,textContent:''},calls=[];
 const snapshot={state:'install_failed',target_version:'2.0.0',candidate_id:null};
 const prefix=source.slice(source.indexOf('const busy ='),source.indexOf('let snapshot ='));
 runInNewContext(prefix+'\n'+source.slice(renderStart,renderEnd)+'\n'+source.slice(clickStart,clickEnd)+'\naction.onclick();',{snapshot,state:snapshot.state,action,pending:false,nativePanel:false,t:key=>key,request:command=>calls.push(command),confirm:()=>calls.push('confirmation')});
 assert.equal(action.disabled,false,'a reconciled failure can check again');
 assert.equal(action.textContent,'updates.check_again');
 assert.deepEqual(calls,['update_check']);
});
