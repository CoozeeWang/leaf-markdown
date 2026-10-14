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
  await test('invalid or conflicting operations leave content revision and history unchanged',async()=>{
    const result=await page.evaluate(async()=>{
      const {createLeafEditor}=await import('/src/editor.js');
      const parent=document.createElement('div');document.body.append(parent);
      const source='---\nx: "one"\n---\n\nBody😀é\n\n# Outside\n\n![image](synthetic.png)\n';
      const editor=createLeafEditor({parent,doc:source});
      const task={task_id:'refusal-task',session_id:'session',authorization_epoch:1,scope:{from:0,to:source.length},revision:0};
      editor.beginAiTask(task);const before=editor.mcpSnapshot(),history=editor.historyDepth();
      const field={kind:'property',action:'set',key:'x',expected:'"one"',value:'two'},at=source.indexOf('Body');
      const invalid=[{operations:[]},{operations:[{kind:'unknown'}]},{operations:[{...field,key:'missing'}]},{operations:[{...field,expected:'stale'}]},
        {operations:[field],changes:[{from:7,to:12,expected:'"one"',insert:'collision'}]},
        {operations:[{...field,value:'one'}],changes:[{from:7,to:12,expected:'"one"',insert:'collision'}]},
        {operations:[field,{kind:'markdown',from:at+5,to:at+5,expected:'',insert:'split'}]},
        {operations:[field,{kind:'markdown',from:at,to:at+4,expected:'Body',insert:'```'}]},
        {revision:99,operations:[field]},{session_id:'retired',operations:[field]},{authorization_epoch:0,operations:[field]}];
      const rows=[];
      for(const [index,args]of invalid.entries()) {
        let refused=false;try{await editor.applyMcpBatch({...task,mutation_id:`refused-${index}`,request_id:`refused-${index}`,...args});}catch{refused=true;}
        rows.push(refused&&JSON.stringify(editor.mcpSnapshot())===JSON.stringify(before)&&JSON.stringify(editor.historyDepth())===JSON.stringify(history));
      }
      editor.finishAiTask(task);editor.destroy();parent.remove();return rows;
    });
    assert.deepEqual(result,Array(11).fill(true),'all eleven failures must preserve the same snapshot and history');
  });
  await test('LF protocol operations preserve original CRLF and exact task undo',async()=>{
    const result=await page.evaluate(async()=>{
      const {createLeafEditor}=await import('/src/editor.js');const parent=document.createElement('div');document.body.append(parent);
      const source='---\r\n---\r\n\r\nBody😀é\r\n',editor=createLeafEditor({parent,doc:source}),before=editor.mcpSnapshot();
      const task={task_id:'crlf-task',session_id:'session',authorization_epoch:1,scope:{from:0,to:before.content.length},revision:0};editor.beginAiTask(task);
      const at=before.content.indexOf('Body');
      await editor.applyMcpBatch({...task,mutation_id:'crlf-mutation',request_id:'crlf-request',operations:[{kind:'property',action:'add',key:'label',expected:'',value:'new'},{kind:'markdown',from:at,to:at+4,expected:'Body',insert:'Updated'}]});
      editor.finishAiTask(task);const after=editor.getValue(),snapshot=editor.mcpSnapshot();editor.undo();const undo=editor.getValue();editor.redo();const redo=editor.getValue();editor.destroy();parent.remove();return {source,after,snapshot,undo,redo};
    });
    assert.equal(result.after,'---\r\n"label": "new"\r\n---\r\n\r\nUpdated😀é\r\n');
    assert.equal(result.snapshot.line_ending,'\r\n');assert.ok(!result.snapshot.content.includes('\r'));
    assert.equal(result.undo,result.source);assert.equal(result.redo,result.after);
  });
  await test('final mixed YAML validation rejects malformed YAML and field tampering without revision or history changes',async()=>{
    const rows=await page.evaluate(async()=>{
      const {createLeafEditor}=await import('/src/editor.js');const rows=[];
      for(const comment of [false,true]) {
        const source='---\nx: old\ny: good\n---\n\nBody',parent=document.createElement('div');document.body.append(parent);
        const editor=createLeafEditor({parent,doc:source}),task={task_id:`yaml-${comment}`,session_id:'session',document_id:'document',authorization_epoch:1,scope:{from:0,to:source.length},revision:0};
        editor.beginAiTask(task);const before=editor.mcpSnapshot(),history=editor.historyDepth();
        const operations=[{kind:'property',action:'set',key:'x',expected:'old',value:'new'},...(comment?[{kind:'comment',action:'add',from:source.indexOf('Body'),to:source.length,expected:'Body',text:'Synthetic comment'}]:[])];
        for(const [index,patch]of [
          {from:source.indexOf('good'),to:source.indexOf('good')+4,expected:'good',insert:'['},
          {from:source.indexOf('y:'),to:source.indexOf('y:')+1,expected:'y',insert:'x'},
          {from:source.indexOf('x:'),to:source.indexOf('x:')+1,expected:'x',insert:'z'},
        ].entries()) {
          let error;try{await editor.applyMcpBatch({...task,mutation_id:`yaml-${comment}-${index}`,request_id:`yaml-${comment}-${index}`,operations,changes:[patch]});}catch(e){error=e.message;}
          rows.push({error,unchanged:JSON.stringify(editor.mcpSnapshot())===JSON.stringify(before)&&JSON.stringify(editor.historyDepth())===JSON.stringify(history)});
        }
        await editor.applyMcpBatch({...task,mutation_id:`yaml-valid-${comment}`,request_id:`yaml-valid-${comment}`,operations,changes:[{from:source.indexOf('good'),to:source.indexOf('good')+4,expected:'good',insert:'better'}]});
        editor.finishAiTask(task);const after=editor.getValue();editor.undo();rows.push({valid:after.includes('x: "new"\ny: better'),undo:editor.getValue()===source});editor.redo();rows.push({redo:editor.getValue()===after});editor.destroy();parent.remove();
      }return rows;
    });
    for(const row of rows) {
      if('unchanged'in row){assert.match(row.error,/invalid_yaml_result|invalid_property_result/);assert.equal(row.unchanged,true);}
      else if('valid'in row){assert.equal(row.valid,true);assert.equal(row.undo,true);}else assert.equal(row.redo,true);
    }
  });
}finally{await browser.close();}
