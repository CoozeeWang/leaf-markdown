import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir, homedir} from 'node:os';
import {join, resolve} from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {stageDevBundle} from './desktop-dev-macos.mjs';

const mode=process.argv[2] || 'tracer';
if (mode==='chatgpt-tunnel-contract') {
  await test('Tunnel tracer owns a native process manager before expansion', async()=>{
    const source=await readFile(new URL('../src-tauri/src/main.rs',import.meta.url),'utf8');
    assert(source.includes('mod chatgpt_tunnel;'),'native Tunnel manager must be registered');
  });
} else if(mode==='chatgpt-tunnel-runtime-contract') {
  await test('runtime key is absent from helper-readable payload',()=>{
    const run=spawnSync('cargo',['test','--locked','--manifest-path','src-tauri/Cargo.toml','--bin','leaf','runtime_key_is_not_helper_payload','--','--test-threads=1'],{env:{...process.env,PATH:`${homedir()}/.cargo/bin:${process.env.PATH}`},encoding:'utf8'});
    assert.equal(run.status,0,run.stdout+run.stderr);
  });
} else if(mode==='chatgpt-tunnel-stage-contract') {
  await test('Dev staging reports matching native GUI and helper build identities',async()=>{
    const source=resolve(import.meta.dirname,'../src-tauri/target/debug/leaf');
    const helper=resolve(import.meta.dirname,'../src-tauri/target/debug/leaf-mcp-adapter');
    const staged=await stageDevBundle({source,helper,test:true});
    assert.equal(typeof staged.gui_build_identity,'string','actual staged GUI identity must be reported');
    assert.equal(staged.gui_build_identity,staged.helper_build_identity,'actual helper must share the GUI build identity');
  });
} else {
assert(['chatgpt-tunnel-automatic-access','authorization-retirement','reader-panel','chatgpt-tunnel-tracer','chatgpt-tunnel-dev-bundle','chatgpt-tunnel-ui','tracer','task-history-gate','renderer-ack-loss','all-write-entrances','stop-late-second-window','properties-markdown','footnotes-tables','comments-task','file-identity-conflict'].includes(mode));
const root=resolve(import.meta.dirname,'..');
const directory=await mkdtemp(join(tmpdir(),'leaf-mcp-native-'));
const result=join(directory,'result.json');
const env={...process.env,NODE_OPTIONS:'--test-reporter=tap',PATH:`${homedir()}/.cargo/bin:${process.env.PATH}`,LEAF_MCP_TEST_DIR:directory,LEAF_MCP_TEST_MODE:mode};
let app, server;
let runtimeOutput='',serverOutput='';
function start(command,args,options={}) { return spawn(command,args,{cwd:root,env,stdio:['ignore','pipe','pipe'],...options}); }
function completed(child) { return new Promise((res,rej)=>{ child.on('error',rej);child.on('exit',code=>code===0?res():rej(new Error(`process exited ${code}`))); }); }
try {
  if(mode.startsWith('chatgpt-tunnel-')&&!process.argv.includes('--reuse-build')) {
    const helper=start('cargo',['build','--locked','--manifest-path','src-tauri/Cargo.toml','--bin','leaf-mcp-adapter','--features','native-smoke']);
    helper.stdout.pipe(process.stdout);helper.stderr.pipe(process.stderr);await completed(helper);
    assert(await readFile(join(root,'src-tauri/target/debug/leaf-mcp-adapter')),'actual sibling helper required');
  }
  await writeFile(join(directory,'synthetic.md'),'Synthetic saved draft');
  await writeFile(join(directory,'different.md'),'Different saved draft');
  await writeFile(join(directory,'synthetic.txt'),'Public synthetic attachment');
  if(!process.argv.includes('--reuse-build')) {
    const build=start('node',['node_modules/@tauri-apps/cli/tauri.js','build','--debug','--no-bundle','--features','native-smoke','--config','src-tauri/tauri.mcp-test.conf.json']);
    build.stdout.pipe(process.stdout);build.stderr.pipe(process.stderr);await completed(build);
  }
  let executable=join(root,'src-tauri/target/debug/leaf');
  if(mode.startsWith('chatgpt-tunnel-')) {
    const options={source:executable,helper:join(root,'src-tauri/target/debug/leaf-mcp-adapter'),test:true,testBundlePath:join(directory,'Leaf Native Test.app')};
    const first=await stageDevBundle(options);
    if(mode==='chatgpt-tunnel-dev-bundle') {
      const second=await stageDevBundle(options);
      assert.notEqual(first.gui_inode,second.gui_inode,'GUI staging must replace its inode');
      assert.notEqual(first.helper_inode,second.helper_inode,'helper staging must replace its inode');
      assert.equal(first.bundle,second.bundle);assert.equal(first.identifier,second.identifier);
      assert.equal(first.gui_build_identity,second.gui_build_identity);assert.equal(second.gui_build_identity,second.helper_build_identity);
      await writeFile(join(directory,'staging.json'),JSON.stringify({first,second}));
    }
    executable=first.executable;
    assert(executable.includes('Leaf Native Test.app/Contents/MacOS/leaf'),'native Tunnel route must use the disposable staged bundle');
  }
  server=start('node',['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','41731','--strictPort']);
  for(const pipe of [server.stdout,server.stderr])pipe.on('data',chunk=>{serverOutput=(serverOutput+chunk).slice(-4000);});
  let serving=false;
  for(let i=0;i<100;i++){
    assert.equal(server.exitCode,null,'owned native-test server exited: '+serverOutput);
    try{if(serverOutput.replace(/\x1b\[[0-9;]*m/g,'').includes('Local:')&&(await fetch('http://127.0.0.1:41731')).ok){serving=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(serving,'owned native-test server never became ready: '+serverOutput);
  for(const runMode of mode==='renderer-ack-loss'?[mode,'renderer-ack-loss-restart']:[mode]) {
    await rm(result,{force:true});
    app=start(executable,[],{env:{...env,LEAF_MCP_TEST_MODE:runMode}});
    app.stderr.on('data',chunk=>{runtimeOutput+=chunk;process.stderr.write(chunk);});
    app.stdout.on('data',chunk=>{runtimeOutput+=chunk;});
    let report;
    for(let i=0;i<(mode==='chatgpt-tunnel-dev-bundle'?3000:900);i++){try{report=JSON.parse(await readFile(result,'utf8'));break;}catch{}if(app.exitCode!==null)break;await new Promise(r=>setTimeout(r,100));}
    let stage=null;try{stage=JSON.parse(await readFile(join(directory,'native-stage.json'),'utf8'));}catch{}
    assert(report,'actual Tauri driver must return evidence: '+JSON.stringify({stage,exitCode:app.exitCode,signal:app.signalCode,serverExit:server.exitCode,serverTail:serverOutput.slice(-1000),runtimeTail:runtimeOutput.slice(-2000)}));
    await test(`native ${runMode} controlled task contract`,()=>assert.equal(report.pass,true,`${runMode}: ${report.failure || 'native assertions failed'}`));
    if(app.exitCode===null)await new Promise(resolve=>{app.once('exit',resolve);setTimeout(()=>{app.kill('SIGTERM');resolve();},2000).unref();});
    if(!report.pass)break;
    if(mode==='chatgpt-tunnel-dev-bundle') {
      const tree=JSON.parse(await readFile(join(directory,'app-exit-tree.json'),'utf8'));
      for(const key of ['connector_pid','helper_pid','descendant_pid']) {
        let alive=true;
        for(let i=0;i<100;i++){try{process.kill(tree[key],0);}catch{alive=false;break;}await new Promise(r=>setTimeout(r,50));}
        assert.equal(alive,false,`application exit must stop owned ${key}`);
      }
      const inspect=async folder=>{
        for(const entry of await readdir(folder,{withFileTypes:true})) {
          const path=join(folder,entry.name);
          if(entry.isDirectory()){if(entry.name!=='connector-fixture')await inspect(path);continue;}
          if(!/\.(json|yaml|health)$/.test(entry.name))continue;
          const value=await readFile(path,'utf8');assert(!value.includes('synthetic-tunnel-key-sentinel'),'synthetic runtime key must not reach generated files');
          if(entry.name!=='mcp-profiles-v1.json')assert(!value.includes('.chatgpt-runtime'),'GUI runtime reference must not reach descriptors/events/status');
        }
      };
      await inspect(directory);assert(!runtimeOutput.includes('synthetic-tunnel-key-sentinel'),'runtime stdout/stderr must exclude synthetic runtime key');
      await test('actual Dev staging, all owned lifecycle paths and output isolation',()=>assert.equal(tree.host_verified,false));
    }
  }
} finally {
  for(const child of [app,server]){
    if(!child||child.exitCode!==null||child.signalCode!==null)continue;
    await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');setTimeout(()=>{child.kill('SIGKILL');resolve();},5000).unref();});
  }
  await rm(directory,{recursive:true,force:true});
}
}
