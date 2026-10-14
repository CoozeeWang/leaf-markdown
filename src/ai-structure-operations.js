import {isMap,isScalar,isSeq} from 'yaml';
import {propertySourceDocument} from './markdown-model.js';
import {parseMarkdown} from './markdown-parse.js';
import {indexComments} from './comments.js';
import {indexFootnotes} from './footnotes.js';
import {planFootnoteOperations,verifyFootnoteIntegrity} from './ai-footnote-operations.js';
import {planTableOperations,verifyTableOperationsResult} from './ai-table-operations.js';

export function planSourceChanges(source,changes,scope,{keepUnchanged=false}={}) {
  if(typeof source!=='string'||!Array.isArray(changes)||changes.length>256||!scope||!Number.isInteger(scope.from)||!Number.isInteger(scope.to)||scope.from<0||scope.to>source.length||scope.from>scope.to)throw new Error('invalid_batch');
  const boundaries=new Set([0,source.length]);
  for(const item of new Intl.Segmenter('und',{granularity:'grapheme'}).segment(source))boundaries.add(item.index);
  const planned=changes.map(change=>{
    if(!change||typeof change!=='object')throw new Error('invalid_patch');
    const {from,to,insert,expected}=change;
    if(!Number.isInteger(from)||!Number.isInteger(to)||from<scope.from||to>scope.to||from>to||to>source.length||typeof insert!=='string'||typeof expected!=='string'||!boundaries.has(from)||!boundaries.has(to)||source.slice(from,to)!==expected)throw new Error('invalid_patch');
    return {from,to,insert};
  }).sort((a,b)=>a.from-b.from||a.to-b.to);
  for(let i=1;i<planned.length;i++)if(planned[i].from<planned[i-1].to||planned[i].from===planned[i-1].from)throw new Error('overlapping_patches');
  return keepUnchanged?planned:planned.filter(change=>source.slice(change.from,change.to)!==change.insert);
}

function ordinary(node,source,offset) {
  if(!node?.range||node.tag||node.anchor)return false;
  if(isScalar(node))return !String(node.type).startsWith('BLOCK_')&&(node.value===null||['string','number','boolean'].includes(typeof node.value));
  return isSeq(node)&&!node.comment&&!node.commentBefore&&node.items.every(item=>isScalar(item)&&!item.tag&&!item.anchor&&!item.comment&&!item.commentBefore&&!String(item.type).startsWith('BLOCK_')&&typeof item.value==='string')&&source.slice(offset+node.range[0],offset+node.range[1]).trim().length>0;
}
function valueSource(value) {
  if(value===null||typeof value==='boolean'||typeof value==='string'||typeof value==='number'&&Number.isFinite(value)||Array.isArray(value)&&value.every(item=>typeof item==='string'))return JSON.stringify(value);
  throw new Error('unsupported_property_value');
}
function resultingSource(source,changes) {
  let result=source;
  for(const change of [...changes].reverse())result=result.slice(0,change.from)+change.insert+result.slice(change.to);
  return result;
}

const protectedNodes=new Set(['Image','Link','InlineCode','FencedCode','CodeBlock','Table','LeafHighlight','CriticRange','CriticComment','CriticRevision','ObsidianComment']);
function syntaxFootprint(source) {
  const yaml=propertySourceDocument(source),ranges=[],start=yaml?yaml.closing+3:0;
  // Leaf's live parser consumes LF buffer coordinates. Map its syntax ranges
  // back to raw source when a pure planner is called with a CRLF document.
  let normalized='';const offsets=[];
  for(let i=0;i<source.length;i++){if(source[i]==='\r'&&source[i+1]==='\n')continue;offsets.push(i);normalized+=source[i];}
  offsets.push(source.length);
  parseMarkdown(normalized).iterate({enter(node){
    const from=offsets[node.from],to=offsets[node.to];
    if(from>=start&&(node.node.parent?.name==='Document'||protectedNodes.has(node.name)))ranges.push({name:node.name,from,to});
  }});
  for(const note of indexComments(source).hidden)ranges.push({name:'HiddenComment',from:note.from,to:note.to});
  for(const definition of indexFootnotes(source).definitions)ranges.push({name:'FootnoteDefinition',from:definition.from,to:definition.to});
  return ranges;
}
function touches(change,range) {
  return change.from===change.to?change.from>=range.from&&change.from<=range.to:change.from<range.to&&change.to>range.from;
}
export function verifyMarkdownPreservation(source,changes) {
  changes=changes.filter(change=>source.slice(change.from,change.to)!==change.insert);
  if(!changes.length)return;
  const after=resultingSource(source,changes),old=syntaxFootprint(source),current=new Set(syntaxFootprint(after).map(node=>`${node.name}:${node.from}:${node.to}`));
  for(const range of old) {
    if(changes.some(change=>touches(change,range)))continue;
    const shift=changes.filter(change=>change.to<=range.from).reduce((n,c)=>n+c.insert.length-(c.to-c.from),0);
    const from=range.from+shift,to=range.to+shift;
    if(!current.has(`${range.name}:${from}:${to}`)||source.slice(range.from,range.to)!==after.slice(from,to))throw new Error('markdown_structure_outside_range');
  }
}

