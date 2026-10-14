import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
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

test('native authenticated lease separates health, model progress, deadlines and termination',()=>{
  const result=spawnSync('cargo',['test','--locked','--manifest-path','src-tauri/Cargo.toml','authenticated_lease','--','--nocapture'],{encoding:'utf8',timeout:180000,env:{...process.env,PATH:`${homedir()}/.cargo/bin:${process.env.PATH}`}});
  assert.equal(result.status,0,result.stderr+result.stdout);
  assert.match(result.stdout,/running [1-9]\d* tests/,'native lease fault tests must actually run');
});
