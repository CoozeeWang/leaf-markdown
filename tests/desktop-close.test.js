import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../src/desktop.js',import.meta.url),'utf8');
async function fixture(label,{dirty=false,choice='cancel',save=true,allowed=true,manualDriver=false}={}) {
  const calls=[],listeners=new Map();let handler,destroyed=0,prevented=false;
  const window={label,onCloseRequested:async callback=>{handler=callback;},listen:async(name,callback)=>{listeners.set(name,callback);},destroy:async()=>{calls.push('destroy');destroyed++;}};
  const context={closing:false,closingQuitId:null,draftTimer:0,participant:{manualDriver},
    session:{ready:true,path:'synthetic.md',idle:async()=>calls.push('idle'),checkpoint:async()=>calls.push('checkpoint')},
    hooks:{dirty:()=>dirty,status:message=>calls.push('error:'+message)},
    clearTimeout:()=>{},getCurrentWindow:()=>window,fileNameFromPath:path=>path,t:key=>key,
    confirmDocumentClose:async()=>{calls.push('prompt:'+choice);return choice;},
    desktopSave:async()=>{calls.push('save');if(save)dirty=false;return save;},
    invoke:async(command,args)=>{
      calls.push(command);
      if(label==='main'&&command.startsWith('update_'))throw Error('window_role_denied');
      if(command==='update_close_disposition')return {allowed,action_id:'owned-close',window_nonce:7};
      if(command==='ordinary_quit_cancelled')assert.equal(args.quitId,19);
    },
  };
  const begin=source.indexOf('async function closeDocument('),end=source.indexOf('export async function initDesktop',begin);
  runInNewContext(source.slice(begin,end),context);
  const close=context.closeDocument;context.closeDocument=(...args)=>(context.pending=close(...args));
  const from=source.indexOf('  const window = getCurrentWindow();',end),until=source.indexOf("  await window.listen('leaf-native-rename'",from);
  assert.ok(from>=0&&until>from);
  await runInNewContext('(async()=>{'+source.slice(from,until)+'})()',context);
  return {calls,listeners,get destroyed(){return destroyed;},get dirty(){return dirty;},get prevented(){return prevented;},
    async nativeClose(){handler?.({preventDefault(){prevented=true;}});if(context.pending)await context.pending;if(!prevented)destroyed++;},
    async quit(){listeners.get('leaf-close')?.({payload:{quit_id:19}});if(context.pending)await context.pending;},
  };
}

test('launcher native close keeps OS ownership without document or updater IPC',async()=>{
  const launcher=await fixture('main');const other=await fixture('document-2',{dirty:true});
  await launcher.nativeClose();
  assert.equal(launcher.prevented,false);assert.equal(launcher.destroyed,1);
  assert.deepEqual(launcher.calls,[]);assert.equal(launcher.listeners.has('leaf-close'),false);
  assert.equal(other.dirty,true);assert.equal(other.destroyed,0);assert.deepEqual(other.calls,[]);
});
test('document native close still checkpoints, prompts, and preserves cancellation',async()=>{
  const f=await fixture('document-1',{dirty:true});await f.nativeClose();
  assert.equal(f.prevented,true);assert.equal(f.destroyed,0);assert.equal(f.dirty,true);
  assert.deepEqual(f.calls,['update_close_disposition','mcp_document_boundary','idle','checkpoint','prompt:cancel','update_close_complete']);
});
test('document failed save keeps the document and releases only its close action',async()=>{
  const f=await fixture('document-1',{dirty:true,choice:'save',save:false});await f.nativeClose();
  assert.equal(f.destroyed,0);assert.equal(f.dirty,true);assert.ok(f.calls.includes('save'));
  assert.equal(f.calls.at(-1),'update_close_complete');
});
test('document save and clean close retain the existing native action and MCP boundary',async()=>{
  for(const dirty of [false,true]) {
    const f=await fixture('document-1',{dirty,choice:'save'});await f.nativeClose();
    assert.equal(f.destroyed,1);assert.equal(f.dirty,false);
    assert.equal(f.calls[0],'update_close_disposition');assert.ok(f.calls.includes('mcp_document_boundary'));
    assert.equal(f.calls.includes('update_close_complete'),false);
  }
});
test('update-owned document close stays blocked and ordinary quit cancellation stays bound',async()=>{
  const blocked=await fixture('document-1',{dirty:true,allowed:false});await blocked.nativeClose();
  assert.equal(blocked.destroyed,0);assert.equal(blocked.calls.includes('prompt:cancel'),false);
  const manual=await fixture('document-1',{manualDriver:true});await manual.nativeClose();
  assert.equal(manual.destroyed,0);assert.deepEqual(manual.calls,[]);
  const quit=await fixture('document-1',{dirty:true});await quit.quit();
  assert.equal(quit.destroyed,0);assert.equal(quit.calls.at(-1),'ordinary_quit_cancelled');
});
