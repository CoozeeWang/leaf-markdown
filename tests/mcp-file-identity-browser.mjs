import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium,launchOptions} from './browser-runtime.mjs';
const browser=await chromium.launch(launchOptions);
try {
  const page=await browser.newPage();
  await page.goto('http://127.0.0.1:41732/tests/native-mcp-file-identity.html?browser=1');
  await page.waitForFunction(()=>typeof window.runTest==='function');
  await test('renderer conflict retains external disk and whole AI history and rejects late writes',async()=>{
    const result=await page.evaluate(()=>window.runTest());
    assert.equal(result.pass,true);assert.equal(result.stops,1);assert.equal(result.writes,0);assert.equal(result.late,true);
    assert.equal(result.externalDraft,'External retained draft');
  });
}finally{await browser.close();}
