import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
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
} else {
assert(['chatgpt-tunnel-tracer','tracer','task-history-gate','renderer-ack-loss','all-write-entrances','stop-late-second-window','properties-markdown','footnotes-tables','file-identity-conflict'].includes(mode));
const root=resolve(import.meta.dirname,'..');
const directory=await mkdtemp(join(tmpdir(),'leaf-mcp-native-'));
const result=join(directory,'result.json');
const env={...process.env,NODE_OPTIONS:'--test-reporter=tap',PATH:`${homedir()}/.cargo/bin:${process.env.PATH}`,LEAF_MCP_TEST_DIR:directory,LEAF_MCP_TEST_MODE:mode};
let app, server;
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
  if(mode.startsWith('chatgpt-tunnel-'))executable=(await stageDevBundle({source:executable,helper:join(root,'src-tauri/target/debug/leaf-mcp-adapter'),test:true})).executable;
  server=start('node',['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','41731','--strictPort']);
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:41731')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  for(const runMode of mode==='renderer-ack-loss'?[mode,'renderer-ack-loss-restart']:[mode]) {
    await rm(result,{force:true});
    app=start(executable,[],{env:{...env,LEAF_MCP_TEST_MODE:runMode}});
    app.stderr.on('data',chunk=>process.stderr.write(chunk));
    let report;
    for(let i=0;i<900;i++){try{report=JSON.parse(await readFile(result,'utf8'));break;}catch{}if(app.exitCode!==null)break;await new Promise(r=>setTimeout(r,100));}
    assert(report,'actual Tauri driver must return evidence');
    await test(`native ${runMode} controlled task contract`,()=>assert.equal(report.pass,true,`${runMode}: ${report.failure || 'native assertions failed'}`));
    if(app.exitCode===null)await new Promise(resolve=>{app.once('exit',resolve);setTimeout(()=>{app.kill('SIGTERM');resolve();},2000).unref();});
    if(!report.pass)break;
  }
} finally {
  app?.kill('SIGTERM');server?.kill('SIGTERM');await rm(directory,{recursive:true,force:true});
}
}
