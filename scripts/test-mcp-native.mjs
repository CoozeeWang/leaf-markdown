import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir, homedir} from 'node:os';
import {join, resolve} from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const mode=process.argv[2] || 'tracer';
assert(['tracer','task-history-gate','renderer-ack-loss','all-write-entrances','stop-late-second-window','properties-markdown','footnotes-tables','file-identity-conflict'].includes(mode));
const root=resolve(import.meta.dirname,'..');
const directory=await mkdtemp(join(tmpdir(),'leaf-mcp-native-'));
const result=join(directory,'result.json');
const env={...process.env,NODE_OPTIONS:'--test-reporter=tap',PATH:`${homedir()}/.cargo/bin:${process.env.PATH}`,LEAF_MCP_TEST_DIR:directory,LEAF_MCP_TEST_MODE:mode};
let app, server;
function start(command,args,options={}) { return spawn(command,args,{cwd:root,env,stdio:['ignore','pipe','pipe'],...options}); }
function completed(child) { return new Promise((res,rej)=>{ child.on('error',rej);child.on('exit',code=>code===0?res():rej(new Error(`process exited ${code}`))); }); }
try {
  await writeFile(join(directory,'synthetic.md'),'Synthetic saved draft');
  await writeFile(join(directory,'different.md'),'Different saved draft');
  await writeFile(join(directory,'synthetic.txt'),'Public synthetic attachment');
  const build=start('node',['node_modules/@tauri-apps/cli/tauri.js','build','--debug','--no-bundle','--features','native-smoke','--config','src-tauri/tauri.mcp-test.conf.json']);
  build.stdout.pipe(process.stdout);build.stderr.pipe(process.stderr);await completed(build);
  server=start('node',['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','41731','--strictPort']);
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:41731')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  for(const runMode of mode==='renderer-ack-loss'?[mode,'renderer-ack-loss-restart']:[mode]) {
    await rm(result,{force:true});
    app=start(join(root,'src-tauri/target/debug/leaf'),[],{env:{...env,LEAF_MCP_TEST_MODE:runMode}});
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
