import {parseMarkdown} from './markdown-parse.js';
import {frontmatter} from './markdown-model.js';

// Only document-level headings delimit sections. Headings inside lists,
// quotes, comments, fences and properties must never split a document move.
export function parseOutline(source) {
  const yaml = frontmatter(source), result = [], stack = [];
  let offset = 0, line = 1;
  // Lezer 1.7 accepts a space but misses CommonMark's tab separator after #.
  // Normalize only that one character without shifting any source coordinates;
  // the parser still decides whether the line is code, a quote, or a heading.
  const parsedSource = source.replace(/^( {0,3}#{1,6})\t/gm, '$1 ');
  for (let node = parseMarkdown(parsedSource).topNode.firstChild; node; node = node.nextSibling) {
    const match = /^(ATX|Setext)Heading([1-6])$/.exec(node.name);
    if (!match || (yaml && node.from < yaml.to)) continue;
    while (offset < node.from) if (source[offset++] === '\n') line++;
    const level = Number(match[2]);
    const from = source.lastIndexOf('\n', node.from-1)+1;
    while (stack.length && stack.at(-1).level >= level) stack.pop().end = from;
    let text = source.slice(node.from, node.to);
    if (match[1] === 'ATX') text = text.replace(/^#{1,6}(?:[ \t]+|$)/, '').replace(/[ \t]+#+[ \t]*$/, '');
    else text = text.replace(/\r?\n[^\n]*$/, '').replace(/\r?\n/g, ' ');
    const item = {from, to:node.to, end:source.length, level, line,
      text:text.trim(), parent:stack.at(-1)?.from ?? null};
    result.push(item); stack.push(item);
  }
  return result;
}

// Compatibility for editor callers that still specify a sibling and a side.
// Both APIs use the same validated source transformation.
export function planSectionMove(source,from,targetFrom,side,headings=parseOutline(source)) {
  const item=headings.find(h=>h.from===from),target=headings.find(h=>h.from===targetFrom);
  if(!item||!target||item===target||item.level!==target.level||item.parent!==target.parent||!['before','after'].includes(side))return null;
  return planOutlineMove(source,from,side==='before'?target.from:target.end===source.length?null:target.end,item.level,headings);
}

// A move is a source boundary plus a depth, not a visual row reparenting.
// Validate the reparsed document before exposing a candidate to the UI.
export function planOutlineMove(source, from, before, level, headings = parseOutline(source)) {
  const item=headings.find(h=>h.from===from);
  if(!item||!Number.isInteger(level)||level<1||level>6||headings.some((h,i)=>h.level>(i?headings[i-1].level:0)+1))return null;
  if(before===from)before=item.end===source.length?null:item.end;
  const destination=before===null?source.length:before;
  if(before!==null&&!headings.some(h=>h.from===before))return null;
  if(destination>item.from&&destination<item.end)return null;
  const moving=headings.filter(h=>h.from>=item.from&&h.from<item.end),delta=level-item.level;
  if(moving.some(h=>h.level+delta>6))return null;
  const movingSet=new Set(moving),byFrom=new Map(headings.map(h=>[h.from,h]));
  const rest=headings.filter(h=>!movingSet.has(h));
  const next=rest.find(h=>h.from>=destination),previous=rest.findLast(h=>h.from<destination);
  if(next&&next.level>level||level>1&&(!previous||previous.level<level-1))return null;
  const parent=rest.findLast(h=>h.from<destination&&h.level<level);
  if(level>1&&parent?.level!==level-1)return null;
  const edits=[];
  if(delta)for(const h of moving){
    const raw=source.slice(h.from,h.to),atx=/^ {0,3}(#{1,6})(?=[\t ]|$)/.exec(raw),depth=h.level+delta;
    if(atx){const a=h.from-item.from+atx[0].indexOf('#');edits.push({a,b:a+atx[1].length,text:'#'.repeat(depth)});}
    else {
      const last=raw.lastIndexOf('\n'),underline=raw.slice(last+1),mark=/^( {0,3})([=-]+)([\t ]*\r?)$/.exec(underline);
      if(!mark)return null;
      if(depth<=2){const a=h.from-item.from+last+1+mark[1].length;edits.push({a,b:a+mark[2].length,text:(depth===1?'=':'-').repeat(mark[2].length)});}
      else {
        // A multiline Setext heading has no lossless ATX representation.
        const title=raw.slice(0,last).replace(/\r$/,'');if(title.includes('\n'))return null;
        const lead=/^ {0,3}/.exec(title)[0].length,a=h.from-item.from;
        edits.push({a:a+lead,b:a+lead,text:'#'.repeat(depth)+' '});
        edits.push({a:a+title.length,b:h.to-item.from,text:''});
      }
    }
  }
  const original=source.slice(item.from,item.end);
  let moved=original;for(const e of edits.toReversed())moved=moved.slice(0,e.a)+e.text+moved.slice(e.b);
  const remaining=source.slice(0,item.from)+source.slice(item.end);
  const at=destination>item.from?destination-original.length:destination;
  const eol=source.includes('\r\n')?'\r\n':'\n';
  const prefix=at>0&&!remaining.slice(0,at).endsWith('\n')?eol:'';
  const suffix=at<remaining.length&&!moved.endsWith('\n')?eol:'';
  const inserted=prefix+moved+suffix,result=remaining.slice(0,at)+inserted+remaining.slice(at);
  if(result===source)return null;
  const local=(pos,assoc=1)=>{let shift=0;for(const e of edits){if(pos<e.a||pos===e.a&&assoc<0)break;if(pos<=e.b)return e.a+shift+(assoc<0?0:e.text.length);shift+=e.text.length-(e.b-e.a);}return pos+shift;};
  const mapPosition=(pos,assoc=1)=>{
    if(pos>=item.from&&pos<item.end||pos===item.end&&assoc<0||pos===source.length&&pos===item.end)return at+prefix.length+local(pos-item.from,assoc);
    const removed=pos>=item.end?pos-original.length:pos;
    return removed>=at?removed+inserted.length:removed;
  };
  // Heading starts need left association when inserting an ATX prefix.
  const headingMap=new Map(headings.map(h=>[h.from,movingSet.has(h)?at+prefix.length+local(h.from-item.from,-1):mapPosition(h.from)]));
  const expected=headings.map(h=>({...h,from:headingMap.get(h.from),level:h.level+(movingSet.has(h)?delta:0),old:h.from})).sort((a,b)=>a.from-b.from);
  const actual=parseOutline(result);
  if(actual.length!==expected.length||actual.some((h,i)=>h.from!==expected[i].from||h.level!==expected[i].level||h.text!==expected[i].text))return null;
  for(let i=0;i<actual.length;i++){
    const old=byFrom.get(expected[i].old);
    if(old===item){if(actual[i].parent!==(parent?headingMap.get(parent.from):null))return null;}
    else if(actual[i].parent!==(old.parent===null?null:headingMap.get(old.parent)))return null;
  }
  const changes=at===item.from?[{from:item.from,to:item.end,insert:moved}]:destination<item.from
    ?[{from:destination,insert:inserted},{from:item.from,to:item.end}]
    :[{from:item.from,to:item.end},{from:destination,insert:inserted}];
  const heading=headingMap.get(item.from),prefixLength=/^ {0,3}#{1,6}[ \t]+/.exec(result.slice(heading))?.[0].length??0;
  return {changes,heading,headingContent:heading+prefixLength,range:{from:item.from,to:item.end},parent:parent?.from??null,level,mapPosition};
}
