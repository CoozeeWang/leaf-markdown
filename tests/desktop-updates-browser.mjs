import assert from 'node:assert/strict';
import {webkit} from 'playwright';
import {chromium,launchOptions} from './browser-runtime.mjs';
const base=process.env.LEAF_TEST_BASE_URL||'http://127.0.0.1:41732';
for(const engine of process.env.LEAF_TEST_ENGINE?[process.env.LEAF_TEST_ENGINE]:['chrome','webkit']){
 const browser=await(engine==='webkit'?webkit.launch({headless:true}):chromium.launch(launchOptions));
 try{
  const page=await browser.newPage({viewport:{width:600,height:480}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
   const callbacks={},handlers={};let id=0;window.calls=[];
   window.updateSnapshot={state:'idle',state_revision:1,installed_version:'1.0.2',target_version:'1.0.3',platform:'darwin-aarch64',candidate_id:'synthetic-release',notes:'Synthetic release notes.',error_code:null};
   window.emitUpdate=patch=>{window.updateSnapshot={...window.updateSnapshot,...patch,state_revision:window.updateSnapshot.state_revision+1};handlers['leaf-update-state']?.({payload:window.updateSnapshot});};
   window.isTauri=true;window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
   window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'desktop-update'},currentWebview:{label:'desktop-update'}},transformCallback:fn=>{callbacks[++id]=fn;return id;},
    invoke:async(command,args={})=>{
     window.calls.push({command,args});
     if(command==='language_get')return {preference:'en',language:'en',revision:0};
     if(command==='language_set')return {preference:args.preference,language:args.preference,revision:window.calls.length};
     if(command==='plugin:event|listen'){handlers[args.event]=callbacks[args.handler];return ++id;}
     if(command==='update_status')return window.updateSnapshot;
     if(command==='update_check'){window.emitUpdate({state:'checking'});return window.updateSnapshot;}
     if(command==='update_open_download'&&window.downloadError)throw window.downloadError;
     return null;
    }};
  });
  await page.goto(base+'/?updateWindow=1');await page.waitForSelector('#app[data-update-state=idle]');
  assert.equal(await page.locator('#update-result').evaluate(el=>el===document.activeElement),true);
  let scenarios=0;
  for(const language of ['zh-Hans','zh-Hant-TW','en'])for(const theme of ['light','dark'])for(const [width,height] of [[600,480],[480,360],[320,420]]){
   await page.setViewportSize({width,height});
   await page.evaluate(async({language,theme})=>{const {setLanguagePreference}=await import('/src/i18n.js');await setLanguagePreference(language);document.documentElement.dataset.theme=theme;},{language,theme});
   for(const state of ['checking','current','available','no_package','check_failed']){
    await page.evaluate(state=>window.emitUpdate({state,error_code:state==='check_failed'?'update_timeout':null}),state);
    assert.equal(await page.locator('#update-action').isDisabled(),state==='checking');
    assert.ok(!(await page.locator('#update-result').innerText()).startsWith('updates.'));
    const geometry=await page.evaluate(()=>{const footer=document.querySelector('#update-footer').getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,bottom:footer.bottom,buttons:[...document.querySelectorAll('#update-footer button')].every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;}),font:getComputedStyle(document.querySelector('#update-message')).fontSize,title:getComputedStyle(document.querySelector('h1')).fontSize};});
    assert.ok(!geometry.overflow&&geometry.buttons&&geometry.bottom<=height+1,JSON.stringify({language,theme,width,state,geometry}));
    assert.equal(geometry.font,'13px');assert.equal(geometry.title,'18px');scenarios++;
   }
  }
  for(const platform of ['darwin-aarch64','darwin-x86_64','windows-x86_64']){
   await page.evaluate(platform=>window.emitUpdate({state:'available',platform,error_code:null}),platform);
   assert.ok((await page.locator('#update-action').innerText()).includes(platform.startsWith('windows')?'Windows':'Mac'));
   await page.click('#update-action');
   const call=await page.evaluate(()=>window.calls.at(-1));assert.equal(call.command,'update_open_download');
   assert.equal(call.args.candidateId,'synthetic-release');assert.ok(Number.isSafeInteger(call.args.stateRevision));
  }
  assert.equal(await page.locator('progress,[role=alertdialog],#update-cancel-download').count(),0,'no in-app transfer or install confirmation');
  await page.evaluate(()=>{window.downloadError='update_stale_confirmation';});await page.click('#update-action');
  assert.equal(await page.locator('#update-error').isVisible(),true);
  await page.click('#update-releases');await page.keyboard.press('Escape');
  const commands=await page.evaluate(()=>window.calls.map(c=>c.command));
  for(const forbidden of ['update_start','update_resume','update_cancel_download','update_participant_status','update_participant_reply'])assert.ok(!commands.includes(forbidden),forbidden);
  assert.ok(commands.includes('update_open_releases'));assert.ok(commands.includes('update_close'));assert.deepEqual(errors,[]);
  console.log(`PASS desktop updates ${engine}: ${scenarios} language/theme/state/viewport cases; platform browser links, close, stale metadata and no installation commands`);
 }finally{await browser.close();}
}
