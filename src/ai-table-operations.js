import {analyzeMarkdown,rowCells} from './markdown-model.js';
import {tableOperation} from './table-operations.js';
import {planSourceChanges} from './ai-structure-operations.js';

// The live GFM parser uses LF coordinates. Pure disk-source callers keep CRLF;
// every parser/cell coordinate is mapped back before an edit is returned.
function tables(source) {
  let normalized='';const offsets=[];
  for(let i=0;i<source.length;i++){if(source[i]==='\r'&&source[i+1]==='\n')continue;offsets.push(i);normalized+=source[i];}
  offsets.push(source.length);
  return analyzeMarkdown(normalized).blocks.filter(b=>b.kind==='table').map(b=>{
    const from=offsets[b.from],end=offsets[b.to],to=source[end-1]==='\r'&&source[end]==='\n'?end-1:end,raw=source.slice(from,to);
    let at=from;
    const lines=raw.split(/\r?\n/).map(line=>{const row={from:at,to:at+line.length,cells:rowCells(line,at)};at+=line.length+(source.slice(at+line.length,at+line.length+2)==='\r\n'?2:1);return row;});
    return {...b,from,to,raw,rows:[lines[0],...lines.slice(2)],separator:lines[1]};
  });
}
function rectangular(block) {
  if(!block||!block.columns||block.rows.some(row=>row.cells.length!==block.columns)||block.separator.cells.length!==block.columns)throw new Error('invalid_table');
}
function cellValue(value) {
  if(typeof value!=='string'||/[\r\n]/.test(value)||rowCells(`| ${value} |`).length!==1)throw new Error('invalid_table_cell');
  return value;
}
const alignment=value=>{if(!['left','center','right'].includes(value))throw new Error('invalid_table_alignment');return value==='right'?'---:':value==='center'?':---:':'---';};

export function planTableOperations(source,operations,scope={from:0,to:source.length},options={}) {
  if(!Array.isArray(operations)||!operations.length||operations.length>256)throw new Error('invalid_operations');
  const blocks=tables(source),changes=[];
  for(const op of operations) {
    const block=blocks.find(b=>b.from===op?.from&&b.to===op?.to);
    rectangular(block);
    if(op.expected!==block.raw)throw new Error('invalid_patch');
    const local=[];
    const replace=(from,to,insert)=>local.push({from,to,insert,expected:source.slice(from,to)});
    const cell=(row,column)=>{
      if(!Number.isInteger(row)||!Number.isInteger(column)||row<0||column<0||row>=block.rows.length||column>=block.columns)throw new Error('invalid_table_index');
      return block.rows[row].cells[column];
    };
    if(op.action==='set-cell') {
      const c=cell(op.row,op.column);replace(c.from,c.to,cellValue(op.value));
    }else if(op.action==='set-header') {
      if(!Array.isArray(op.values)||op.values.length!==block.columns)throw new Error('invalid_table_header');
      op.values.forEach((value,column)=>{const c=cell(0,column);replace(c.from,c.to,cellValue(value));});
    }else if(op.action==='set-alignment') {
      cell(0,op.column);const c=block.separator.cells[op.column];replace(c.from,c.to,alignment(op.alignment));
    }else if(['insert-row','delete-row','insert-column','delete-column'].includes(op.action)) {
      if(!Number.isInteger(op.index))throw new Error('invalid_table_index');
      const row=op.action.endsWith('row'),remove=op.action.startsWith('delete');
      let result=tableOperation(block,row?'row':'col',op.index,remove);
      if(result===null)throw new Error('invalid_table_structure');
      if(!remove) {
        const updated=tables(result)[0];rectangular(updated);
        const values=op.values??Array(row?block.columns:block.rows.length).fill('');
        if(!Array.isArray(values)||values.length!==(row?block.columns:block.rows.length))throw new Error('invalid_table_values');
        const cells=row?updated.rows[op.index].cells:updated.rows.map(r=>r.cells[op.index]);
        const edits=cells.map((c,i)=>({from:c.from,to:c.to,insert:cellValue(values[i])}));
        if(!row){const c=updated.separator.cells[op.index];edits.push({from:c.from,to:c.to,insert:alignment(op.alignment??'left')});}
        for(const c of edits.sort((a,b)=>b.from-a.from))result=result.slice(0,c.from)+c.insert+result.slice(c.to);
      }
      replace(block.from,block.to,result);
    }else throw new Error('invalid_table_operation');
    let after=block.raw;
    for(const c of [...local].sort((a,b)=>b.from-a.from))after=after.slice(0,c.from-block.from)+c.insert+after.slice(c.to-block.from);
    const parsed=tables(after);
    if(parsed.length!==1||parsed[0].from!==0||parsed[0].to!==after.length)throw new Error('invalid_table_result');
    rectangular(parsed[0]);changes.push(...local);
  }
  return planSourceChanges(source,changes,scope,options);
}

export function verifyTableOperationsResult(source,changes,operations=[]) {
  let after=source;
  for(const c of [...changes].reverse())after=after.slice(0,c.from)+c.insert+after.slice(c.to);
  const blocks=tables(after);
  for(const op of operations.filter(op=>op.kind==='table')) {
    const from=op.from+changes.filter(c=>c.to<=op.from&&c.from<op.from).reduce((n,c)=>n+c.insert.length-(c.to-c.from),0);
    rectangular(blocks.find(b=>b.from===from));
  }
}
