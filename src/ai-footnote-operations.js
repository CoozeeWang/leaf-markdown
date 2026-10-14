import {indexFootnotes,footnoteDefinitionText,appendDefinition,planFootnoteDeletion,planFootnoteRenumbering} from './footnotes.js';
import {planSourceChanges} from './ai-structure-operations.js';

const apply=(source,changes)=>[...changes].reverse().reduce((text,c)=>text.slice(0,c.from)+c.insert+text.slice(c.to),source);
const validLabel=id=>typeof id==='string'&&id.length>0&&!/[\[\]\r\n]/.test(id);

// Existing defects are retained; no batch may add a missing reference or an
// extra duplicate definition, including through ordinary source patches.
export function verifyFootnoteIntegrity(before,after) {
  const defects=source=>{
    const index=indexFootnotes(source),counts=new Map();
    for(const note of index.notes)if(!note.def)counts.set(`missing:${note.id}`,note.refs.length);
    for(const warning of index.warnings){const key=`duplicate:${warning.id}`;counts.set(key,(counts.get(key)||0)+1);}
    return counts;
  };
  const old=defects(before);
  for(const [id,count]of defects(after))if(count>(old.get(id)||0))throw new Error('footnote_integrity');
}

export function planFootnoteOperations(source,operations,scope={from:0,to:source.length},options={}) {
  if(!Array.isArray(operations)||!operations.length||operations.length>256)throw new Error('invalid_operations');
  const index=indexFootnotes(source),changes=[],eol=source.includes('\r\n')?'\r\n':'\n';
  const change=(from,to,insert)=>{
    // The shared scanner's line end is before LF. Include the whole CRLF
    // grapheme when replacing a definition ending at that boundary.
    if(from<to&&source[to-1]==='\r'&&source[to]==='\n'){to++;if(insert)insert=insert.replace(/\r$/,'')+'\r\n';}
    changes.push({from,to,insert,expected:source.slice(from,to)});
  };
  for(const op of operations) {
    if(op?.action==='renumber') {
      const result=planFootnoteRenumbering(source,{includeNamed:op.include_named===true});
      if(result.blocked)throw new Error('footnote_renumber_conflict');
      for(const c of result.changes)change(c.from,c.to,c.insert);
      continue;
    }
    if(!op||!validLabel(op.id)||typeof op.expected!=='string')throw new Error('invalid_footnote_operation');
    const note=index.notes.find(n=>n.id===op.id),defs=index.definitions.filter(d=>d.id===op.id),def=note?.def;
    const expectDef=()=>{if(!def||defs.length!==1)throw new Error('footnote_definition_missing_or_duplicate');if(source.slice(def.lineFrom,def.to)!==op.expected)throw new Error('invalid_patch');};
    const body=()=>{if(typeof op.body!=='string')throw new Error('invalid_footnote_body');return op.body.replace(/\r\n/g,'\n');};
    if(op.action==='add'||op.action==='add-reference') {
      if(!Number.isInteger(op.from)||!Number.isInteger(op.to)||source.slice(op.from,op.to)!==op.expected)throw new Error('invalid_patch');
      if(op.action==='add'&&note)throw new Error('footnote_exists');
      if(op.action==='add-reference'&&(!def||defs.length!==1))throw new Error('footnote_definition_missing_or_duplicate');
      change(op.from,op.to,`[^${op.id}]`);
      if(op.action==='add')for(const c of appendDefinition(source,op.id,body()))change(c.from,c.to,c.insert.replace(/\r?\n/g,eol));
    }else if(op.action==='set-definition') {
      expectDef();change(def.lineFrom,def.to,footnoteDefinitionText(op.id,body()).replace(/\n/g,eol)+(source.slice(def.lineFrom,def.to).endsWith('\r')?'\r':''));
    }else if(op.action==='add-definition') {
      if(def||op.expected!=='')throw new Error('footnote_exists');
      for(const c of appendDefinition(source,op.id,body()))change(c.from,c.to,c.insert.replace(/\r?\n/g,eol));
    }else if(op.action==='delete'||op.action==='delete-definition') {
      expectDef();
      for(const c of op.action==='delete'?planFootnoteDeletion(source,op.id):[{from:def.lineFrom,to:def.to,insert:''}])change(c.from,c.to,c.insert);
    }else if(op.action==='delete-reference') {
      const ref=note?.refs.find(r=>r.from===op.from&&r.to===op.to);
      if(!ref||source.slice(ref.from,ref.to)!==op.expected)throw new Error('invalid_patch');
      change(ref.from,ref.to,'');
    }else if(op.action==='rename') {
      expectDef();if(!validLabel(op.new_id)||op.new_id!==op.id&&index.notes.some(n=>n.id===op.new_id))throw new Error('footnote_label_conflict');
      for(const ref of note.refs)change(ref.from+2,ref.to-1,op.new_id);
      change(def.markerFrom+2,def.markerTo-2,op.new_id);
    }else throw new Error('invalid_footnote_operation');
  }
  const planned=planSourceChanges(source,changes,scope,options);
  verifyFootnoteIntegrity(source,apply(source,planned));
  return planned;
}
