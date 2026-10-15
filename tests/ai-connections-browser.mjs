import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium, launchOptions, artifactPath} from './browser-runtime.mjs';

const browser = await chromium.launch(launchOptions);
async function nativePage() {
  const page = await browser.newPage({viewport:{width:720,height:720}});
  page.on('pageerror', error=>console.error('AI UI page error:',error.message));
  await page.route('https://api.github.com/**', route => route.fulfill({json:{draft:false,prerelease:false,tag_name:'v0.0.16',assets:[{name:'tunnel-client-v0.0.16-darwin-arm64.zip',state:'uploaded',browser_download_url:'https://github.com/openai/tunnel-client/releases/download/v0.0.16/tunnel-client-v0.0.16-darwin-arm64.zip'}]}}));
  await page.addInitScript(() => {
    window.isTauri = true;
    localStorage.setItem('leaf-settings-tab','ai');
    const callbacks = {}, handlers = {}; let id = 0;
    let language = {preference:'zh-Hans',language:'zh-Hans',revision:0};
    const clients = ['chatgpt','claude-desktop','workbuddy'].map(client => ({client,configured:false,enabled:false,generation:0,tunnel:null,has_runtime_key:false}));
    const runtime = {generation:0,epoch:0,saved_config:false,runtime_present:false,process:false,local_ready:false,host_verified:false,last_error:null};
    window.aiMock = {enabled:false, clients, runtime, calls:[], fail:null, hold:false, pending:[], keySeen:false};
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
        if (command === 'mcp_connection_platform') return {os:'macos',arch:'aarch64'};
        if (!command.startsWith('mcp_')) return null;
        // Only a boolean records input receipt: mock diagnostics never retain it.
        const safe = {...args}; if ('runtimeKey' in safe) {aiMock.keySeen=!!safe.runtimeKey; delete safe.runtimeKey;}
        aiMock.calls.push({command,args:safe});
        if (aiMock.fail===command) throw 'synthetic_connection_error';
        if (command === 'mcp_profiles') {
          const snapshot = copy({enabled:aiMock.enabled,clients});
          if (aiMock.hold) return new Promise(resolve => aiMock.pending.push(()=>resolve(snapshot)));
          return snapshot;
        }
        if (command === 'mcp_tunnel_status') return copy({profile:clients[0],runtime});
        if (command === 'mcp_set_enabled') {aiMock.enabled=args.enabled; if(!args.enabled){clients.forEach(p=>{p.enabled=false;p.generation++;});runtime.process=runtime.local_ready=false;runtime.epoch++;}return copy({enabled:aiMock.enabled,clients});}
        if (command === 'mcp_authorize') {
          const binding={document_id:'doc-ui',session_id:args.sessionId,authorization_epoch:2,mutation_generation:0,revision:args.revision};
          await window.emitNative('leaf-mcp-editor',{call_id:'grant-ui',operation:'binding',args:binding});
          if(aiMock.grantStale)await window.emitNative('leaf-mcp-editor',{call_id:'retired-grant-ui',operation:'binding',args:{...binding,authorization_epoch:3}});
          return {...binding,client:args.client,scope:args.scope};
        }
        const profile = clients.find(p=>p.client===args.client) || clients[0];
        if (command === 'mcp_configure_tunnel') {clients[0].configured=true;clients[0].has_runtime_key=true;clients[0].generation++;clients[0].tunnel={tunnel_id:args.tunnelId,executable:args.executable};runtime.saved_config=runtime.runtime_present=true;runtime.generation=clients[0].generation;runtime.epoch++;return copy({profile:clients[0],runtime});}
        if (command === 'mcp_configure_client') {profile.configured=true;profile.generation++;return copy(profile);}
        if (command === 'mcp_enable_client') {profile.enabled=true;profile.generation++;return {profile:copy(profile),descriptor:'/synthetic/descriptor.json'};}
        if (command === 'mcp_revoke_client') {profile.configured=false;profile.enabled=false;profile.generation++;if(profile.client==='chatgpt'){profile.has_runtime_key=false;profile.tunnel=null;runtime.saved_config=runtime.process=runtime.local_ready=false;runtime.epoch++;}return copy(profile);}
        if (command === 'mcp_export_stdio') return {command:'/synthetic/Leaf.app/leaf-mcp-adapter',args:['--descriptor',`/synthetic/${profile.client}.json`]};
        if (command === 'mcp_start_tunnel') {runtime.process=true;runtime.local_ready=true;runtime.generation=clients[0].generation;runtime.epoch++;return copy({profile:clients[0],runtime});}
        if (command === 'mcp_stop_tunnel') {runtime.process=runtime.local_ready=false;runtime.epoch++;return copy({profile:clients[0],runtime});}
        return null;
      }
    };
  });
  await page.goto(`${process.env.LEAF_TEST_BASE_URL || 'http://127.0.0.1:41732'}/?document=1`);
  await page.locator('#appearanceButton').click();
  assert.equal(await page.locator('#settingsTab-ai').getAttribute('aria-selected'),'true', 'restoring the AI tab must run its setup checks without another click');
  await page.waitForFunction(()=>!document.querySelector('#mcpEnabled').disabled, null, {timeout:5000});
  await page.waitForFunction(()=>aiEditorReady(), null, {timeout:5000});
  return page;
}
try {
  await test('current-document authorization defaults to the whole document and still requires an explicit action', async () => {
    const page = await nativePage();
    assert.equal(await page.locator('#aiAuthorizeDocument').count(), 1, 'normal settings must expose document authorization');
    assert.ok(await page.locator('#aiAuthorizeDocument').isDisabled());
    await page.locator('#mcpEnabled').check();
    await page.locator('#aiClient').selectOption('workbuddy');
    await page.locator('#aiLocalConfigure').click();
    await page.waitForFunction(()=>aiMock.clients.find(p=>p.client==='workbuddy').enabled);
    assert.equal(await page.evaluate(()=>aiMock.calls.filter(c=>c.command==='mcp_authorize').length),0);
    assert.equal(await page.locator('#aiDocumentScope').count(),0);
    assert.equal(await page.locator('#aiDocumentTarget').count(),0);
    await page.waitForFunction(()=>!document.querySelector('#aiAuthorizeDocument').disabled);
    await page.locator('#aiAuthorizeDocument').click();
    await page.waitForFunction(()=>aiMock.calls.some(c=>c.command==='mcp_authorize'));
    const call=await page.evaluate(()=>aiMock.calls.find(c=>c.command==='mcp_authorize'));
    assert.equal(call.args.client,'workbuddy');
    assert.equal(call.args.sessionId,'session-ui');
    assert.deepEqual(call.args.scope,{from:0,to:'# Synthetic\n\nUnchanged body.'.length});
    assert.ok(Number.isSafeInteger(call.args.revision));
    await page.waitForFunction(()=>document.querySelector('#aiDocumentGrantStatus').textContent.includes('WorkBuddy'));
    await page.evaluate(()=>{aiMock.grantStale=true;});
    await page.locator('#aiAuthorizeDocument').click();
    await page.waitForFunction(()=>document.querySelector('#aiConnectionError').textContent.length>0);
    assert.equal(await page.locator('#aiDocumentGrantStatus').textContent(),'','retired result cannot claim a current grant');
    await page.locator('#mcpEnabled').uncheck();
    assert.ok(await page.locator('#aiAuthorizeDocument').isDisabled());
    await page.close();
  });
  await test('AI settings are the third tab and require native confirmed connection state', async () => {
    const page = await browser.newPage({viewport:{width:720,height:720}});
    await page.goto(process.env.LEAF_TEST_BASE_URL || 'http://127.0.0.1:41732/');
    await page.locator('#welcomeSettings').click();
    assert.deepEqual(await page.locator('[data-settings-tab]').allTextContents(), ['外观与排版','保存与恢复','AI 辅助编辑']);
    await page.locator('#settingsTab-ai').click();
    assert.equal(await page.locator('#settingsPanel-ai h3').innerText(), 'MCP 连接');
    assert.equal(await page.locator('#mcpEnabled').isChecked(), false);
    assert.equal(await page.locator('#mcpEnabled').isDisabled(), true);
    assert.match(await page.locator('#aiConnectionError').innerText(), /桌面/);
    assert.deepEqual(await page.locator('#aiClient option').evaluateAll(nodes => nodes.map(n=>n.value)), ['chatgpt','claude-desktop','workbuddy']);
    assert.equal(await page.locator('[data-software-hint]').count(), 0);
    await page.close();
  });
  await test('three native profiles coexist, secrets are ephemeral, failures preserve settings and clear has scoped confirmation', async () => {
    const page = await nativePage();
    assert.equal(await page.locator('#mcpEnabled').isChecked(), false);
    await page.locator('#mcpEnabled').click();
    await page.locator('#aiTunnelId').fill('tunnel_syntheticui');
    await page.locator('#aiPickProgram').click();
    assert.equal(await page.locator('#aiTunnelProgram').inputValue(), 'tunnel-client');
    await page.locator('#aiRuntimeKey').fill('synthetic-private-key-not-for-output');
    await page.locator('#aiSaveSetup').click();
    await page.waitForFunction(()=>document.querySelector('#aiEditSetup').hidden===false);
    assert.equal(await page.locator('#aiRuntimeKey').inputValue(), '');
    assert.equal(await page.evaluate(()=>document.body.innerHTML.includes('synthetic-private-key-not-for-output')), false);
    assert.equal(await page.evaluate(()=>aiMock.keySeen), true);
    assert.equal(await page.locator('#aiConfigured').count(), 0);
    assert.equal(await page.locator('#aiDevice').innerText(), '本机：macOS · Apple 芯片（arm64）');
    await page.waitForFunction(()=>document.querySelector('#aiDownload').textContent.includes('darwin-arm64.zip'));
    assert.equal(await page.locator('#aiRuntimeKey').getAttribute('placeholder'), '已保存（不显示）');
    const position = await page.locator('#aiClear').evaluate(node=>({clear:node.getBoundingClientRect().toJSON(),select:document.querySelector('#aiClient').getBoundingClientRect().toJSON(),edit:document.querySelector('#aiEditSetup').getBoundingClientRect().toJSON()}));
    assert.ok(position.clear.top >= position.select.bottom);
    assert.ok(position.edit.right < position.clear.left, 'edit belongs immediately left of clear');
    assert.ok(Math.abs(position.edit.top-position.clear.top)<2, 'configuration actions share one row');
    assert.ok(Math.abs(position.clear.right-position.select.right)<2);
    await page.locator('.appearance-scroll').evaluate(node=>node.scrollTop=0);
    await page.screenshot({path:artifactPath('ai-settings-configured-720.png')});
    assert.equal(await page.locator('#aiStartTunnel').count(),0);
    assert.equal(await page.locator('#aiActionStatus').innerText(), '');
    await page.waitForFunction(()=>document.querySelector('#aiRuntimeStatus').dataset.state==='local-ready');
    assert.match(await page.locator('#aiRuntimeStatus').innerText(), /本地/);
    assert.doesNotMatch(await page.locator('#aiRuntimeStatus').innerText(), /成功调用/);
    for (const client of ['claude-desktop','workbuddy']) {
      await page.locator('#aiClient').selectOption(client); await page.locator('#aiLocalConfigure').click();
      await page.waitForFunction(()=>!document.querySelector('#aiCopyConfig').disabled);
      assert.match(await page.locator('#aiExported').innerText(), /leaf-mcp-adapter/);
    }
    assert.equal(await page.evaluate(()=>aiMock.clients.filter(p=>p.enabled).length), 3);
    const before = await page.evaluate(()=>aiMock.calls.length);
    await page.locator('#aiClient').selectOption('chatgpt');
    assert.equal(await page.evaluate(()=>aiMock.calls.slice(0).length), before, 'selection only changes details');
    await page.locator('#aiClear').click();
    assert.equal(await page.locator('dialog h2').innerText(), '清除 ChatGPT 连接配置');
    assert.equal(await page.locator('[data-ai-cancel]').evaluate(n=>n===document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog').count(), 0);
    assert.equal(await page.locator('#aiClear').evaluate(n=>n===document.activeElement), true);
    await page.evaluate(()=>aiMock.fail='mcp_revoke_client');
    await page.locator('#aiClear').click(); await page.locator('[data-ai-confirm]').click();
    await page.waitForFunction(()=>document.querySelector('#aiClearError').textContent.length>0);
    assert.equal(await page.evaluate(()=>aiMock.clients.every(p=>p.configured)), true);
    await page.locator('[data-ai-cancel]').click();
    await page.evaluate(()=>aiMock.fail=null);
    await page.locator('#aiClear').click(); await page.locator('[data-ai-confirm]').click();
    await page.waitForFunction(()=>!document.querySelector('dialog'));
    assert.deepEqual(await page.evaluate(()=>aiMock.clients.map(p=>p.configured)), [false,true,true]);
    assert.equal(await page.locator('#aiClient').evaluate(n=>n===document.activeElement), true);
    await page.locator('#mcpEnabled').uncheck();
    await page.waitForFunction(()=>!document.querySelector('#mcpEnabled').disabled);
    assert.deepEqual(await page.evaluate(()=>aiMock.clients.map(p=>p.configured)), [false,true,true], 'master off preserves independent settings');
    await page.locator('#mcpEnabled').check();
    await page.waitForFunction(()=>aiMock.clients.slice(1).every(p=>p.enabled));
    assert.equal(await page.evaluate(()=>aiMock.calls.filter(c=>c.command==='mcp_authorize').length),0, 'reconnecting configured clients never authorizes a document');
    await page.close();
  });
  await test('three languages, narrow themes and fixed settings chrome retain clear keyboard targets', async () => {
    const page = await nativePage();
    for (const language of ['zh-Hans','zh-Hant-TW','en']) {
      await page.evaluate(async value => {const {setLanguagePreference}=await import('/src/i18n.js');await setLanguagePreference(value);},language);
      assert.match(await page.locator('#aiDevice').innerText(), /Apple/);
      assert.doesNotMatch(await page.locator('#aiDevice').innerText(), /aarch64/);
      for (const width of [320,390,720,1000]) for (const theme of ['light','dark']) {
        await page.setViewportSize({width,height:720});
        await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
        await page.locator('#appearanceButton').click();
        await page.locator('#settingsTab-ai').click();
        const bounds = await page.locator('#appearancePopover').evaluate(node => ({box:node.getBoundingClientRect().toJSON(),scroll:node.scrollWidth,width:node.clientWidth}));
        assert.ok(bounds.box.left>=0 && bounds.box.right<=width, 'settings stays in viewport');
        assert.ok(bounds.scroll<=bounds.width+1, 'settings has no horizontal overflow');
        assert.equal(await page.locator('.ai-guided-steps > li').count(),4);
        const heading = await page.locator('.settings-heading').boundingBox(), version = await page.locator('.settings-about').boundingBox();
        await page.locator('.appearance-scroll').evaluate(n=>n.scrollTop=n.scrollHeight);
        assert.deepEqual(await page.locator('.settings-heading').boundingBox(),heading);
        assert.deepEqual(await page.locator('.settings-about').boundingBox(),version);
        if(width===390) await page.screenshot({path:artifactPath(`ai-settings-${language}-${theme}.png`)});
        await page.keyboard.press('Escape');
      }
    }
    await page.close();
  });
  await test('failed master switch waits for broker and old refresh results cannot restore revoked profiles', async () => {
    const page = await nativePage();
    await page.evaluate(()=>aiMock.fail='mcp_set_enabled');
    await page.locator('#mcpEnabled').click();
    await page.waitForFunction(()=>document.querySelector('#aiConnectionError').textContent.length>0);
    assert.equal(await page.locator('#mcpEnabled').isChecked(), false);
    await page.evaluate(()=>{aiMock.fail=null;aiMock.hold=true;window.dispatchEvent(new Event('focus'));});
    await page.waitForFunction(()=>aiMock.pending.length===1);
    await page.evaluate(()=>{aiMock.clients[1].configured=true;aiMock.clients[1].generation=4;window.dispatchEvent(new Event('focus'));});
    await page.waitForFunction(()=>aiMock.pending.length===2);
    await page.evaluate(()=>aiMock.pending[1]());
    await page.waitForFunction(()=>document.querySelector('#aiClient option[value="claude-desktop"]').textContent.includes('已配置'));
    await page.evaluate(()=>aiMock.pending[0]());
    await page.waitForTimeout(50);
    assert.match(await page.locator('#aiClient option[value="claude-desktop"]').innerText(), /已配置/);
    await page.evaluate(()=>aiMock.hold=false);
    await page.close();
  });
  await test('persistent AI notice has one localized sentence, a lock, reachable stop and an independent save error', async () => {
    const page = await nativePage();
    await page.keyboard.press('Escape');
    await page.evaluate(async()=>{
      const content='# Synthetic\n\nUnchanged body.';
      await emitNative('leaf-mcp-editor',{call_id:'notice-snapshot',operation:'snapshot',args:{}});
      const revision=aiMock.calls.findLast(call=>call.command==='mcp_renderer_reply').args.reply.result.revision;
      await emitNative('leaf-mcp-editor',{call_id:'notice-binding',operation:'binding',args:{document_id:'doc-ui',session_id:'session-ui',authorization_epoch:4,mutation_generation:0,revision}});
      await emitNative('leaf-mcp-editor',{call_id:'notice-begin',operation:'begin',args:{document_id:'doc-ui',session_id:'session-ui',task_id:'task-ui',client:'chatgpt',authorization_epoch:4,mutation_generation:0,scope:{from:0,to:content.length},revision}});
    });
    const notice=page.locator('#aiTaskNotice');
    await notice.waitFor();
    assert.equal(await notice.locator('.ai-task-lock').count(), 1, 'persistent task must expose the approved linear lock icon');
    const copies={'zh-Hans':'ChatGPT 正在辅助编辑，此文档暂时只读，可浏览、查找。','zh-Hant-TW':'ChatGPT 正在輔助編輯，此文件暫時唯讀，可瀏覽、尋找。','en':'ChatGPT is editing. This document is temporarily read-only; you can browse and find.'};
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('leaf-image-reveal-failed',{detail:'Synthetic save failure · 路径Δ'.repeat(120)})));
    for(const [language,copy]of Object.entries(copies)) {
      await page.evaluate(async value=>{const {setLanguagePreference}=await import('/src/i18n.js');await setLanguagePreference(value);},language);
      assert.equal(await notice.locator('.ai-task-copy').innerText(),copy);
      assert.equal(await notice.locator('.ai-task-copy').count(),1);
      assert.ok(await page.locator('#statusNotice').isVisible());
      for(const width of [320,390,720,1000]) for(const theme of ['light','dark']) {
        await page.setViewportSize({width,height:720});await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
        const bounds=await page.evaluate(()=>{const box=id=>document.querySelector(id).getBoundingClientRect().toJSON();return {task:box('#aiTaskNotice'),stop:box('#aiTaskNotice button'),toolbar:box('.format-toolbar'),document:box('.document-area'),scroll:document.documentElement.scrollWidth};});
        assert.ok(bounds.task.top>=bounds.toolbar.bottom-1&&bounds.task.bottom<=bounds.document.top+1);
        assert.ok(bounds.stop.right<=width&&bounds.stop.bottom<=720,`stop remains in viewport: ${JSON.stringify({width,language,bounds})}`);
        assert.ok(bounds.scroll<=width,'notices do not widen the window');
        if(width===390) await page.screenshot({path:artifactPath(`ai-notice-${language}-${theme}.png`)});
      }
    }
    await notice.locator('button').focus();assert.equal(await notice.locator('button').evaluate(n=>n===document.activeElement),true);
    await page.evaluate(()=>aiMock.fail='mcp_stop_edit');
    await notice.locator('button').click();
    await page.waitForFunction(()=>!document.querySelector('#aiTaskNotice button').disabled);
    assert.equal(await page.locator('#aiTaskNotice').getAttribute('aria-busy'),'false');
    assert.ok(await page.locator('#statusNotice').isVisible(),'stop failure keeps the independent save error');
    assert.equal(await page.evaluate(()=>aiMock.calls.findLast(c=>c.command==='mcp_stop_edit').args.taskId),'task-ui');
    await page.evaluate(()=>aiMock.fail=null);
    await page.locator('#dismissStatus').click();assert.ok(await notice.isVisible());
    await page.evaluate(async()=>{await emitNative('leaf-mcp-editor',{call_id:'notice-finish',operation:'finish',args:{task_id:'retired-task',session_id:'session-ui',document_id:'doc-ui',authorization_epoch:1,mutation_generation:0}});});
    assert.ok(await notice.isVisible(),'retired task event cannot clear the current notice');
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('leaf-image-reveal-failed',{detail:'Synthetic save failure retained after finish'})));
    await page.evaluate(async()=>{const {desktopAiApplied}=await import('/src/desktop.js');desktopAiApplied({session_id:'session-ui',mutation_id:'synthetic-pending-save',applied_revision:2,changed:true});});
    await page.evaluate(async()=>{await emitNative('leaf-mcp-editor',{call_id:'notice-end',operation:'finish',args:{task_id:'task-ui',session_id:'session-ui',document_id:'doc-ui',authorization_epoch:4,mutation_generation:1}});});
    assert.ok(await notice.isHidden());
    assert.ok(await page.locator('#statusNotice').isVisible(),'finalization clears only the task slot');
    assert.match(await page.locator('#statusAnnouncement').textContent(), /not saved yet/);
    await page.close();
  });
} finally { await browser.close(); }
