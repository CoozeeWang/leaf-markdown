import assert from 'node:assert/strict';
import { webkit } from 'playwright';
import { chromium, launchOptions } from './browser-runtime.mjs';

const base = process.env.LEAF_TEST_BASE_URL || 'http://127.0.0.1:41732';
const states = ['idle','checking','current','available','no_package','check_failed','downloading','verifying','download_failed','ready','preparing','prepare_failed','committing','install_failed','rolled_back','rollback_failed','installed'];
const busy = new Set(['checking','downloading','verifying','preparing','committing']);
for (const engine of process.env.LEAF_TEST_ENGINE ? [process.env.LEAF_TEST_ENGINE] : ['chrome','webkit']) {
  const browser = await (engine === 'webkit' ? webkit.launch({headless:true}) : chromium.launch(launchOptions));
  try {
    const page = await browser.newPage({viewport:{width:600,height:480},reducedMotion:'reduce'});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const callbacks = {}, handlers = {}; let id = 0;
      window.calls = [];
      window.updateSnapshot = {state:'idle',state_revision:1,op_id:1,installed_version:'0.4.0-beta.4',target_version:'0.5.0',candidate_id:'public-candidate',notes:null,error_code:null};
      window.emitUpdate = patch => {
        window.updateSnapshot = {...window.updateSnapshot,...patch,state_revision:window.updateSnapshot.state_revision+1};
        handlers['leaf-update-state']?.({payload:window.updateSnapshot});
      };
      window.emitRawUpdate=payload=>handlers['leaf-update-state']?.({payload});
      window.emitPanel=payload=>handlers['leaf-update-native-panel']?.({payload});
      window.emitFocus=()=>handlers['tauri://focus']?.({payload:true});
      window.isTauri = true;
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener:()=>{}};
      window.__TAURI_INTERNALS__ = {
        metadata:{currentWindow:{label:'desktop-update'},currentWebview:{label:'desktop-update'}},
        transformCallback:fn=>{callbacks[++id]=fn;return id;},
        invoke:async(command,args={})=>{
          window.calls.push({command,args});
          if(command==='language_get')return {preference:'en',language:'en',revision:0};
          if(command==='language_set')return {preference:args.preference,language:args.preference,revision:window.calls.length};
          if(command==='plugin:event|listen'){handlers[args.event]=callbacks[args.handler];return ++id;}
          if(command==='update_status'){
            if(window.failStatusOnce){window.failStatusOnce=false;throw 'synthetic unavailable';}
            if(window.statusRace){handlers['leaf-update-state']?.({payload:{...window.updateSnapshot,state:'available',state_revision:50}});return {...window.updateSnapshot,state:'current',state_revision:2};}
            return window.updateSnapshot;
          }
          if(command==='update_start'||command==='update_resume'){
            if(window.delayStart)await new Promise(resolve=>window.releaseStart=resolve);
            window.emitUpdate({state:'downloading'});return window.updateSnapshot;
          }
          if(command==='update_check'){window.emitUpdate({state:'checking'});return window.updateSnapshot;}
          return null;
        },
      };
    });
    await page.goto(`${base}/?updateWindow=1`);
    await page.waitForSelector('#app[data-update-state="idle"]');
    assert.equal(await page.locator('#update-result').evaluate(el=>document.activeElement===el),true,'initial focus is explicit');
    await page.evaluate(()=>{
      window.updateSnapshot={...window.updateSnapshot,state:'ready',state_revision:window.updateSnapshot.state_revision+1};
      window.emitFocus();
    });
    await page.waitForSelector('#app[data-update-state="ready"]');
    assert.ok(await page.evaluate(()=>window.calls.filter(c=>c.command==='update_status').length)>=2,'focus fetch recovers a missed hidden event');
    for(const state of states){
      await page.evaluate(state=>window.emitUpdate({state,error_code:state.endsWith('failed')?'update_timeout':null}),state);
      await page.waitForSelector(`#app[data-update-state="${state}"]`);
      assert.equal(await page.locator('#update-action').isDisabled(),busy.has(state),`${state} disabled semantics`);
      assert.ok((await page.locator('#update-result').innerText()).trim(),`${state} result`);
      assert.ok(!(await page.locator('#update-result').innerText()).startsWith('updates.'),`${state} translated result`);
      assert.ok(!(await page.locator('#update-action').innerText()).startsWith('updates.'),`${state} translated action`);
    }
    await page.evaluate(()=>window.emitUpdate({state:'downloading',downloaded_bytes:12345,total_bytes:null}));
    assert.equal(await page.locator('progress').getAttribute('value'),null,'unknown byte totals remain indeterminate');
    assert.ok((await page.locator('#update-progress-text').innerText()).includes('12345'));
    assert.ok(!(await page.locator('#update-progress-text').innerText()).includes('%'));
    await page.evaluate(()=>window.emitUpdate({state:'available',notes:null,error_code:'PRIVATE_PATH_DO_NOT_RENDER'}));
    assert.equal((await page.locator('#update-error').innerText()).includes('PRIVATE_PATH_DO_NOT_RENDER'),false,'unrecognized native diagnostics never reach UI');
    await page.locator('summary').click();
    assert.ok((await page.locator('#update-notes').innerText()).includes('No release notes'));
    await page.locator('summary').click();
    await page.evaluate(()=>window.emitUpdate({state:'available',notes:'<img src=x onerror="window.notesExecuted=true">\n'+ '長Unicode🙂'.repeat(1600)}));
    await page.locator('summary').click();
    assert.equal(await page.locator('#update-notes img').count(),0,'notes are text');
    assert.equal(await page.evaluate(()=>window.notesExecuted),undefined);
    for(const language of ['zh-Hans','zh-Hant-TW','en']){
      await page.evaluate(async language=>{const {setLanguagePreference}=await import('/src/i18n.js');await setLanguagePreference(language);},language);
      for(const theme of ['light','dark'])for(const [width,height]of [[600,480],[480,360],[360,320]]){
        await page.setViewportSize({width,height});
        await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
        const layout=await page.evaluate(()=>{const footer=document.querySelector('#update-footer').getBoundingClientRect(),main=document.querySelector('#update-content');return {footerBottom:footer.bottom,footerTop:footer.top,mainBottom:main.getBoundingClientRect().bottom,overflow:document.documentElement.scrollWidth>innerWidth,scrolls:main.scrollHeight>main.clientHeight};});
        assert.ok(layout.footerBottom<=height+1&&!layout.overflow&&layout.mainBottom<=layout.footerTop+1&&layout.scrolls,JSON.stringify({engine,language,theme,width,height,...layout}));
        for(const state of states){
          await page.evaluate(state=>window.emitUpdate({state,error_code:state.endsWith('failed')?'update_prepare_timeout':null}),state);
          const geometry=await page.evaluate(()=>{
            const footer=document.querySelector('#update-footer').getBoundingClientRect(),main=document.querySelector('#update-content').getBoundingClientRect();
            const controls=[...document.querySelectorAll('#update-footer button')].map(el=>el.getBoundingClientRect());
            return {overflow:document.documentElement.scrollWidth>innerWidth,footerBottom:footer.bottom,mainBottom:main.bottom,footerTop:footer.top,
              controlsFit:controls.every(r=>r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1)};
          });
          assert.ok(!geometry.overflow&&geometry.controlsFit&&geometry.footerBottom<=height+1&&geometry.mainBottom<=geometry.footerTop+1,JSON.stringify({engine,language,theme,width,height,state,...geometry}));
          assert.ok(!(await page.locator('#update-result').innerText()).startsWith('updates.'),`${state} result translated in ${language}`);
        }
        await page.evaluate(()=>window.emitUpdate({state:'available',error_code:null}));
        await page.locator('#update-action').click();
        const modal=await page.locator('.update-confirm').evaluate(el=>{const r=el.getBoundingClientRect(),buttons=[...el.querySelectorAll('button')].map(b=>b.getBoundingClientRect());return r.top>=0&&r.bottom<=innerHeight+1&&r.right<=innerWidth+1&&buttons.every(b=>b.top>=0&&b.bottom<=innerHeight+1&&b.right<=innerWidth+1);});
        assert.equal(modal,true,`${engine} ${language} ${theme} ${width} confirmation actions reachable`);
        await page.locator('#update-confirm-cancel').click();
      }
    }
    // Recovery paths are native-owned text, including long names and markup characters.
    for(const language of ['zh-Hans','zh-Hant-TW','en']){
      await page.evaluate(async language=>{const {setLanguagePreference}=await import('/src/i18n.js');await setLanguagePreference(language);},language);
      for(const theme of ['light','dark'])for(const [width,height]of [[600,480],[480,360],[360,320]]){
        await page.setViewportSize({width,height});
        const recovery='/Synthetic/Retained <Leaf>/'+'長名稱🙂'.repeat(80)+'/Previous.app';
        await page.evaluate(({theme,recovery})=>{document.documentElement.dataset.theme=theme;window.emitUpdate({state:'rollback_failed',error_code:'native_install_failed',recovery_location:recovery});},{theme,recovery});
        assert.ok((await page.locator('#update-recovery-location').innerText()).includes(recovery));
        assert.equal(await page.locator('#update-recovery-location img').count(),0);
        const expected=await page.evaluate(async()=>{const {t}=await import('/src/i18n.js');return t('updates.rollback_failed');});
        const result=(await page.locator('#update-result').innerText())+' '+(await page.locator('#update-message').innerText());
        assert.equal(result.replaceAll(' ',''),expected.replaceAll(' ',''));
        assert.equal(await page.locator('#update-error').isVisible(),false,'no duplicate generic failure paragraph');
        const layout=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,footer:document.querySelector('#update-footer').getBoundingClientRect().bottom}));
        assert.ok(!layout.overflow&&layout.footer<=height+1,JSON.stringify({language,theme,width,height,...layout}));
      }
    }
    await page.evaluate(()=>window.emitUpdate({state:'install_failed',candidate_id:null,error_code:'native_install_failed'}));
    assert.equal(await page.locator('#update-action').isEnabled(),true,'restart failure permits a fresh check');
    const checks=await page.evaluate(()=>window.calls.filter(c=>c.command==='update_check').length);
    await page.locator('#update-action').click();
    await page.waitForSelector('#app[data-update-state="checking"]');
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='update_check').length),checks+1);
    assert.equal(await page.locator('[role=alertdialog]').count(),0,'fresh check does not resume a missing package');
    await page.evaluate(()=>window.emitUpdate({state:'available',candidate_id:'public-candidate',error_code:null,recovery_location:null}));
    // Pending production identity is a separate flag, outside the default state matrix.
    for(const language of ['zh-Hans','zh-Hant-TW','en']){
      await page.evaluate(async language=>{const {setLanguagePreference}=await import('/src/i18n.js');await setLanguagePreference(language);},language);
      for(const theme of ['light','dark'])for(const [width,height]of [[600,480],[480,360],[360,320]]){
        await page.setViewportSize({width,height});
        await page.evaluate(theme=>{
          document.documentElement.dataset.theme=theme;
          window.emitUpdate({state:'available',error_code:'update_signing_identity_pending',notes:'Synthetic available release notes'});
        },theme);
        assert.equal(await page.locator('#update-action').innerText(),await page.locator('#update-releases').innerText(),'pending build offers the releases action');
        const prior=await page.evaluate(()=>window.calls.filter(c=>c.command==='update_open_releases').length);
        await page.locator('#update-action').click();
        await page.waitForFunction(()=>!document.getElementById('update-action').disabled);
        assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='update_open_releases').length),prior+1);
        assert.equal(await page.locator('[role=alertdialog]').count(),0,'pending build never offers a fake update confirmation');
        assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='update_start'||c.command==='update_resume').length),0);
        assert.equal(await page.locator('#update-close').isEnabled(),true);
        assert.equal(await page.locator('#update-releases').isEnabled(),true);
        assert.ok(!(await page.locator('#update-error').innerText()).startsWith('updates.'));
        const geometry=await page.locator('#update-footer').evaluate(el=>{
          const r=el.getBoundingClientRect();return r.bottom<=innerHeight+1&&document.documentElement.scrollWidth<=innerWidth;
        });
        assert.equal(geometry,true,engine+' pending '+language+' '+theme+' '+width);
      }
    }
    await page.locator('#update-close').click();
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='update_close').length),1,'pending build can close');
    await page.evaluate(()=>{window.calls=[];window.emitUpdate({state:'available',error_code:null});});
    await page.setViewportSize({width:600,height:480});
    await page.locator('#update-action').click();
    assert.equal(await page.locator('[role=alertdialog]').count(),1,'one confirmation');
    assert.equal(await page.locator('#update-confirm-cancel').evaluate(el=>document.activeElement===el),true,'safe default Cancel');
    assert.equal(await page.locator('#app').evaluate(el=>el.inert),true,'background inert');
    await page.keyboard.press('Shift+Tab');assert.equal(await page.locator('#update-confirm-submit').evaluate(el=>document.activeElement===el),true,'reverse Tab loops');
    await page.keyboard.press('Tab');assert.equal(await page.locator('#update-confirm-cancel').evaluate(el=>document.activeElement===el),true,'Tab loops');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[role=alertdialog]').count(),0);
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='update_close').length),0,'one Escape only cancels confirmation');
    assert.equal(await page.locator('#update-action').evaluate(el=>document.activeElement===el),true,'confirmation cancellation restores trigger focus');
    await page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',repeat:true,bubbles:true})));
    await page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true})));
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='update_close').length),0,'held/composing Escape ignored');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='update_close').length),1);
    await page.evaluate(()=>window.emitPanel(true));
    await page.keyboard.press('Escape');
    await page.locator('#update-action').evaluate(el=>el.click());
    assert.equal(await page.locator('[role=alertdialog]').count(),0,'native save panel outranks confirmation');
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='update_close').length),1,'native save panel Escape does not hide updater');
    await page.evaluate(()=>window.emitPanel(false));
    await page.locator('#update-action').click();
    await page.locator('#update-confirm-submit').click();
    await page.waitForSelector('#app[data-update-state="downloading"]');
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='update_start').length),1,'one start');
    await page.locator('#update-action').evaluate(el=>el.click());
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='update_start').length),1,'busy cannot replay');
    await page.evaluate(()=>window.emitUpdate({state:'ready'}));await page.locator('#update-action').click();
    assert.equal(await page.locator('[role=alertdialog]').count(),1,'ready needs fresh confirmation');
    await page.locator('#update-confirm-cancel').click();
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='update_resume').length),0,'Cancel cannot resume');
    await page.evaluate(()=>{window.emitUpdate({state:'available'});window.delayStart=true;window.calls=[];});
    await page.locator('#update-action').click();await page.locator('#update-confirm-submit').click();
    await page.waitForFunction(()=>window.releaseStart);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='update_close').length),1,'close revokes continuation while start IPC is pending');
    await page.evaluate(()=>{window.releaseStart();window.delayStart=false;});
    await page.waitForSelector('#app[data-update-state="downloading"]');
    await page.addInitScript(()=>window.statusRace=true);
    await page.reload();await page.waitForSelector('#app[data-update-state="available"]');
    assert.equal(await page.locator('#app').getAttribute('data-state-revision'),'50','new event wins over old snapshot');
    await page.evaluate(()=>{window.emitRawUpdate({...window.updateSnapshot,state:'installed',state_revision:50});window.emitRawUpdate({...window.updateSnapshot,state:'current',state_revision:49});});
    assert.equal(await page.locator('#app').getAttribute('data-update-state'),'available','equal and lower revisions cannot change state');
    await page.addInitScript(()=>window.failStatusOnce=true);
    await page.reload();await page.waitForFunction(()=>document.activeElement?.id==='update-result');
    assert.equal(await page.locator('#update-action').isEnabled(),true,'initial IPC failure offers a working retry');
    for(const selector of ['h1','#update-close','#update-releases'])assert.ok((await page.locator(selector).innerText()).trim(),'initial failure retains translated safe controls');
    await page.locator('#update-action').click();await page.waitForSelector('#app[data-update-state="available"]');
    assert.deepEqual(errors,[]);
    await page.close();console.log(`PASS desktop updates ${engine}: states, text, layout, confirmation, keyboard, revisions`);
  }finally{await browser.close();}
}
