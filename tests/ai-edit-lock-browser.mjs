import assert from 'node:assert/strict';
import {chromium, launchOptions} from './browser-runtime.mjs';

const browser=await chromium.launch(launchOptions);
try {
  const page=await browser.newPage();
  await page.goto('http://127.0.0.1:41732/');
  await page.locator('#welcomeNewButton').waitFor();
  const results=await page.evaluate(async()=>{
    const {createLeafEditor,createLeafNoteEditor}=await import('/src/editor.js');
    const parent=document.createElement('div');document.body.append(parent);
    const otherParent=document.createElement('div');document.body.append(otherParent);
    const source='---\ntitle: Synthetic\n---\n\n# Heading\n\nBody[^1] {==quote==}{>>note<<}\n\n| A | B |\n| --- | --- |\n| one | two |\n\n[^1]: Footnote\n';
    const editor=createLeafEditor({parent,doc:source});
    const other=createLeafEditor({parent:otherParent,doc:'Other document'});
    const task={task_id:'synthetic-task',session_id:'synthetic-session',document_id:'synthetic-document',authorization_epoch:1,scope:{from:0,to:editor.view.state.doc.length},revision:0,client:'claude-desktop'};
    const rows=[];
    const check=(name,run)=>{try{run();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.message});}};
    const ensure=(value,message)=>{if(!value)throw new Error(message);};
    const start=editor.mcpSnapshot();editor.beginAiTask(task);
    check('locked native content has read-only semantics',()=>ensure(editor.view.contentDOM.getAttribute('aria-readonly')==='true','main content must expose aria-readonly'));
    const entrances={
      typing:()=>editor.view.dispatch({changes:{from:30,insert:'typed'},userEvent:'input.type'}),
      paste:()=>editor.view.dispatch({changes:{from:30,insert:'paste'},userEvent:'input.paste'}),
      cut:()=>editor.view.dispatch({changes:{from:30,to:34},userEvent:'delete.cut'}),
      drop:()=>editor.view.dispatch({changes:{from:30,insert:'drop'},userEvent:'input.drop'}),
      'filter false / late restore':()=>editor.restoreValue('late recovery'),
      properties:()=>editor.createProperties(),
      formatting:()=>editor.format('bold'),
      footnote:()=>editor.setFootnoteBody('1','changed'),
      'footnote delete':()=>editor.deleteFootnote('1'),
      comments:()=>editor.setCommentBody(editor.comments().notes[0].id,'changed'),
      'comment delete':()=>editor.deleteComment(editor.comments().notes[0].id),
      undo:()=>editor.undo(),redo:()=>editor.redo(),
      'spoofed AI event':()=>editor.view.dispatch({changes:{from:30,insert:'spoof'},filter:false,userEvent:'input.type.ai'}),
    };
    for(const [name,run]of Object.entries(entrances))check(name,()=>{run();ensure(editor.getValue()===source,'locked content changed');ensure(editor.mcpSnapshot().revision===start.revision,'rejected write advanced revision');});
    check('table and property controls really read-only',()=>{for(const input of parent.querySelectorAll('.leaf-table textarea,.leaf-property-body input'))ensure(input.readOnly||input.disabled,'structure input still editable');});
    const noteParent=document.createElement('div');parent.append(noteParent);
    const note=createLeafNoteEditor({parent:noteParent,doc:'Footnote',label:'Synthetic note',mutationAllowed:()=>editor.mutationAllowed(),onChange:value=>editor.setFootnoteBody('1',value),onUndo:()=>editor.undo(),onRedo:()=>editor.redo(),onLeave:()=>{}});
    check('nested note cannot bypass filter',()=>{note.view.dispatch({changes:{from:0,insert:'bad'},filter:false});ensure(note.value()==='Footnote','nested draft changed behind lock');});
    check('independent document stays editable',()=>{other.restoreValue('Other edited');ensure(other.getValue()==='Other edited','other document blocked');});
    check('selection and view remain available',()=>{editor.view.dispatch({selection:{anchor:35}});editor.setSource(true);editor.setSource(false);editor.setReading(true);editor.setReading(false);ensure(editor.getValue()===source,'view mutated content');});
    await editor.applyMcpBatch({...task,mutation_id:'synthetic-mutation',request_id:'synthetic-request',changes:[{from:35,to:35,expected:'',insert:'AI'}]});
    check('current capability writes',()=>ensure(editor.getValue().includes('AI'),'AI batch blocked'));
    editor.finishAiTask(task);editor.finishAiTask(task);
    check('repeat unlock is benign and human edit resumes',()=>{editor.restoreValue('Human resumed');ensure(editor.getValue()==='Human resumed','unlock failed');});
    await editor.applyMcpBatch({...task,mutation_id:'late-mutation',request_id:'late-request',revision:editor.mcpSnapshot().revision,changes:[]}).then(()=>rows.push({name:'late AI rejected',pass:false,error:'late batch accepted'}),()=>rows.push({name:'late AI rejected',pass:true}));
    check('IME acquisition preserves pending candidate',()=>{editor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'拼'}));let refused=false;try{editor.beginAiTask({...task,task_id:'ime-task'});}catch(e){refused=e.message==='composition_pending';}ensure(refused,'must refuse lock until composition ends');editor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'拼'}));});
    const draftParent=document.createElement('div');document.body.append(draftParent);const draftEditor=createLeafEditor({parent:draftParent,doc:source});
    await new Promise(requestAnimationFrame);
    check('unsubmitted property draft prevents acquisition and survives',()=>{const input=draftParent.querySelector('.leaf-property-row input:not([type=checkbox])');ensure(input,'property control missing');input.focus();const before=input.value;input.value=before+' draft';input.dispatchEvent(new InputEvent('input',{bubbles:true}));let refused=false;try{draftEditor.beginAiTask({...task,task_id:'draft-task'});}catch(e){refused=e.message==='structural_draft_pending';}ensure(refused,'must refuse lock with structural draft');ensure(input.value===before+' draft'&&draftEditor.aiTask()===null,'draft was dropped or lock leaked');});
    return rows;
  });
  console.log('TAP version 13');
  results.forEach((row,i)=>{console.log(`# Subtest: ${row.name}\n${row.pass?'ok':'not ok'} ${i+1} - ${row.name}`);if(row.error)console.log(`# ${row.error}`);});
  console.log(`1..${results.length}\n# tests ${results.length}\n# pass ${results.filter(r=>r.pass).length}\n# fail ${results.filter(r=>!r.pass).length}`);
  assert.equal(results.filter(r=>!r.pass).length,0,'AI mutation gate matrix must pass');
}finally{await browser.close();}
