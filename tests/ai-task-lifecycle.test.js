import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {setupStatusNotices} from '../src/status-notices.js';

function node(){return {hidden:false,textContent:'',dataset:{},children:[],listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},replaceChildren(...children){this.children=children;},append(child){this.children.push(child);},setAttribute(){}};}
test('persistent task stop coexists with save errors and cannot be dismissed',()=>{
  const previous=globalThis.document;
  globalThis.document={createElement:node,querySelector:()=>null};
  try{
    const container=node(),text=node(),recovery=node(),actions=node(),dismiss=node(),announcement=node(),taskContainer=node();
    const notices=setupStatusNotices({container,text,recovery,actions,dismiss,announcement,taskContainer});
    assert.equal(typeof notices.setTask,'function','task status must have an independent persistent slot');
    let stopped=0;notices.setTask({text:'Synthetic client editing',stopLabel:'Stop',stop:()=>stopped++});
    notices.show('Synthetic save failure','error',{announce:false});
    assert.equal(text.textContent,'Synthetic save failure');
    assert.equal(taskContainer.hidden,false);assert.equal(taskContainer.children.at(-1).textContent,'Stop');
    dismiss.listeners.click();assert.equal(taskContainer.hidden,false,'error dismissal cannot dismiss an active task');
    taskContainer.children.at(-1).listeners.click();assert.equal(stopped,1);
    notices.setTask(null);assert.equal(taskContainer.hidden,true);notices.reset();
  }finally{globalThis.document=previous;}
});

if(process.env.LEAF_AI_LIFECYCLE_NATIVE==='1')test('actual helper heartbeat, EOF, crash and native stop restore the live document',async()=>{
  const root=resolve(import.meta.dirname,'..'),directory=await mkdtemp(join(tmpdir(),'leaf-lifecycle-'));
  const env={...process.env,PATH:`${homedir()}/.cargo/bin:${process.env.PATH}`,LEAF_MCP_TEST_DIR:directory,LEAF_MCP_TEST_MODE:'tracer',LEAF_MCP_ADAPTER_TEST:'1'};
  const children=[];const start=(command,args,options={})=>{const child=spawn(command,args,{cwd:root,env,stdio:['pipe','pipe','pipe'],...options});children.push(child);return child;};
  const wait=async(name,json=false)=>{for(let i=0;i<650;i++){try{await access(join(directory,name));return json?JSON.parse(await readFile(join(directory,name),'utf8')):true;}catch{}const failed=await readFile(join(directory,'adapter-result.json'),'utf8').then(JSON.parse).catch(()=>null);if(failed?.pass===false)throw new Error(`native lifecycle failed: ${failed.failure}`);await new Promise(r=>setTimeout(r,100));}throw new Error(`missing native lifecycle evidence: ${name}`);};
  const signal=name=>writeFile(join(directory,name),'synthetic signal');
  const helper=descriptor=>{
    const child=start(resolve(root,'src-tauri/target/debug/leaf-mcp-adapter'),['--descriptor',descriptor],{env:{...env,PATH:'/no-development-runtimes'}});const pending=new Map();let next=0,errors='';
    child.stderr.on('data',chunk=>errors+=chunk);
    createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line);pending.get(value.id)?.(value);});
    return {child,async initialize(){const id=++next;const reply=await new Promise((res,rej)=>{const timer=setTimeout(()=>rej(new Error(`helper initialization timed out: ${errors}`)),65000);pending.set(id,value=>{clearTimeout(timer);res(value);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'Synthetic lifecycle probe',version:'1'}}})+'\n');});assert(reply.result?.capabilities.tools);child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');}};
  };
  try{
    if(process.env.LEAF_AI_LIFECYCLE_REUSE_BUILD!=='1'){
    const build=start(process.execPath,['node_modules/@tauri-apps/cli/tauri.js','build','--debug','--no-bundle','--features','native-smoke','--config','src-tauri/tauri.mcp-test.conf.json']);
    let output='';build.stdout.on('data',chunk=>output+=chunk);build.stderr.on('data',chunk=>output+=chunk);await new Promise((res,rej)=>{build.on('error',rej);build.on('exit',code=>code===0?res():rej(new Error(output)));});
    }
    start(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','41731','--strictPort']);
    for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:41731')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
    const app=start(resolve(root,'src-tauri/target/debug/leaf'),[]);let nativeErrors='';app.stderr.on('data',chunk=>nativeErrors+=chunk);
    const ready=await wait('adapter-ready.json',true);const owner=helper(ready.descriptor),other=helper(ready.other_descriptor);await owner.initialize();await other.initialize();
    await signal('heartbeat-ready');await wait('silent-task');await new Promise(r=>setTimeout(r,2200));await signal('model-silent');await wait('silence-passed');
    owner.child.stdin.end();await signal('eof');await wait('eof-passed');
    const replacement=helper(ready.descriptor);await replacement.initialize();await signal('crash-ready');await wait('crash-task');replacement.child.kill('SIGKILL');await signal('crash');
    const evidence=await wait('lifecycle-passed.json',true);assert.equal(Object.values(evidence).every(value=>value===true),true,JSON.stringify(evidence));
    console.log('Native lifecycle: actual heartbeat, quiet model, EOF, crash with other client alive, native stop race, late rejection, human recovery passed');
    await signal('done');const report=await wait('adapter-result.json',true);assert.equal(report.pass,true,report.failure||nativeErrors);
    other.child.stdin.end();
  }finally{
    await signal('abort');
    try{await wait('adapter-result.json',true);}catch{}
    for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');await new Promise(r=>setTimeout(r,300));await rm(directory,{recursive:true,force:true});
  }
});

test('native authenticated lease separates health, model progress, deadlines and termination',()=>{
  const result=spawnSync('cargo',['test','--locked','--manifest-path','src-tauri/Cargo.toml','authenticated_lease','--','--nocapture'],{encoding:'utf8',timeout:180000,env:{...process.env,PATH:`${homedir()}/.cargo/bin:${process.env.PATH}`}});
  assert.equal(result.status,0,result.stderr+result.stdout);
  assert.match(result.stdout,/running [1-9]\d* tests/,'native lease fault tests must actually run');
});
