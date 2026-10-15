import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium,launchOptions} from './browser-runtime.mjs';

const browser=await chromium.launch(launchOptions);
try {
  const page=await browser.newPage();await page.goto('http://127.0.0.1:41732/');await page.locator('#welcomeNewButton').waitFor();
  await test('mixed raw patches cannot introduce dangling footnotes after structural preflight',async()=>{
    const result=await page.evaluate(async()=>{
      const {createLeafEditor}=await import('/src/editor.js');const {indexFootnotes}=await import('/src/footnotes.js');
      const parent=document.createElement('div');document.body.append(parent);
      const source='Body[^a]\n\n| Head |\n| --- |\n| cell |\n\n[^a]: note\n';
      const editor=createLeafEditor({parent,doc:source});
      const task={task_id:'mixed-refusal',session_id:'session',authorization_epoch:1,scope:{from:0,to:source.length},revision:0};editor.beginAiTask(task);
      const before=editor.mcpSnapshot(),history=editor.historyDepth(),def=indexFootnotes(source).definitions[0];
      let refused=false;try{await editor.applyMcpBatch({...task,mutation_id:'mixed-invalid',request_id:'mixed-invalid',operations:[{kind:'footnote',action:'rename',id:'a',new_id:'b',expected:source.slice(def.lineFrom,def.to)}],changes:[{from:0,to:4,expected:'Body',insert:'Body[^missing]'}]});}catch{refused=true;}
      const unchanged=JSON.stringify(before)===JSON.stringify(editor.mcpSnapshot())&&JSON.stringify(history)===JSON.stringify(editor.historyDepth());
      editor.finishAiTask(task);editor.destroy();parent.remove();return {refused,unchanged};
    });
    assert.equal(result.refused,true,'combined source integrity must be checked after raw and structural union');assert.equal(result.unchanged,true);
  });
  await test('one mixed task renders edited footnotes and GFM tables in editor reading and shared PDF DOM',async()=>{
    const result=await page.evaluate(async()=>{
      const {createLeafEditor}=await import('/src/editor.js');const {indexFootnotes}=await import('/src/footnotes.js');const {analyzeMarkdown}=await import('/src/markdown-model.js');const {renderPrintDocument}=await import('/src/print-document.js');
      const parent=document.createElement('div');parent.style.height='800px';document.body.append(parent);
      const source='---\r\ntitle: "Old"\r\n---\r\n\r\n# Heading\r\n\r\nBody😀é[^a] again[^a]\r\n\r\n| A | B |\r\n| --- | ---: |\r\n| old | `code\\|pipe` |\r\n\r\n[^a]: old note\r\n\r\n[^orphan]: keep\r\n';
      const editor=createLeafEditor({parent,doc:source}),original=editor.mcpSnapshot().content;
      const task={task_id:'mixed-render',session_id:'session',authorization_epoch:1,scope:{from:0,to:original.length},revision:0};editor.beginAiTask(task);
      try {
        const table=analyzeMarkdown(original).blocks.find(b=>b.kind==='table'),def=indexFootnotes(original).definitions.find(d=>d.id==='a'),at=original.indexOf('Heading');
        const operations=[{kind:'property',action:'set',key:'title',expected:'"Old"',value:'New'},
          {kind:'footnote',action:'set-definition',id:'a',expected:original.slice(def.lineFrom,def.to),body:'**Updated😀é**\n\nSecond *paragraph*'},
          {kind:'table',action:'set-cell',from:table.from,to:table.to,expected:table.raw,row:1,column:0,value:'**Cell😀é**'}];
        const receipt=await editor.applyMcpBatch({...task,mutation_id:'mixed-render-1',request_id:'mixed-render-1',operations,changes:[{from:at,to:at+7,expected:'Heading',insert:'Updated heading'}]});
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const current=editor.mcpSnapshot().content,editedTable=analyzeMarkdown(current).blocks.find(b=>b.kind==='table');
        await editor.applyMcpBatch({...task,revision:receipt.applied_revision,mutation_id:'mixed-render-2',request_id:'mixed-render-2',operations:[{kind:'table',action:'insert-row',from:editedTable.from,to:editedTable.to,expected:editedTable.raw,index:2,values:['last','final']}]});
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const after=editor.getValue(),snapshot=editor.mcpSnapshot(),editing={note:parent.querySelector('.leaf-footnote-region')?.textContent,table:parent.querySelector('table')?.textContent,bold:Array.from(parent.querySelectorAll('strong,.cm-strong')).map(n=>n.textContent)};
        const reading=document.createElement('article'),pdf=document.createElement('article');document.body.append(reading,pdf);
        renderPrintDocument(reading,snapshot.content,{properties:true,fallbackTitle:false,expandCallouts:false,sourcePositions:true,annotations:true});
        renderPrintDocument(pdf,snapshot.content,{properties:true,fallbackTitle:false});
        const semantic=node=>({refs:Array.from(node.querySelectorAll('.footnote-ref')).map(n=>n.textContent),notes:node.querySelector('.footnotes')?.textContent??node.textContent,table:Array.from(node.querySelectorAll('table tr')).map(row=>Array.from(row.querySelectorAll('th,td')).map(c=>c.textContent)),bold:Array.from(node.querySelectorAll('strong')).map(n=>n.textContent),italic:Array.from(node.querySelectorAll('em')).map(n=>n.textContent),heading:node.querySelector('h1')?.textContent});
        const rendered={reading:semantic(reading),pdf:semantic(pdf)};reading.remove();pdf.remove();
        editor.finishAiTask(task);editor.undo();const undo=editor.getValue();editor.redo();const redo=editor.getValue();
        return {source,after,snapshot,undo,redo,editing,rendered,receipt};
      }catch(error){return {error:error.message};}finally{editor.destroy();parent.remove();}
    });
    assert.equal(result.error,undefined);assert.equal(result.undo,result.source);assert.equal(result.redo,result.after);assert.equal(result.snapshot.line_ending,'\r\n');
    assert.ok(result.editing.note.includes('Updated😀é')&&result.editing.note.includes('Second paragraph'));
    assert.ok(result.editing.table.includes('Cell😀é')&&result.editing.table.includes('final'));
    for(const render of Object.values(result.rendered)) {
      assert.deepEqual(render.refs,['1','1']);assert.equal(render.heading,'Updated heading');
      assert.deepEqual(render.table,[['A','B'],['Cell😀é','code|pipe'],['last','final']]);
      assert.ok(render.bold.includes('Updated😀é')&&render.bold.includes('Cell😀é'));assert.ok(render.italic.includes('paragraph'));
    }
  });
  await test('mixed failures preserve revision history and source while legal cross-kind references resolve',async()=>{
    const result=await page.evaluate(async()=>{
      const {createLeafEditor}=await import('/src/editor.js');const {analyzeMarkdown}=await import('/src/markdown-model.js');const {indexFootnotes}=await import('/src/footnotes.js');
      const parent=document.createElement('div');document.body.append(parent);const source='Body[^a]\n\n| A |\n| --- |\n| cell |\n\n[^a]: note';
      const editor=createLeafEditor({parent,doc:source}),task={task_id:'mixed-boundaries',session_id:'session',authorization_epoch:1,scope:{from:0,to:source.length},revision:0};editor.beginAiTask(task);
      const table=analyzeMarkdown(source).blocks.find(b=>b.kind==='table'),def=indexFootnotes(source).definitions[0],tableBase={kind:'table',from:table.from,to:table.to,expected:table.raw},note={kind:'footnote',action:'set-definition',id:'a',expected:source.slice(def.lineFrom,def.to),body:'updated'};
      const before=editor.mcpSnapshot(),history=editor.historyDepth(),checks=[];
      const invalid=[{operations:[note,{...tableBase,action:'delete-column',index:0}]},{operations:[note],changes:[{from:def.lineFrom,to:def.to,expected:source.slice(def.lineFrom,def.to),insert:'collision'}]},
        {operations:[{...tableBase,action:'set-cell',row:1,column:0,value:'[^missing]'}]},
        {operations:[note],changes:[{from:source.length,to:source.length,expected:'',insert:'\n\n[^a]: duplicate'}]},
        {operations:[{...tableBase,action:'set-cell',row:1,column:0,value:'valid'}],changes:[{from:table.from,to:table.from,expected:'',insert:'```\n'}]},
        {revision:99,operations:[note]},
        {changes:[{from:0,to:4,expected:'Body',insert:'Body[^missing]'}]},
        {changes:[{from:source.length,to:source.length,expected:'',insert:'\n\n[^a]: duplicate'}]}];
      for(const [i,batch]of invalid.entries()){let refused=false;try{await editor.applyMcpBatch({...task,mutation_id:`invalid-${i}`,request_id:`invalid-${i}`,...batch});}catch{refused=true;}checks.push(refused&&JSON.stringify(editor.mcpSnapshot())===JSON.stringify(before)&&JSON.stringify(editor.historyDepth())===JSON.stringify(history));}
      await editor.applyMcpBatch({...task,mutation_id:'resolved',request_id:'resolved',operations:[{kind:'footnote',action:'add-definition',id:'new',expected:'',body:'resolved'},{...tableBase,action:'set-cell',row:1,column:0,value:'[^new]'}]});
      editor.finishAiTask(task);const after=editor.getValue();editor.undo();const undo=editor.getValue();editor.destroy();parent.remove();return {checks,after,undo,source};
    });
    assert.deepEqual(result.checks,Array(8).fill(true));assert.ok(result.after.includes('| [^new] |')&&result.after.includes('[^new]: resolved'));assert.equal(result.undo,result.source);
  });
}finally{await browser.close();}
