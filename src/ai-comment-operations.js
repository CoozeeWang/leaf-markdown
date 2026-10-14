import {indexComments,commentQuote} from './comments.js';

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
