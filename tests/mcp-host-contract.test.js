import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AppBridge} from '@modelcontextprotocol/ext-apps/app-bridge';
import {createReaderBridge} from '../src/mcp-panel/bridge.js';
import {createReaderState} from '../src/mcp-panel/state.js';

test('native reader discovery binds the standards UI resource to its thread tool',()=>{
  const source=readFileSync(new URL('../src-tauri/src/mcp.rs',import.meta.url),'utf8');
  assert.ok(source.includes('ui://leaf/reader'),'standards UI resource must be registered');
  assert.ok(source.includes('text/html;profile=mcp-app'),'resource has MCP Apps MIME');
  assert.ok(source.includes('resourceUri'),'thread tool points to the same resource');
  assert.ok(source.includes('reader_snapshot'),'live read-only broker tool is discoverable');
});

test('reader capability stays bound to one session and epoch with explicit terminal invalidation',()=>{
 const state=createReaderState(),binding={document_id:'synthetic',session_id:'session',authorization_epoch:1};
 const value={binding,snapshot:{content:'😀é\nCRLF metadata',line_ending:'\r\n',revision:1},comments:[]};
 assert.equal(state.accept(value),true);assert.equal(state.accept({...value,task:null}),true);
 assert.equal(state.current.snapshot.line_ending,'\r\n');assert.equal(state.current.snapshot.content,value.snapshot.content);
 assert.throws(()=>state.accept({...value,binding:{...binding,session_id:'different'}}),/stale_binding/);
 assert.equal(state.current,null);assert.equal(state.accept(value),false);
 const revision=createReaderState();revision.accept(value);assert.throws(()=>revision.accept({...value,snapshot:{...value.snapshot,content:'forged'}}),/revision_content_mismatch/);
 const empty=createReaderState();assert.throws(()=>empty.accept({}),/invalid_snapshot/);assert.equal(empty.current,null);
});

test('real App SDK negotiates host capabilities and reads two revisions through tools/call',async()=>{
 const messages=[],views=[],errors=[];
 // Standard Transport contract carrying JSON-RPC; no custom panel protocol.
 const a={start:async()=>{},send:async message=>{messages.push(message);queueMicrotask(()=>b.onmessage?.(message));},close:async()=>{a.onclose?.();}};
 const b={start:async()=>{},send:async message=>{messages.push(message);queueMicrotask(()=>a.onmessage?.(message));},close:async()=>{b.onclose?.();}};
 const binding={document_id:'synthetic-document',session_id:'synthetic-session',authorization_epoch:3};
 let revision=10;
 const host=new AppBridge(null,{name:'Synthetic standards host',version:'1.0'},{serverTools:{}},{hostContext:{theme:'dark',locale:'en'}});
 host.oncalltool=async({name,arguments:args})=>{assert.equal(name,'reader_snapshot');assert.deepEqual(args,binding);return {content:[],structuredContent:{binding,snapshot:{revision,content:`Draft ${revision}`},comments:[]}};};
 const reader=createReaderBridge({transport:a,render:value=>views.push(value),invalidate:reason=>errors.push(reason)});
 await host.connect(b);await reader.connect();
 assert.equal(reader.app.getHostVersion().name,'Synthetic standards host');
 assert.ok(reader.app.getHostCapabilities().serverTools);
 await host.sendToolInput({arguments:binding});
 for(let i=0;i<30&&views.length<1;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(views[0].snapshot.revision,10);
 revision=11;await reader.refresh();assert.equal(views.at(-1).snapshot.revision,11);
 assert.ok(messages.some(m=>m.method==='ui/initialize'));
 assert.ok(messages.some(m=>m.method==='tools/call'));
 assert.deepEqual(errors,[]);reader.close();await host.close();
});

test('reader refuses late lower revisions and cannot revive after revocation',async()=>{
 const views=[],errors=[],pending=[];
 const a={start:async()=>{},send:async m=>queueMicrotask(()=>b.onmessage?.(m)),close:async()=>a.onclose?.()};
 const b={start:async()=>{},send:async m=>queueMicrotask(()=>a.onmessage?.(m)),close:async()=>b.onclose?.()};
 const binding={document_id:'synthetic-document',session_id:'synthetic-session',authorization_epoch:4};
 const value=revision=>({content:[],structuredContent:{binding,snapshot:{revision,content:`Draft ${revision}`},comments:[]}});
 const host=new AppBridge(null,{name:'Synthetic host',version:'1'},{serverTools:{}});
 host.oncalltool=()=>new Promise(resolve=>pending.push(resolve));
 const reader=createReaderBridge({transport:a,render:v=>views.push(v),invalidate:r=>errors.push(r)});
 await host.connect(b);await reader.connect();await host.sendToolInput({arguments:binding});
 while(!pending.length)await new Promise(r=>setTimeout(r,1));pending.shift()(value(10));
 await new Promise(r=>setTimeout(r,5));
 const older=reader.refresh(),newer=reader.refresh();
 while(pending.length<2)await new Promise(r=>setTimeout(r,1));
 pending[1](value(12));await newer;pending[0](value(11));await older;
 assert.equal(views.at(-1).snapshot.revision,12,'late responses must not replace the highest authorized revision');
 reader.close();const length=views.length;await reader.refresh();assert.equal(views.length,length);assert.ok(errors.length);await host.close();
});
