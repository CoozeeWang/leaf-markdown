import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {writeFile} from 'node:fs/promises';
import {artifactPath} from './browser-runtime.mjs';
const metrics=[];
for(const engine of [chromium,webkit]) {
 const browser=await engine.launch({headless:true});
 try {
  for(const size of [16000,64000,128000])for(const cold of [true,false]) {
   const page=await browser.newPage({viewport:{width:1100,height:900}});
   if(cold)await page.route('**/src/incremental-parse.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace('if (tree && source.length >= 4096','if (false && source.length >= 4096')});});
   await page.goto(process.env.LEAF_TEST_BASE_URL||'http://127.0.0.1:41732');await page.locator('#welcomeNewButton').click();
   const unit='## Synthetic heading\n\nParagraph **bold** ==color== [link][ref] [^one].\n\n> [!note] Synthetic\n> Body words.\n\n';
   const original=unit.repeat(Math.ceil(size/unit.length))+'\n\nEDIT_HERE\n\n%% hidden comment %%\n\n[ref]: https://example.com\n\n[^one]: Footnote words.';
   await page.evaluate(async text=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('#editor .cm-content'));v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:text.indexOf('EDIT_HERE')},scrollIntoView:true});v.focus();},original);
   const times=await page.evaluate(async()=>{let times=[];for(let i=0;i<25;i++){const head=v.state.selection.main.head,t=performance.now();v.dispatch({changes:{from:head,insert:'x'},selection:{anchor:head+1},userEvent:'input.type'});if(i>=5)times.push(performance.now()-t);await new Promise(requestAnimationFrame);}return times;});
   const actual=await page.evaluate(()=>v.state.doc.toString()),expected=original.replace('EDIT_HERE','x'.repeat(25)+'EDIT_HERE');
   if(actual!==expected){let at=0;while(actual[at]===expected[at]&&at<actual.length)at++;throw Error(JSON.stringify({engine:engine.name(),size,cold,at,actual:actual.slice(at-50,at+100),expected:expected.slice(at-50,at+100)}));}
   // Exercise the real native-textarea input route inside a callout as well.
   await page.evaluate(()=>{v.dispatch({selection:{anchor:0},scrollIntoView:true});v.focus();});
   const body=page.locator('.leaf-callout-body .leaf-callout-preview').first();await body.click();
   const input=page.locator('.leaf-callout-body textarea').first();await input.evaluate(n=>n.setSelectionRange(n.value.length,n.value.length));await page.keyboard.type(' typed');
   assert.equal(await input.inputValue(),'Body words. typed');
   const edited=await page.evaluate(()=>v.state.doc.toString());
   assert.ok(edited.includes('%% hidden comment %%'));
   assert.ok(edited.endsWith('[^one]: Footnote words.'));
   times.sort((a,b)=>a-b);metrics.push({engine:engine.name(),size,cold,median:times[Math.floor(times.length/2)],p95:times[Math.floor(times.length*.95)]});
   await page.close();
  }
 } finally {await browser.close();}
}
// Report same-run cold/incremental comparisons rather than timing thresholds
// that vary with the CI runner. Correctness checks above remain mandatory.
await writeFile(artifactPath('editor-input-performance.json'),JSON.stringify(metrics,null,2));
console.log('Synthetic input performance and exact mixed-document preservation:',JSON.stringify(metrics));