export function planMarkdownRangeOperations(source,operations,scope={from:0,to:source.length},options={}) {
  if(!Array.isArray(operations)||!operations.length||operations.length>256)throw new Error('invalid_operations');
  const planned=planSourceChanges(source,operations,scope,options),yaml=propertySourceDocument(source);
  if(yaml&&planned.some(change=>change.from<yaml.closing+3))throw new Error('markdown_property_range');
  verifyMarkdownPreservation(source,planned);
  return planned;
}

export function planPropertyOperations(source,operations,scope={from:0,to:source.length},options={}) {
  if(!Array.isArray(operations)||!operations.length||operations.length>256)throw new Error('invalid_operations');
  const block=propertySourceDocument(source),seen=new Set(),changes=[];
  if(!block&&/^(?:\uFEFF)?---\r?\n/.test(source))throw new Error('invalid_yaml');
  if(block&&(block.parsed.errors.length||block.parsed.contents&&!isMap(block.parsed.contents)))throw new Error('invalid_yaml');
  if(block?.parsed.contents?.flow)throw new Error('unsupported_property_structure');
  const newline=source.includes('\r\n')?'\r\n':'\n';
  for(const operation of operations) {
    if(!operation||!['add','set','delete'].includes(operation.action)||typeof operation.key!=='string'||!operation.key.length||typeof operation.expected!=='string')throw new Error('invalid_property_operation');
    if(seen.has(operation.key))throw new Error('conflicting_property_operations');seen.add(operation.key);
    const pair=block?.parsed.contents?.items.find(item=>isScalar(item.key)&&item.key.value===operation.key);
    if(operation.action==='add') {
      if(pair)throw new Error('property_exists');
      if(operation.expected!=='')throw new Error('invalid_patch');
      const field=`${JSON.stringify(operation.key)}: ${valueSource(operation.value)}${newline}`;
      changes.push(block?{from:block.closing,to:block.closing,expected:'',insert:field}:{from:0,to:0,expected:'',insert:`---${newline}${field}---${newline}${source?newline:''}`});
      continue;
    }
    if(!pair)throw new Error('property_missing');
    if(!ordinary(pair.value,source,block.offset)||!isScalar(pair.key)||pair.key.tag||pair.key.anchor)throw new Error('unsupported_property_structure');
    const from=block.offset+pair.value.range[0],to=block.offset+pair.value.range[1];
    if(source.slice(from,to)!==operation.expected)throw new Error('invalid_patch');
    if(operation.action==='set') {
      const suffix=operation.expected.endsWith('\n')?newline:'';
      changes.push({from,to,expected:operation.expected,insert:(source[from-1]===':'?' ':'')+valueSource(operation.value)+suffix});
    }
    else {
      const keyFrom=block.offset+pair.key.range[0],lineFrom=source.lastIndexOf('\n',keyFrom-1)+1;
      if(source.slice(lineFrom,keyFrom).trim())throw new Error('unsupported_property_structure');
      const nextNewline=source.indexOf('\n',to),lineTo=source[to-1]==='\n'?to:nextNewline<0?to:nextNewline+1;
      // Preserve the field's inline comment as an independent original comment.
      const trailing=source.slice(to,lineTo),comment=trailing.indexOf('#');
      const insert=comment<0?'':trailing.slice(comment);
      changes.push({from:lineFrom,to:lineTo,expected:source.slice(lineFrom,lineTo),insert});
    }
  }
  const planned=planSourceChanges(source,changes,scope,options),after=resultingSource(source,planned),result=propertySourceDocument(after);
  if(!result||result.parsed.errors.length||result.parsed.contents&&!isMap(result.parsed.contents))throw new Error('invalid_yaml_result');
  return planned;
}

// Plan every operation against the same unmodified buffer. No dispatch occurs
// until the union of ordinary patches and structural operations is validated.
export function planStructureOperations(source,operations,scope,options={}) {
  if(!Array.isArray(operations)||!operations.length||operations.length>256)throw new Error('invalid_operations');
  if(operations.some(operation=>!['property','markdown','footnote','table'].includes(operation?.kind)))throw new Error('unknown_operation');
  const properties=operations.filter(operation=>operation.kind==='property'),markdown=operations.filter(operation=>operation.kind==='markdown'),footnotes=operations.filter(operation=>operation.kind==='footnote');
  const tables=operations.filter(operation=>operation.kind==='table');
  const planned=planSourceChanges(source,[...(properties.length?planPropertyOperations(source,properties,scope,{keepUnchanged:true}):[]),...(markdown.length?planMarkdownRangeOperations(source,markdown,scope,{keepUnchanged:true}):[]),...(footnotes.length?planFootnoteOperations(source,footnotes,scope,{keepUnchanged:true}):[]),...(tables.length?planTableOperations(source,tables,scope,{keepUnchanged:true}):[])].map(change=>({...change,expected:source.slice(change.from,change.to)})),scope,options);
  verifyMarkdownPreservation(source,planned);
  verifyFootnoteIntegrity(source,resultingSource(source,planned));
  verifyTableOperationsResult(source,planned,operations);
  return planned;
}
