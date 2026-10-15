// Three actual isolated application lifetimes, with no user files or keys.
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {stageDevBundle} from './desktop-dev-macos.mjs';
import {createServer} from 'node:net';
const root=resolve(import.meta.dirname,'..');
const directory=await mkdtemp(join(tmpdir(),'leaf-startup-'));
let executable=join(root,'src-tauri/target/debug/leaf'+(process.platform==='win32'?'.exe':''));
let primaryFailure;
try {
  if(process.platform==='darwin') {
    const staged=await stageDevBundle({source:executable,helper:join(root,'src-tauri/target/debug/leaf-mcp-adapter'),test:true,testBundlePath:join(directory,'Leaf Startup Test.app')});
    executable=staged.executable;
  }
  for(const mode of ['cold','on','off']) {
    const result=join(directory,'result.json');await rm(result,{force:true});
    const smokeEnv={};
    if(process.platform==='win32') {
      const probe=createServer();await new Promise((res,rej)=>{probe.once('error',rej);probe.listen(0,'127.0.0.1',res);});
      smokeEnv.LEAF_NATIVE_SMOKE_PORT=String(probe.address().port);await new Promise(res=>probe.close(res));
    }
    const child=spawn(executable,[],{cwd:root,env:{...process.env,...smokeEnv,LEAF_MCP_TEST_DIR:directory,LEAF_MCP_TEST_MODE:'connection-restart-'+mode},stdio:['ignore','ignore','pipe']});
    let diagnostic='';child.stderr.on('data',chunk=>diagnostic+=chunk);
    const timeout=setTimeout(()=>child.kill(),45000);
    const code=await new Promise((res,rej)=>{child.on('error',rej);child.on('exit',res);});clearTimeout(timeout);
    const report=JSON.parse(await readFile(result,'utf8').catch(()=>JSON.stringify({pass:false,failure:'no native report: '+diagnostic.slice(-1000)})));
    if(report.pass!==true)console.error('Native restart report:',JSON.stringify(report));
    assert.equal(report.pass,true,JSON.stringify(report));assert.equal(code,0);
    console.log('Actual native startup passed:',mode);
  }
} catch(error) {primaryFailure=error;throw error;}
finally {
  try {await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
  catch(error) {if(primaryFailure)console.error('Secondary native cleanup failure:',error.code);else throw error;}
}
