// Isolated native settings IPC and official connector. Parent proxy returns 502;
// this proves live error/reconfiguration and routing, not real cloud access.
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
import {stageDevBundle} from './desktop-dev-macos.mjs';
assert.ok(process.env.LEAF_TEST_TUNNEL_CLIENT,'Set the verified official connector path');
const root=resolve(import.meta.dirname,'..'),directory=await mkdtemp(join(tmpdir(),'leaf-proxy-ui-'));
let contacts=0;
const proxy=createServer(socket=>socket.once('data',bytes=>{
  const request=bytes.toString();assert.match(request,/^CONNECT api\.openai\.com:443 HTTP\//);
  assert.doesNotMatch(request,/synthetic-proxy-key/);contacts++;socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
}));
await new Promise(res=>proxy.listen(0,'127.0.0.1',res));
const unused=createServer();await new Promise(res=>unused.listen(0,'127.0.0.1',res));const badPort=unused.address().port;await new Promise(res=>unused.close(res));
try {
  let executable=join(root,'src-tauri/target/debug/leaf'+(process.platform==='win32'?'.exe':''));
  if(process.platform==='darwin')({executable}=await stageDevBundle({source:executable,helper:join(root,'src-tauri/target/debug/leaf-mcp-adapter'),test:true,testBundlePath:join(directory,'Leaf Proxy Test.app')}));
  const probe=createServer();await new Promise(res=>probe.listen(0,'127.0.0.1',res));const nativePort=probe.address().port;await new Promise(res=>probe.close(res));
  const child=spawn(executable,[],{cwd:root,env:{...process.env,LEAF_NATIVE_SMOKE_PORT:String(nativePort),CONTROL_PLANE_HTTP_PROXY:`http://127.0.0.1:${proxy.address().port}`,LEAF_TEST_BAD_PROXY:`http://127.0.0.1:${badPort}`,LEAF_MCP_TEST_DIR:directory,LEAF_MCP_TEST_MODE:'connection-proxy-recovery'},stdio:['ignore','ignore','pipe']});
  let diagnostic='';child.stderr.on('data',bytes=>diagnostic+=bytes);
  const timer=setTimeout(()=>child.kill(),100000);
  const code=await new Promise((res,rej)=>{child.once('error',rej);child.once('exit',res);}).finally(()=>clearTimeout(timer));
  const report=JSON.parse(await readFile(join(directory,'result.json'),'utf8').catch(()=>JSON.stringify({pass:false,failure:diagnostic.slice(-1000)})));
  assert.equal(report.pass,true,JSON.stringify(report));assert.equal(code,0);assert.ok(contacts>0,'cleared proxy must reach the automatic environment route');
  console.log('Actual native proxy settings passed: error, usable controls, clear override, same-process automatic routing; synthetic key only.');
} finally {await new Promise(res=>proxy.close(res));await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
