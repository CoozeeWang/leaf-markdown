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
}finally{await browser.close();}
