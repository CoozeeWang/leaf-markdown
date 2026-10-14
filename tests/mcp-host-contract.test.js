import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AppBridge} from '@modelcontextprotocol/ext-apps/app-bridge';
import {createReaderBridge} from '../src/mcp-panel/bridge.js';

test('native reader discovery binds the standards UI resource to its thread tool',()=>{
  const source=readFileSync(new URL('../src-tauri/src/mcp.rs',import.meta.url),'utf8');
  assert.ok(source.includes('ui://leaf/reader'),'standards UI resource must be registered');
  assert.ok(source.includes('text/html;profile=mcp-app'),'resource has MCP Apps MIME');
  assert.ok(source.includes('resourceUri'),'thread tool points to the same resource');
  assert.ok(source.includes('reader_snapshot'),'live read-only broker tool is discoverable');
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
