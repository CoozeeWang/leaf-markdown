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
}finally{await browser.close();}
