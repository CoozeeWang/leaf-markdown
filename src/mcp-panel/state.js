// One immutable document capability per view. New permissions require a new
// view, so delayed replies can never bind this view to a different document.
export function createReaderState(){
 let current=null,identity=null,closed=false;
 const key=b=>JSON.stringify([b?.document_id,b?.session_id,b?.authorization_epoch]);
 return {accept(value){
  if(closed)return false;
  const b=value?.binding,s=value?.snapshot;
  if(!b?.document_id||!b.session_id||!Number.isSafeInteger(b.authorization_epoch)||!Number.isSafeInteger(s?.revision)||s.revision<0||typeof s.content!=='string'){this.close();throw new Error('invalid_snapshot');}
  if(identity&&key(b)!==identity){this.close();throw new Error('stale_binding');}
  if(current&&s.revision<current.snapshot.revision)return false;
  if(current&&s.revision===current.snapshot.revision&&s.content!==current.snapshot.content){this.close();throw new Error('revision_content_mismatch');}
  identity=key(b);current=value;return true;
 },close(){closed=true;current=null;identity=null;},get current(){return current;}};
}
