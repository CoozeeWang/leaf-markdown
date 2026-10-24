import {webkit} from 'playwright';
import {chromium,launchOptions} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const results=[];
const engine=process.env.LEAF_FOOTNOTE_ENGINE||'chromium';
for(const browserType of [engine==='webkit'?webkit:chromium]) {
 const browser=await browserType.launch(engine==='webkit'?{headless:true}:launchOptions);
 try {
  const page=await browser.newPage();await page.goto(process.env.LEAF_TEST_BASE_URL||'http://127.0.0.1:41732');await page.click('#welcomeNewButton');
  await page.evaluate(async()=>{
   const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
   window.v=EditorView.findFromDOM(document.querySelector('#editor .cm-content'));
   window.indexNotes=(await import('/src/footnotes.js')).indexFootnotes;
  });
  const set=source=>page.evaluate(text=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:0},filter:false});v.focus();},source);
  const select=(from,to=from)=>page.evaluate(({from,to})=>{v.dispatch({selection:{anchor:from,head:to}});v.focus();},{from,to});
  const source=()=>page.evaluate(()=>v.state.doc.toString());
  const snapshot=async()=>{
   await select(0);await page.waitForTimeout(70);
   return page.evaluate(()=>({source:v.state.doc.toString(),notes:indexNotes(v.state.doc.toString()).notes.map(n=>({id:n.id,state:n.state,refs:n.refs.length,defined:!!n.def})),rendered:[...document.querySelectorAll('#editor .footnote-ref')].map(n=>n.textContent)}));
  };
  const paragraph='Synthetic paragraph one.[^one]';
  const baseline=two=>paragraph+'\n\nTARGET\n\n[^one]: First synthetic note.'+(two?'\n\n[^two]: Second synthetic note.':'');
  await set(baseline(true));await select(0,paragraph.length);
  const copied=await page.evaluate(()=>{
   const data=new DataTransfer();const event=new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data});
   if(!event.clipboardData)Object.defineProperty(event,'clipboardData',{value:data});
   v.contentDOM.dispatchEvent(event);return Object.fromEntries([...data.types].map(type=>[type,data.getData(type)]));
  });
  results.push({engine,case:'actual_editor_copy',clipboardTypes:Object.keys(copied),plainMatchesSource:copied['text/plain']===paragraph});
  for(const two of [true,false])for(const flavor of ['plain','html','editor-copy']) {
   await set(baseline(two));let text=await source();const at=text.indexOf('TARGET');await select(at,at+6);
   await page.evaluate(({flavor,paragraph,copied})=>{
    const data=new DataTransfer();
    const payload=flavor==='editor-copy'?copied:{'text/plain':paragraph,...(flavor==='html'?{'text/html':'<p>'+paragraph+'</p>'}:{})};
    for(const [type,text] of Object.entries(payload))data.setData(type,text);
    const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});
    if(!event.clipboardData)Object.defineProperty(event,'clipboardData',{value:data});
    v.contentDOM.dispatchEvent(event);
   },{flavor,paragraph,copied});
   const pasted=await source();
   const find=doc=>{const plain=doc.indexOf('[^one]',paragraph.length),escaped=doc.indexOf('\\[^one\\]',paragraph.length);return escaped>=0&&(plain<0||escaped<plain)?{from:escaped,to:escaped+'\\[^one\\]'.length,label:escaped+3}:{from:plain,to:plain+6,label:plain+2};};
   let marker=find(pasted);assert.ok(marker.from>=0,flavor);
   await select(marker.label,marker.label+3);await page.keyboard.type('two');const rename=await snapshot();
   await set(pasted);marker=find(pasted);await select(marker.from,marker.to);await page.keyboard.press('Backspace');await page.keyboard.type('[^two]');const retype=await snapshot();
   const renamed=rename.notes.find(note=>note.id==='two'),typed=retype.notes.find(note=>note.id==='two');
   assert.equal(typed?.state,'complete');assert.equal(typed?.refs,1);
   assert.equal(typed?.defined,true);
   if(flavor==='html') {
    assert.ok(rename.source.includes('\\[^two\\]'),'literal HTML brackets retain escapes');
    assert.equal(renamed?.refs??0,0);
    assert.deepEqual(rename.rendered,['1']);
   } else {
    assert.equal(renamed?.state,'complete');assert.equal(renamed?.refs,1);
    assert.deepEqual(rename.rendered,['1','2']);
   }
   assert.deepEqual(retype.rendered,['1','2']);
   assert.ok(rename.source.includes('[^one]: First synthetic note.'));
   assert.ok(retype.source.includes('[^one]: First synthetic note.'));
   if(two) {
    assert.ok(rename.source.includes('[^two]: Second synthetic note.'));
    assert.ok(retype.source.includes('[^two]: Second synthetic note.'));
   }
   results.push({engine,flavor,initialTwoDefinition:two});
  }
 } finally {await browser.close();}
}
console.log(`${engine}: PASS ${results.length-1} clipboard/definition pairs; edited labels and retyping agree, intentional HTML literals remain text`);
