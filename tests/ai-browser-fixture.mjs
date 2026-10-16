import assert from 'node:assert/strict';
export async function nativePage(browser,os='macos',startupError=null) {
  const page = await browser.newPage({viewport:{width:720,height:720}});
  page.on('pageerror', error=>console.error('AI UI page error:',error.message));
  await page.route('https://api.github.com/**', route => route.fulfill({json:{draft:false,prerelease:false,tag_name:'v0.0.16',assets:[{name:'tunnel-client-v0.0.16-darwin-arm64.zip',state:'uploaded',browser_download_url:'https://github.com/openai/tunnel-client/releases/download/v0.0.16/tunnel-client-v0.0.16-darwin-arm64.zip'}]}}));
  await page.addInitScript(({os,startupError}) => {
    window.isTauri = true;
    localStorage.setItem('leaf-settings-tab','ai');
    const callbacks = {}, handlers = {}; let id = 0;
    let language = {preference:'zh-Hans',language:'zh-Hans',revision:0};
    const clients = ['chatgpt','claude-desktop','workbuddy'].map(client => ({client,configured:false,enabled:false,generation:0,tunnel:null,has_runtime_key:false}));
    const runtime = {cloud_connected:false,cloud_state:'starting',proxy_source:'direct',consecutive_failures:0,generation:0,epoch:0,saved_config:false,runtime_present:false,process:false,local_ready:false,host_verified:false,last_error:null};
    const diagnostics={schema_version:1,instance_id:'0123456789abcdef',platform:os,build:'synthetic-build',client:'chatgpt',tunnel_tag:'000011112222',generation:0,last_call:null};
    if(startupError){Object.assign(clients[0],{configured:true,enabled:true,generation:2,has_runtime_key:true,tunnel:{tunnel_id:'tunnel_00000000000000000000000000000000',executable:'/synthetic/tunnel-client',proxy_url:''}});Object.assign(runtime,{saved_config:true,runtime_present:true,generation:2});}
    window.aiMock = {diagnostics,connectionErrors:startupError?{chatgpt:startupError}:{},enabled:false, clients, runtime, calls:[], fail:null, hold:false, pending:[], keySeen:false};
    if(startupError)aiMock.enabled=true;
    const copy = value => JSON.parse(JSON.stringify(value));
    window.emitNative = (event,payload) => handlers[event]?.({event,payload});
    window.aiEditorReady = () => !!handlers['leaf-mcp-editor'];
    window.__TAURI_INTERNALS__ = {
      metadata:{currentWindow:{label:'document-test'},currentWebview:{label:'document-test'}},
      transformCallback:fn=>{callbacks[++id]=fn; return id;},
      invoke:async(command,args={}) => {
        if (command === 'language_get') return language;
        if (command === 'language_set') return language = {preference:args.preference,language:args.preference,revision:language.revision+1};
        if (command === 'plugin:event|listen') {handlers[args.event]=callbacks[args.handler]; return ++id;}
        if (command === 'initial_path') return '/samples/连接设置.md';
        if (command === 'observe_document') return {path:'/samples/连接设置.md',content:'# Synthetic\n\nUnchanged body.'};
        if (command === 'read_document') return '# Synthetic\n\nUnchanged body.';
        if (['recent_list','recovery_list'].includes(command)) return [];
        if (command === 'recovery_retention') return 30;
        if (command === 'mcp_register') return {document_id:'doc-ui',session_id:'session-ui',authorization_epoch:1,mutation_generation:0};
        if (command === 'plugin:dialog|open') return '/synthetic folder/连接程序/tunnel-client';
        if (command === 'mcp_connection_platform') return {os,arch:os==='windows'?'x86_64':'aarch64'};
        if (!command.startsWith('mcp_')) return null;
        // Only a boolean records input receipt: mock diagnostics never retain it.
        const safe = {...args}; if ('runtimeKey' in safe) {aiMock.keySeen=!!safe.runtimeKey; delete safe.runtimeKey;}
        aiMock.calls.push({command,args:safe});
        if (aiMock.fail===command || (aiMock.failChatGPT && command==='mcp_enable_client' && args.client==='chatgpt')) throw 'synthetic_connection_error';
        if (command === 'mcp_profiles') {
          const snapshot = copy({enabled:aiMock.enabled,clients,connection_errors:aiMock.connectionErrors});
          if (aiMock.hold) return new Promise(resolve => aiMock.pending.push(()=>resolve(snapshot)));
          return snapshot;
        }
        if (command === 'mcp_tunnel_status') return copy({profile:clients[0],runtime,diagnostics});
        if (command === 'mcp_set_enabled') {aiMock.enabled=args.enabled; if(!args.enabled){clients.forEach(p=>{p.enabled=false;p.generation++;});runtime.process=runtime.local_ready=false;runtime.epoch++;}return copy({enabled:aiMock.enabled,clients,connection_errors:aiMock.connectionErrors});}
        if (command === 'mcp_authorize') {
          const binding={document_id:'doc-ui',session_id:args.sessionId,authorization_epoch:2,mutation_generation:0,revision:args.revision};
          await window.emitNative('leaf-mcp-editor',{call_id:'grant-ui',operation:'binding',args:binding});
          if(aiMock.grantStale)await window.emitNative('leaf-mcp-editor',{call_id:'retired-grant-ui',operation:'binding',args:{...binding,authorization_epoch:3}});
          return {...binding,client:args.client,scope:args.scope};
        }
        const profile = clients.find(p=>p.client===args.client) || clients[0];
        if (command === 'mcp_configure_tunnel') {clients[0].configured=true;clients[0].has_runtime_key=true;clients[0].generation++;clients[0].tunnel={tunnel_id:args.tunnelId,executable:args.executable,proxy_url:args.proxyUrl || ''};runtime.saved_config=runtime.runtime_present=true;runtime.generation=clients[0].generation;runtime.epoch++;return copy({profile:clients[0],runtime,diagnostics});}
        if (command === 'mcp_add_client') {if(aiMock.cancelAdd)return {cancelled:true};profile.configured=profile.enabled=true;profile.generation++;return {profile:copy(profile),cancelled:false,...(os==='windows'&&profile.client==='claude-desktop'?{bundle_path:'C:\\Synthetic folder\\中文 <test> O\'Brien\\Leaf.mcpb'}:{})};}
        if (command === 'mcp_configure_client') {profile.configured=true;profile.generation++;return copy(profile);}
        if (command === 'mcp_enable_client') {profile.enabled=true;profile.generation++;return {profile:copy(profile),descriptor:'/synthetic/descriptor.json'};}
        if (command === 'mcp_revoke_client') {profile.configured=false;profile.enabled=false;profile.generation++;if(profile.client==='chatgpt'){profile.has_runtime_key=false;profile.tunnel=null;runtime.saved_config=runtime.process=runtime.local_ready=false;runtime.epoch++;}return copy(profile);}
        if (command === 'mcp_export_stdio') return {command:'/synthetic/Leaf.app/leaf-mcp-adapter',args:['--descriptor',`/synthetic/${profile.client}.json`]};
        if (command === 'mcp_start_tunnel') {delete aiMock.connectionErrors.chatgpt;runtime.process=true;runtime.local_ready=true;runtime.generation=clients[0].generation;runtime.epoch++;return copy({profile:clients[0],runtime,diagnostics});}
        if (command === 'mcp_stop_tunnel') {runtime.process=runtime.local_ready=false;runtime.epoch++;return copy({profile:clients[0],runtime,diagnostics});}
        return null;
      }
    };
  },{os,startupError});
  await page.goto(`${process.env.LEAF_TEST_BASE_URL || 'http://127.0.0.1:41732'}/?document=1`);
  await page.locator('#appearanceButton').click();
  assert.equal(await page.locator('#settingsTab-ai').getAttribute('aria-selected'),'true', 'restoring the AI tab must run its setup checks without another click');
  await page.waitForFunction(()=>!document.querySelector('#mcpEnabled').disabled, null, {timeout:5000});
  await page.waitForFunction(()=>aiEditorReady(), null, {timeout:5000});
  return page;
}
