import { parser, GFM } from '@lezer/markdown';
import { commentMarkdownExtension, commentToken } from './comment-syntax.js';
import {incrementalParser} from './incremental-parse.js';

const markdown = parser.configure([GFM, commentMarkdownExtension]);
const parse = incrementalParser(markdown);
let recentSource, recentIndex;
export function indexComments(source) {
  if (source === recentSource) return recentIndex;
  const tree = parse(source), tokens = [], protectedRanges = [], paragraphs = [], formats = [], unsafePoints=[];
  const yaml = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?=\r?\n|$)/.exec(source);
  if (yaml) { const first=yaml[0].split(/\r?\n/).slice(1,-1).find(line=>line.trim()&&!/^\s*#/.test(line))?.trim()??''; if(!first||/^(?:[^\s:#][^\n]*?:(?:\s|$)|\{)/.test(first))protectedRanges.push({from:0,to:yaml[0].length}); }
  tree.iterate({enter(node) {
    if (['FencedCode','CodeBlock','InlineCode','HTMLBlock','HTMLComment','URL','LinkReference'].includes(node.name)) {protectedRanges.push({from:node.from,to:node.to,name:node.name});return false;}
    if (['CriticRange','CriticComment','CriticRevision','ObsidianComment'].includes(node.name)) {
      const token = commentToken(source, node.from);
      if (token && token.to === node.to && !protectedRanges.some(r=>r.from<=node.from&&r.to>node.from)) tokens.push(token);
      return false;
    }
    if (node.name === 'Paragraph' && node.node.parent?.name === 'Document') paragraphs.push({from:node.from,to:node.to});
    if (['StrongEmphasis','Emphasis','Strikethrough','Link','Image'].includes(node.name)) formats.push({from:node.from,to:node.to});
    if(['HeaderMark','ListMark','QuoteMark','EmphasisMark','StrikethroughMark','LinkMark','TableDelimiter'].includes(node.name)){
      const extra=['HeaderMark','ListMark','QuoteMark'].includes(node.name)?/^[ \t]+/.exec(source.slice(node.to))?.[0].length??0:0;
      unsafePoints.push({from:node.from,to:node.to+extra});
    }
  }});
  // Obsidian block comments can contain blank lines and Markdown. Scan their
  // closing delimiters before interpreting content, while protecting code/YAML.
  const hidden = [];
  for (let at=source.indexOf('%%');at>=0;at=source.indexOf('%%',at+2)) {
    if (protectedRanges.some(r=>r.from<=at&&r.to>at) || tokens.some(t=>t.name!=='ObsidianComment'&&t.from<=at&&t.to>at)) continue;
    const token=commentToken(source,at);if(!token)continue;
    hidden.push(token);at=token.to-2;
  }
  const all = [...tokens.filter(t=>t.name!=='ObsidianComment'&&!hidden.some(h=>h.from<=t.from&&h.to>=t.to)),...hidden].sort((a,b)=>a.from-b.from);
  const notes=[], ranges=[], revisions=[];
  for (const token of all) {
    if(token.name==='CriticRevision'){revisions.push(token);continue;}
    if(token.name==='CriticRange'){ranges.push(token);continue;}
    const range=token.name==='CriticComment'?ranges.findLast(r=>r.to===token.from):null;
    notes.push({...token,kind:range?'range':token.name==='ObsidianComment'?'hidden':'point',range,
      text:token.body,quote:range?range.body:source.slice(Math.max(source.lastIndexOf('\n',token.from-1)+1,token.from-60),token.from).trim()});
  }
  recentSource=source;recentIndex={notes,ranges,revisions,protectedRanges,paragraphs,formats,hidden,unsafePoints};return recentIndex;
}

export function planCommentInsertion(source, from, to) {
  const index=indexComments(source), selected=source.slice(from,to);
  if(from===to&&(index.unsafePoints.some(r=>from>=r.from&&from<r.to)||index.formats.some(r=>['[','!'].includes(source[r.from])&&from>r.from&&from<r.to)||index.revisions.some(r=>from>=r.from&&from<r.to)))return {error:'position'};
  if(from===to&&index.ranges.some(r=>from>r.from&&from<r.to&&!index.notes.some(n=>n.range?.from===r.from)))return {error:'position'};
  if(index.protectedRanges.some(r=>{
    if(r.name==='URL'&&from!==to&&index.formats.some(f=>f.from<=r.from&&f.to>=r.to&&from<=f.from&&to>=f.to))return false;
    return from<r.to&&to>r.from||from===to&&from>=r.from&&from<r.to;
  }))return {error:from===to?'position':'selection'};
  if(index.notes.some(n=>from===to?from>=(n.range?.from??n.from)&&from<n.to:from<n.to&&to>(n.range?.from??n.from)))return {error:'overlap'};
  if(from!==to){
    if(!selected.trim()||selected.includes('==}')||!index.paragraphs.some(p=>from>=p.from&&to<=p.to)||index.ranges.some(r=>from<r.to&&to>r.from)
      ||index.revisions.some(r=>from<r.to&&to>r.from)||index.formats.some(r=>from<r.to&&to>r.from&&!(from<=r.from&&to>=r.to)))return {error:'selection'};
  }
  const insert=selected?`{==${selected}==}{>><<}`:'{>><<}';
  return {change:{from,to,insert},commentFrom:from+(selected?selected.length+6:0),anchor:from+insert.length};
}
export function planCommentBody(source, note, text) {
  const close=note.kind==='hidden'?'%%':'<<}';
  if(text.includes(close))return null;
  const actual=indexComments(source).notes.find(n=>n.from===note.from&&n.kind===note.kind);
  if(!actual)return null;
  return {from:actual.bodyFrom,to:actual.bodyTo,insert:text};
}
export function planCommentDeletion(source,note) {
  const actual=indexComments(source).notes.find(n=>n.from===note.from&&n.kind===note.kind);
  if(!actual)return [];
  return actual.range?[{from:actual.range.from,to:actual.range.bodyFrom,insert:''},{from:actual.range.bodyTo,to:actual.to,insert:''}]:[{from:actual.from,to:actual.to,insert:''}];
}
export function stripComments(source) {
  const index=indexComments(source),changes=index.notes.map(n=>({from:n.from,to:n.to}));
  for(const range of index.ranges) changes.push({from:range.from,to:range.bodyFrom},{from:range.bodyTo,to:range.to});
  let result=source;for(const change of changes.sort((a,b)=>b.from-a.from))result=result.slice(0,change.from)+result.slice(change.to);
  return result;
}
export function maskHiddenComments(source) {
  if (!source.includes('%%')) return source;
  let result=source;
  for(const note of [...indexComments(source).hidden].reverse())result=result.slice(0,note.from)+source.slice(note.from,note.to).replace(/[^\r\n]/g,' ')+result.slice(note.to);
  return result;
}

// Excerpts are readable text, not another live Markdown/image renderer. Keep
// review suggestions literal, and never load a quoted image just for its alt.
export function commentQuote(quote) {
  const skip=new Set(['HeaderMark','EmphasisMark','StrikethroughMark','LinkMark','CodeMark','CriticMark','URL','CriticComment','ObsidianComment']);
  function visit(node){
    if(skip.has(node.name))return '';
    const raw=quote.slice(node.from,node.to);
    if(node.name==='Image')return raw.slice(2,raw.indexOf(']'));
    if(node.name==='Escape')return raw.slice(1);
    if(!node.firstChild)return raw;
    let out='',at=node.from;
    for(let child=node.firstChild;child;child=child.nextSibling){out+=quote.slice(at,child.from)+visit(child);at=child.to;}
    return out+quote.slice(at,node.to);
  }
  return visit(markdown.parse(quote).topNode).replace(/\s+/g,' ').trim();
}
