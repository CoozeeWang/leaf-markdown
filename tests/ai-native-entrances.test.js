import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';

async function fixture(action){
  const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','41734','--strictPort'],{stdio:'ignore'});
  let browser;
  try {
    for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:41734')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
    browser=await chromium.launch({channel:process.env.LEAF_BROWSER_CHANNEL||'chrome',headless:true});
    const page=await browser.newPage();
    await page.goto('http://127.0.0.1:41734/tests/native-ai-edit-lock.html?browser');
    await page.waitForFunction(()=>typeof window.runTest==='function');
    const result=await page.evaluate(action=>window[action](),action);
    assert.equal(result.pass,true);
  } finally {await browser?.close();server.kill('SIGTERM');}
}
test('locked writing tools refuse attachment I/O before import',()=>fixture('runTest'));
test('pre-lock attachment completion remains invalid after stop',()=>fixture('runLateTest'));
