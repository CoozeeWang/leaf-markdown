import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, copyFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {createServer} from 'node:net';
import {stageDevBundle} from './desktop-dev-macos.mjs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const root = resolve(import.meta.dirname, '..');
const mode = process.argv[2] || 'stdio-and-origin';
assert(['stdio-and-origin', 'packaged'].includes(mode));
const directory = await mkdtemp(join(tmpdir(), 'leaf-adapter-native-'));
const env = { ...process.env, PATH: `${homedir()}/.cargo/bin:${process.env.PATH}`, LEAF_MCP_TEST_DIR: directory, LEAF_MCP_TEST_MODE: 'tracer', LEAF_MCP_ADAPTER_TEST: '1' };
if(process.platform==='win32') {
  const probe=createServer();await new Promise((res,rej)=>{probe.once('error',rej);probe.listen(0,'127.0.0.1',res);});
  env.LEAF_NATIVE_SMOKE_PORT=String(probe.address().port);await new Promise(res=>probe.close(res));
}
const processes = [];
function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  processes.push(child); return child;
}
function completed(child) { return new Promise((res, rej) => { child.on('error', rej); child.on('exit', code => code === 0 ? res() : rej(new Error(`build exited ${code}`))); }); }
async function build(args) { const child = start(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build', ...args]); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); await completed(child); }
async function waitJson(name, timeout = 65000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { try { return JSON.parse(await readFile(join(directory, name), 'utf8')); } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`native evidence missing: ${name}`);
}
function helper(binary, descriptor) {
  // Runtime proof: the executable receives no system Node/Python/Cargo PATH.
  const child = start(binary, ['--descriptor', descriptor], { cwd: directory, env: { ...process.env, PATH: '/no-development-runtimes', LEAF_MCP_TEST_TRACE: join(directory, 'helper-stage') } });
  const pending = new Map(); let next = 1; let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => {
    let value; try { value = JSON.parse(line); } catch { for (const p of pending.values()) p.reject(new Error('non-protocol stdout')); return; }
    if (value.id != null) pending.get(value.id)?.resolve(value);
  });
  child.on('exit', async () => { const stage=await readFile(join(directory,'helper-stage'),'utf8').catch(()=>'startup');for (const p of pending.values()) p.reject(new Error(`helper unavailable: ${stderr.trim()}; ${stage}`)); });
  return { child, stderr: () => stderr, async request(method, params = {}) {
    const id = next++;
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(async () => { pending.delete(id); const stage=await readFile(join(directory, 'helper-stage'), 'utf8').catch(()=>'startup');reject(new Error(`MCP request timed out: ${method}; ${stage}; ${stderr}`)); }, process.env.LEAF_MCP_ALLOW_INTERACTION ? 300000 : 12000);
      pending.set(id, { resolve: value => { clearTimeout(timeout); pending.delete(id); resolve(value); }, reject: e => { clearTimeout(timeout); pending.delete(id); reject(e); } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }, notify(method) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); } };
}
async function initialize(h) {
  const result = await h.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Synthetic adapter probe', version: '1.0.0' } });
  assert(result.result?.capabilities?.tools, 'standard initialize must negotiate tools'); h.notify('notifications/initialized');
}
await test('standard MCP adapter with actual native keyring and broker', async () => {
try {
  let binaries;let appExecutable=resolve(root,'src-tauri/target/debug/leaf'+(process.platform==='win32'?'.exe':''));
  if(mode!=='packaged'&&!process.argv.includes('--reuse-build')) await build(['--debug','--no-bundle','--features','native-smoke','--config','src-tauri/tauri.mcp-test.conf.json']);
  if (mode === 'packaged') {
    assert.equal(existsSync(resolve(root, '.cache/mcp-adapter/artifacts.json')), true, 'actual Tauri bundle and MCPB artifacts must be produced');
    let manifest = JSON.parse(await readFile(resolve(root, '.cache/mcp-adapter/artifacts.json'), 'utf8'));
    if(!manifest.testBundle) {
      const {producePackages}=await import('./build-mcp-adapter.mjs');await producePackages({testBundle:true});
      manifest=JSON.parse(await readFile(resolve(root,'.cache/mcp-adapter/artifacts.json'),'utf8'));
    }
    assert.equal(existsSync(manifest.appHelper), true, 'actual Tauri app bundle must contain helper');
    assert.equal(existsSync(manifest.mcpbHelper), true, 'unpacked MCPB must contain helper');
    assert.equal(manifest.workbuddy.command, manifest.appHelper, 'WorkBuddy export must use installed bundle helper');
    assert.equal(manifest.testBundle,true,'packaged native proof requires the isolated test bundle');
    appExecutable=manifest.appExecutable;
    binaries = [manifest.appHelper, manifest.mcpbHelper];
  } else {
    const binary = resolve(root, 'src-tauri/target/debug/leaf-mcp-adapter' + (process.platform === 'win32' ? '.exe' : ''));
    assert(existsSync(binary)); binaries = [binary];
  }
  if(mode!=='packaged'&&process.platform==='darwin') {
    const staged=await stageDevBundle({source:appExecutable,helper:binaries[0],test:true,testBundlePath:join(directory,'Leaf Adapter Test.app')});
    appExecutable=staged.executable;binaries=[staged.helper];
  }
  if(process.platform==='win32') {
    const installed=join(directory,'Public Example 中文');await mkdir(installed);
    const gui=join(installed,'leaf.exe'),helper=join(installed,'leaf-mcp-adapter.exe');
    await copyFile(appExecutable,gui);await copyFile(binaries[0],helper);appExecutable=gui;binaries=[helper];
  }
  const server = start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '41731', '--strictPort']);
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:41731')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const app = start(appExecutable, []);
  app.stderr.on('data', chunk => process.stderr.write(chunk));
  const ready = await waitJson('adapter-ready.json');
  // Exercise generated host artifacts, including the Claude stream launcher,
  // with the actual adapter. This does not require a model or paid host quota.
  await test('generated Claude MCPB and WorkBuddy config launch the real adapter',async()=>{
    const zip=await readFile(ready.claude_bundle);let offset=0;const entries=new Map();
    while(zip.readUInt32LE(offset)===0x04034b50){
      const size=zip.readUInt32LE(offset+18),nameLength=zip.readUInt16LE(offset+26),extra=zip.readUInt16LE(offset+28);
      const name=zip.subarray(offset+30,offset+30+nameLength).toString();const start=offset+30+nameLength+extra;
      entries.set(name,zip.subarray(start,start+size));offset=start+size;
    }
    const manifest=JSON.parse(entries.get('manifest.json').toString());
    assert(manifest.compatibility.platforms.includes(process.platform));
    assert.equal(manifest.server.mcp_config.command,'node');
    const launcher=join(directory,'claude-launcher.cjs');await writeFile(launcher,entries.get('server/index.js'));
    const workbuddy=JSON.parse(await readFile(ready.workbuddy_config,'utf8')).mcpServers.Leaf;
    assert.equal(workbuddy.type,'stdio');
    for(const [name,config] of [['claude',{command:process.execPath,args:[launcher]}],['workbuddy',workbuddy]]) {
      const transport=new StdioClientTransport({...config,stderr:'pipe'});
      const client=new Client({name:'Synthetic '+name+' host',version:'1.0.0'},{capabilities:{},versionNegotiation:{mode:{pin:'2026-07-28'}}});
      try {
        await client.connect(transport);const tools=await client.listTools();assert(tools.tools.some(t=>t.name==='apply_edit_batch'));
        const documents=await client.callTool({name:'list_documents',arguments:{}});assert.equal(documents.isError,false);
        if(name==='claude') {
          const read=await client.callTool({name:'read_document',arguments:ready.binding});assert.equal(read.structuredContent.content,'synthetic alpha omega');
        }
      }finally{await client.close();}
    }
  });
  for (const binary of binaries) {
    await test('modern SDK discovers tools and reads through the actual adapter', async () => {
      const transport = new StdioClientTransport({command:binary,args:['--descriptor',ready.descriptor],cwd:directory,env:{PATH:'/no-development-runtimes'},stderr:'pipe'});
      const client = new Client({name:'Synthetic modern adapter host',version:'1.0.0'},{capabilities:{},versionNegotiation:{mode:{pin:'2026-07-28'}}});
      let stderr='';transport.stderr.on('data',chunk=>stderr+=chunk);
      try {
        await client.connect(transport);
        const tools=await client.listTools();assert(tools.tools.some(t=>t.name==='read_document'));
        const read=await client.callTool({name:'read_document',arguments:ready.binding});
        assert.equal(read.isError,false);assert.equal(read.structuredContent.content,'synthetic alpha omega');
        const resources=await client.listResources();assert.equal(resources.resources.length,1);
        const resource=await client.readResource({uri:resources.resources[0].uri});assert.match(resource.contents[0].text,/<!doctype html>/i);
        const denied=await client.callTool({name:'read_document',arguments:{...ready.binding,session_id:'synthetic-stale-session'}});
        assert.equal(denied.isError,true,'tool failures also use a valid complete response');
        assert.equal(stderr,'','no diagnostic or credential output');
      } finally {await client.close();}
    });
  }
  const clients = [];
  for (const binary of binaries) {
    const h = helper(binary, ready.descriptor); clients.push(h); await initialize(h);
    await test(`native stdio read and discovery from ${mode === 'packaged' ? (clients.length === 1 ? 'Tauri app bundle' : 'unpacked MCPB') : 'Rust helper'}`, async () => {
      const tools = await h.request('tools/list'); assert(tools.result.tools.some(t => t.name === 'read_document'));
      const read = await h.request('tools/call', { name: 'read_document', arguments: ready.binding }); assert.equal(read.result.structuredContent.content, 'synthetic alpha omega');
      const resources = await h.request('resources/list'); assert.equal(resources.result.resources.length, 1);
      const discovered=resources.result.resources[0];assert.equal(discovered.uri,'ui://leaf/reader');assert.equal(discovered.mimeType,'text/html;profile=mcp-app');
      const resource = await h.request('resources/read', { uri: discovered.uri });
      const asset=resource.result.contents[0];assert.equal(asset.uri,discovered.uri);assert.equal(asset.mimeType,discovered.mimeType);
      assert.match(asset.text,/<!doctype html>/i);assert.match(asset.text,/<article[^>]+id="reader"/);assert.match(asset.text,/<script>/);assert.match(asset.text,/Content-Security-Policy/);
      assert(!asset.text.includes('synthetic alpha omega'),'UI resource contains application HTML, not the live document');
      assert.deepEqual(asset._meta.ui.csp,{connectDomains:[],resourceDomains:[]});
      for(const name of ['open_reader','reader_snapshot']) {
        const live=await h.request('tools/call',{name,arguments:ready.binding});assert.equal(live.result.isError,false);
        assert.deepEqual(live.result.structuredContent.binding,ready.binding);assert.equal(live.result.structuredContent.snapshot.content,'synthetic alpha omega');
        assert.equal(live.result.structuredContent.snapshot.revision,read.result.structuredContent.revision);
      }
      assert.equal(h.stderr(), '', 'no diagnostic or credential output');
    });
  }
  const other = helper(binaries[0], ready.other_descriptor); await initialize(other);
  const descriptor = JSON.parse(await readFile(ready.descriptor, 'utf8'));
  await test('loopback rejects an unapproved Origin', async () => {
    const response = await fetch(descriptor.uri, { method: 'POST', headers: { Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Untrusted', version: '1' } } }) });
    assert([401, 403].includes(response.status));
  });
  await writeFile(join(directory, 'race'), ''); await waitJson('adapter-revoked.json');
  await test('atomic revoke rejects old helper and keeps the other client enabled', async () => {
    const read = await clients[0].request('tools/call', { name: 'read_document', arguments: ready.binding }); assert(read.error || read.result?.isError);
    const unaffected = await other.request('tools/call', { name: 'list_documents', arguments: {} }); assert.equal(unaffected.result.isError, false);
    const stale = helper(binaries[0], ready.descriptor); await assert.rejects(initialize(stale));
  });
  await writeFile(join(directory, 'disabled'), ''); await waitJson('adapter-disabled.json');
  await test('global disable rejects remaining client calls', async () => { const reply = await other.request('tools/call', { name: 'list_documents', arguments: {} }); assert(reply.error || reply.result?.isError); });
  for (const h of [...clients, other]) h.child.stdin.end();
  await writeFile(join(directory, 'done'), ''); const report = await waitJson('adapter-result.json'); assert.equal(report.pass, true, report.failure);
} finally {
  const acl=await readFile(join(directory,'acl-effective.json'),'utf8').catch(()=>null);
  if(acl) console.log(`Effective synthetic entry ACL: ${acl}`);
  await writeFile(join(directory, 'abort'), '');
  if (existsSync(join(directory, 'adapter-ready.json'))) {try {await waitJson('adapter-result.json', 5000);}catch{}}
  for (const child of processes) if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 300)); await rm(directory, { recursive: true, force: true });
}
});
