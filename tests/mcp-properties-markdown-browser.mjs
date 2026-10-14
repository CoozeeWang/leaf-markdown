import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium, launchOptions} from './browser-runtime.mjs';

const browser=await chromium.launch(launchOptions);
try {
  const page=await browser.newPage();
  await page.goto('http://127.0.0.1:41732/');
  await page.locator('#welcomeNewButton').waitFor();
  await test('structured property batch updates only the value through the current task',async()=>{
    const result=await page.evaluate(async()=>{
      const {createLeafEditor}=await import('/src/editor.js');
      const parent=document.createElement('div');document.body.append(parent);
      const source='---\n# keep\ntitle: "Old" # trailing\ncount: 0x10\n---\n\n# Body\n';
      const editor=createLeafEditor({parent,doc:source});
      const task={task_id:'property-task',session_id:'session',authorization_epoch:1,scope:{from:0,to:source.length},revision:0};
      editor.beginAiTask(task);
      try {
        const receipt=await editor.applyMcpBatch({...task,mutation_id:'property-mutation',request_id:'property-request',operations:[{kind:'property',action:'set',key:'title',expected:'"Old"',value:'New'}]});
        editor.finishAiTask(task);const after=editor.getValue();editor.undo();const undo=editor.getValue();editor.redo();
        return {after,undo,redo:editor.getValue(),receipt};
      }catch(error){return {error:error.message};}
      finally{editor.destroy();parent.remove();}
    });
    assert.equal(result.error,undefined,'ordinary property operation must be accepted by the actual editor batch');
    assert.equal(result.after,'---\n# keep\ntitle: "New" # trailing\ncount: 0x10\n---\n\n# Body\n');
    assert.equal(result.undo,'---\n# keep\ntitle: "Old" # trailing\ncount: 0x10\n---\n\n# Body\n');
    assert.equal(result.redo,result.after);assert.equal(result.receipt.changed,true);
  });
  await test('Markdown operations retain mixed source and render CommonMark GFM and Leaf extensions',async()=>{
    const result=await page.evaluate(async()=>{
      const {createLeafEditor}=await import('/src/editor.js');
      const {renderPrintDocument}=await import('/src/print-document.js');
      const parent=document.createElement('div');document.body.append(parent);
      const prefix='---\nname: "Synthetic"\n---\n\n',old='# Old\n\nPlain\n\n- old item\n\n> old quote\n\n```js\nold()\n```\n\n[old link](https://example.invalid/old)\n';
      const suffix='\n![Synthetic](synthetic.png)\n\nRef[^1] {==marked==}{>>comment<<} %%hidden%% ==highlight==\n\n| A | B |\n| --- | --- |\n| one | two |\n\n[^1]: footnote\n';
      const source=prefix+old+suffix,editor=createLeafEditor({parent,doc:source});
      const task={task_id:'markdown-task',session_id:'session',authorization_epoch:1,scope:{from:0,to:source.length},revision:0};
      editor.beginAiTask(task);
      const edits=[['# Old','# New'],['Plain','**Bold😀é**'],['- old item','- new item'],['> old quote','> new quote'],['old()','new()'],['[old link](https://example.invalid/old)','[new link](https://example.invalid/new)']];
      const operations=edits.map(([expected,insert])=>({kind:'markdown',from:source.indexOf(expected),to:source.indexOf(expected)+expected.length,expected,insert}));
      try {
        const receipt=await editor.applyMcpBatch({...task,mutation_id:'markdown-mutation',request_id:'markdown-request',operations});
        editor.finishAiTask(task);const after=editor.getValue();
        const reading=document.createElement('div');renderPrintDocument(reading,after,{properties:true,annotations:true});
        editor.undo();const undo=editor.getValue();editor.redo();
        return {after,undo,redo:editor.getValue(),receipt,prefix,suffix,render:{heading:reading.querySelector('h1')?.textContent,bold:reading.querySelector('strong')?.textContent,list:reading.querySelector('li')?.textContent,quote:reading.querySelector('blockquote')?.textContent,code:reading.querySelector('pre code')?.textContent,link:reading.querySelector('a[href="https://example.invalid/new"]')?.textContent,image:!!reading.querySelector('img'),table:!!reading.querySelector('table'),text:reading.textContent}};
      }catch(error){return {error:error.message};}
      finally{editor.destroy();parent.remove();}
    });
    assert.equal(result.error,undefined,'Markdown operation must reach the actual editor transaction');
    assert.ok(result.after.startsWith(result.prefix)&&result.after.endsWith(result.suffix));
    assert.equal(result.render.heading,'New');assert.equal(result.render.bold,'Bold😀é');
    assert.ok(result.render.list.includes('new item'));assert.ok(result.render.quote.includes('new quote'));
    assert.equal(result.render.code.trim(),'new()');assert.equal(result.render.link,'new link');
    assert.equal(result.render.image,true);assert.equal(result.render.table,true);assert.ok(result.render.text.includes('footnote'));
    assert.ok(result.render.text.includes('highlight')&&!result.render.text.includes('hidden'));
    assert.notEqual(result.undo,result.after);assert.equal(result.redo,result.after);
  });
}finally{await browser.close();}
