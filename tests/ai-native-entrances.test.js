import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the production writing function with isolated I/O and DOM adapters.
// Actual CodeMirror/WK and native menu/window proofs run in their own fixtures.
const source=await readFile(new URL('../src/writing-tools.js',import.meta.url),'utf8');
function writingHarness(importAttachment) {
  let content='Synthetic draft',revision=0,locked=false,update;
  const node=()=>({addEventListener(){},insertBefore(){},querySelector:()=>node(),closest:()=>null,setAttribute(){}});
  const view={dom:node(),state:{selection:{main:{from:0,to:0}},doc:{toString:()=>content,sliceString:(from,to)=>content.slice(from,to)}},dispatch(spec){
    if(typeof spec.effects==='function')update=spec.effects;
    if(spec.changes){const {from,to,insert}=spec.changes;content=content.slice(0,from)+insert+content.slice(to);revision++;}
    update?.({docChanged:!!spec.changes,changes:{mapPos:value=>value}});
  },focus(){}};
  const editor={view,mutationDocumentGeneration:()=>0,mutationAllowed:()=>!locked,mcpSnapshot:()=>({content,revision})};
  const context=vm.createContext({document:{querySelector:()=>node(),createElement:node,addEventListener(){}},window:node(),setTimeout,clearTimeout,AbortController,StateEffect:{appendConfig:{of:value=>value}},EditorView:{updateListener:{of:value=>value}},setResourceReader(){},setResourceRevealer(){},setAttr(){},shortcutText:value=>value,t:value=>value,translatedMessage:(_key,{error})=>error,isolateHistory:{of:value=>value},bodyStart:()=>0,markdownLink:(label,target)=>`[${label}](${target})`,attachmentInsertion:(_source,b,links)=>({text:links.join(' '),anchor:b.from+links.join(' ').length}),refreshImages(){},getCurrentWindow:()=>({label:'synthetic-window'})});
  vm.runInContext(source.replace(/^import .*$/gm,'').replace(/^export /gm,''),context);
  const writing=context.setupWriting({editor,desktop:true,invoke:importAttachment,save:async()=>true,choose:async()=>['synthetic.txt'],serialized:action=>action(),editable:()=>true,status(){},icon:()=>''});
  return {writing,snapshot:()=>({content,revision}),lock(value){locked=value;update?.({docChanged:false});}};
}
test('locked writing tools refuse attachment I/O before import',async()=>{
  let imports=0;const h=writingHarness(async()=>{imports++;return '.assets/synthetic.txt';});
  const original=h.snapshot();h.lock(true);await h.writing.attachments(['synthetic.txt'],false);
  assert.equal(imports,0);assert.deepEqual(h.snapshot(),original);
});
test('pre-lock attachment completion remains invalid after stop',async()=>{
  let release,started;const ready=new Promise(resolve=>{started=resolve;});
  const waiting=new Promise(resolve=>{release=resolve;});
  const h=writingHarness(async()=>{started();return waiting;});const original=h.snapshot();
  const pending=h.writing.attachments(['synthetic.txt'],false);await ready;
  h.lock(true);h.lock(false);release('.assets/synthetic.txt');await pending;
  assert.deepEqual(h.snapshot(),original);
});
