import {indexComments,commentQuote,planCommentInsertion,planCommentBody,planCommentDeletion} from './comments.js';
import {planSourceChanges,planStructureOperations,verifyStructureResult} from './ai-structure-operations.js';

function binding(source,context) {
  if(typeof source!=='string'||!context?.session_id||!context.document_id||!Number.isInteger(context.revision)||!Number.isInteger(context.authorization_epoch)||!context.source_fingerprint||!context.scope||!Number.isInteger(context.scope.from)||!Number.isInteger(context.scope.to)||context.scope.from<0||context.scope.to>source.length||context.scope.from>context.scope.to)throw new Error('invalid_comment_context');
  return {document_id:context.document_id,session_id:context.session_id,revision:context.revision,authorization_epoch:context.authorization_epoch,source_fingerprint:context.source_fingerprint,coordinate_encoding:'utf-16'};
}

export function listAiComments(source,context) {
  const fixed=binding(source,context);
  const comments=indexComments(source).notes.filter(note=>(note.range?.from??note.from)>=context.scope.from&&note.to<=context.scope.to).map(note=>{
    const from=note.range?.from??note.from,to=note.to;
    const id=JSON.stringify([fixed.document_id,fixed.session_id,fixed.authorization_epoch,fixed.revision,fixed.source_fingerprint,note.kind,from,to]);
    return {id,kind:note.kind,from,to,text:note.text,quote:commentQuote(note.quote),source:source.slice(from,to),source_fingerprint:fixed.source_fingerprint,anchor:note.range?{from:note.range.bodyFrom,to:note.range.bodyTo}:{from:note.from,to:note.kind==='hidden'?note.to:note.from}};
  });
  return {...fixed,comments};
}
export function readAiComment(source,context,id) {
  const {comments,...fixed}=listAiComments(source,context);
  return {...fixed,comment:comments.find(note=>note.id===id)??null};
}
export function locateAiComment(source,context,id) {
  const result=readAiComment(source,context,id);
  return {...result,range:result.comment?.anchor??null};
}

export function planAiCommentOperation(source,operation,context) {
  binding(source,context);
  const add=operation?.action==='add';
  const allowed=add?['kind','action','from','to','expected','text']:['kind','action','id','source_fingerprint','expected',...(operation?.action==='set'?['text']:[])];
  if(operation?.kind!=='comment'||!['add','set','delete'].includes(operation.action)||Object.keys(operation).some(key=>!allowed.includes(key))||typeof operation.expected!=='string')throw new Error('invalid_comment_operation');
  let changes;
  if(add) {
    if(typeof operation.text!=='string'||operation.text.includes('<<}'))throw new Error('invalid_comment_text');
    // Validate coordinates/source/graphemes before invoking the existing UI planner.
    planSourceChanges(source,[{from:operation.from,to:operation.to,expected:operation.expected,insert:''}],context.scope,{keepUnchanged:true});
    const planned=planCommentInsertion(source,operation.from,operation.to);
    if(planned.error)throw new Error(`comment_${planned.error}`);
    const insert=planned.change.insert.slice(0,-6)+`{>>${operation.text}<<}`;
    const note=indexComments(insert).notes[0];
    if(!note||note.text!==operation.text||note.to!==insert.length)throw new Error('invalid_comment_text');
    changes=[{...planned.change,insert}];
  } else {
    if(operation.source_fingerprint!==context.source_fingerprint)throw new Error('stale_comment_source');
    const descriptor=readAiComment(source,context,operation.id).comment;
    if(!descriptor)throw new Error('comment_missing');
    if(descriptor.source!==operation.expected)throw new Error('stale_comment_source');
    const note=indexComments(source).notes.find(n=>n.from===(descriptor.kind==='range'?descriptor.anchor.to+3:descriptor.from)&&n.kind===descriptor.kind);
    if(!note)throw new Error('comment_missing');
    if(operation.action==='delete')changes=planCommentDeletion(source,note);
    else {
      if(typeof operation.text!=='string')throw new Error('invalid_comment_text');
      const change=planCommentBody(source,note,operation.text);
      if(!change)throw new Error('invalid_comment_text');
      const after=source.slice(0,change.from)+change.insert+source.slice(change.to);
      const updated=indexComments(after).notes.find(n=>n.from===note.from&&n.kind===note.kind);
      if(!updated||updated.text!==operation.text)throw new Error('invalid_comment_text');
      changes=[change];
    }
  }
  return planSourceChanges(source,changes.map(change=>({...change,expected:source.slice(change.from,change.to)})),context.scope,{keepUnchanged:true});
}

// All comments, raw patches and existing structures use the original snapshot.
export function planMcpCommentBatch(source,batch,context) {
  const operations=batch.operations;
  if(!Array.isArray(operations)||!operations.length||operations.length>256)throw new Error('invalid_operations');
  if(source.length>4*1024*1024||JSON.stringify(operations).length>4*1024*1024)throw new Error('structure_resource_limit');
  const comments=operations.filter(operation=>operation?.kind==='comment'),structures=operations.filter(operation=>operation?.kind!=='comment');
  const planned=planSourceChanges(source,[...(batch.changes??[]),...comments.flatMap(operation=>planAiCommentOperation(source,operation,context)).map(c=>({...c,expected:source.slice(c.from,c.to)})),...(structures.length?planStructureOperations(source,structures,context.scope,{keepUnchanged:true,deferIntegrity:true}).map(c=>({...c,expected:source.slice(c.from,c.to)})):[])],context.scope);
  verifyStructureResult(source,planned,structures);
  return planned;
}
