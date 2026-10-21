import assert from 'node:assert/strict';
import {webkit} from 'playwright';
import {chromium, launchOptions} from './browser-runtime.mjs';
for (const engine of [chromium, webkit]) {
  const browser=await engine.launch(engine===chromium?launchOptions:{headless:true});
  try {
    const page=await browser.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:41732/tests/native-composition-state.html?browser=1');
    await page.waitForFunction(()=>typeof window.runTest==='function');
    const result=await page.evaluate(()=>window.runTest());
    assert.equal(result.pass,true);assert.equal(result.nativeIME,false);
    assert.deepEqual(errors,[]);
    console.log(`${engine.name()}: PASS synthetic IME acquisition, recovery, diagnostics and repeated tasks`);
  } finally {await browser.close();}
}
