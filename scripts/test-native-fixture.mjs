import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import assert from 'node:assert/strict';
const fixture=process.argv[2];
assert(fixture && /^native-[a-z0-9-]+\.html$/.test(fixture));
await access(resolve('tests',fixture));
const env={...process.env,PATH:`${homedir()}/.cargo/bin:${process.env.PATH}`};
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','41735','--strictPort'],{env,stdio:'ignore'});
try {
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:41735')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const child=spawn('cargo',['run','--locked','--manifest-path','src-tauri/Cargo.toml','--example','native-table-keys','--',resolve('tests',fixture),`http://127.0.0.1:41735/tests/${fixture}`],{env,stdio:'inherit'});
  await new Promise((ok,fail)=>{child.on('error',fail);child.on('exit',code=>code===0?ok():fail(new Error(`WK fixture exited ${code}`)));});
} finally {server.kill('SIGTERM');}
