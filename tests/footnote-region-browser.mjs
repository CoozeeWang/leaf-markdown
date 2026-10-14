import assert from 'node:assert/strict';
import {webkit} from 'playwright';
import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
const engines=process.env.LEAF_REGION_ENGINE?[process.env.LEAF_REGION_ENGINE]:['chrome','webkit'];
for(const [engine,platform] of engines.flatMap(engine=>(engine==='chrome'?['MacIntel','Win32']:['MacIntel']).map(platform=>[engine,platform]))) {
 const browser=await(engine==='webkit'?webkit.launch({headless:true}):chromium.launch(launchOptions));
 try {
  const page=await browser.newPage({viewport:{width:1200,height:950}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(platform=>{Object.defineProperty(navigator,'platform',{get:()=>platform});Object.defineProperty(navigator,'userAgentData',{get:()=>undefined});},platform);
  await page.goto('http://127.0.0.1:41732/tests/native-footnote-region.html');
  await page.waitForFunction(()=>window.testEditor);
  const source='正文[^a]。\n\n[^a]: **粗体**、*斜体*、`code`、==高亮==。\n\n尾段';
  await page.evaluate(source=>setTestDoc(source,0),source);
  await page.waitForSelector('.leaf-footnote-region .cm-content');
  assert.equal(await page.evaluate(()=>testEditor.getValue()),source,'opening must retain bytes');
  assert.equal(await page.locator('.leaf-footnote-region').count(),1);
  const foot=page.locator('.leaf-footnote-region');
  assert.equal(await foot.locator('.tok-strong').textContent(),'粗体');
  assert.equal(await foot.locator('.tok-emphasis').textContent(),'斜体');
  const positions=await page.evaluate(()=>({note:document.querySelector('.leaf-footnote-region').getBoundingClientRect().top,body:[...v.contentDOM.children].find(n=>n.textContent==='尾段')?.getBoundingClientRect().bottom}));
  assert.ok(positions.note>positions.body,'notes must follow later body visually');
  const sizes=await page.evaluate(()=>({body:parseFloat(getComputedStyle(v.contentDOM).fontSize),note:parseFloat(getComputedStyle(document.querySelector('.leaf-endnote .cm-line')).fontSize)}));
  assert.ok(sizes.note<sizes.body,JSON.stringify(sizes));
  await page.evaluate(()=>{const c=document.querySelector('.leaf-endnote');window.originalNoteDOM=c._editor.view.contentDOM;});
  await foot.locator('.cm-content').click();
  await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.press('Enter');await page.keyboard.type('Second paragraph');
  assert.ok((await page.evaluate(()=>testEditor.getValue())).includes('    Second paragraph'),'new paragraphs remain in last note');
  assert.equal(await page.evaluate(()=>document.querySelector('.leaf-endnote')._editor.view.contentDOM===originalNoteDOM),true,'active note DOM must survive editing');
  await page.keyboard.press(platform==='MacIntel'?'Meta+z':'Control+z');
  assert.equal(await page.evaluate(()=>testEditor.getValue()),source,'one undo restores note and source order together');
  await page.keyboard.press(platform==='MacIntel'?'Meta+Shift+z':'Control+y');
  assert.ok((await page.evaluate(()=>testEditor.getValue())).includes('    Second paragraph'),JSON.stringify(await page.evaluate(()=>({value:testEditor.getValue(),focus:document.activeElement.outerHTML,history:testEditor.historyDepth()}))));
  await page.evaluate(()=>{
    const note=document.querySelector('.leaf-endnote')._editor.view;
    const data=new DataTransfer();data.setData('text/plain','\n\nPasted note paragraph');
    note.contentDOM.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
  });
  assert.ok((await page.evaluate(()=>testEditor.getValue())).includes('    Pasted note paragraph'),'multiline paste remains inside note');
  await page.evaluate(()=>document.querySelector('.leaf-endnote')._editor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));
  await page.keyboard.press('End');await page.keyboard.insertText('中文');
  await page.evaluate(()=>document.querySelector('.leaf-endnote')._editor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'})));
  await page.waitForTimeout(80);
  assert.ok((await page.evaluate(()=>testEditor.getValue())).includes('Pasted note paragraph中文'));
  assert.equal(await page.evaluate(()=>document.querySelector('.leaf-endnote')._editor.view.contentDOM===originalNoteDOM),true);

  await page.locator('.leaf-continue-body').click();await page.keyboard.type('Continued body');
  const saved=await page.evaluate(()=>testEditor.getValue());
  assert.ok(saved.indexOf('Continued body')<saved.indexOf('[^a]:'));
  assert.ok(saved.includes('尾段'));assert.ok(!saved.includes('\n---\n'));
  await page.evaluate(()=>testEditor.setSource(true));
  assert.equal(await page.locator('.leaf-footnote-region').count(),0);
  assert.equal(await page.evaluate(()=>testEditor.getValue()),saved);
  await page.evaluate(()=>testEditor.setSource(false));
  assert.equal(await page.locator('.leaf-footnote-region').count(),1);
  await foot.screenshot({path:artifactPath(`leaf-footnote-region-${engine}-${platform}.png`)});
  // Full-document search must reveal matches in the moved editing region.
  await page.evaluate(()=>testEditor.openSearch());
  await page.locator('.leaf-search input[name=search]').fill('Pasted');
  await page.locator('.leaf-search button[name=next]').click();
  await page.waitForTimeout(120);
  assert.equal(await page.evaluate(()=>{const child=document.querySelector('.leaf-endnote')._editor.view;return child.state.sliceDoc(child.state.selection.main.from,child.state.selection.main.to);}), 'Pasted', JSON.stringify(await page.evaluate(()=>({source:testEditor.getValue(),selection:v.state.selection.toJSON(),child:document.querySelector('.leaf-endnote')._editor.view.state.selection.toJSON()}))));
  await page.evaluate(()=>{setTestDoc('[^a]: A',0);v.focus();});
  await page.keyboard.type('New body');
  assert.ok((await page.evaluate(()=>testEditor.getValue())).startsWith('New body\n\n[^a]: A'),'note-only file gets a protected body entry');
  const tight='正文[^a]。\n[^a]: A';
  await page.evaluate(text=>{setTestDoc(text,text.indexOf('\n'));v.focus();},tight);
  await page.keyboard.press('Delete');
  assert.equal(await page.evaluate(()=>testEditor.getValue()),tight,'forward delete cannot merge body into a protected note');
  await page.evaluate(()=>{testEditor.setValue('正文[^a]。\r\n\r\n[^a]: A');const note=document.querySelector('.leaf-endnote')._editor.view;note.dispatch({changes:{from:0,to:note.state.doc.length,insert:'A\n\nB'},userEvent:'input.type'});});
  assert.ok((await page.evaluate(()=>testEditor.getValue())).includes('\r\n\r\n    B'),'CRLF and multi-paragraph note survive persistence');
  await page.evaluate(()=>{const {length}=v.state.doc;v.dispatch({selection:{anchor:0,head:length}});v.focus();});
  await page.keyboard.press('Backspace');
  assert.equal(await page.evaluate(()=>testEditor.getValue()),'','explicit full-document deletion still works');
  assert.deepEqual(errors,[]);
  console.log(`PASS ${engine} ${platform}: protected document-end note editing and body continuation`);
 } finally {await browser.close();}
}
