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

export function planSectionMove(source, from, targetFrom, side, headings = parseOutline(source)) {
  const item = headings.find(h => h.from === from), target = headings.find(h => h.from === targetFrom);
  if (!item || !target || item === target || !['before','after'].includes(side)
    || item.level !== target.level || item.parent !== target.parent) return null;
  const destination = side === 'before' ? target.from : target.end;
  if (destination >= item.from && destination <= item.end) return null;
  const start = Math.min(item.from, destination), end = Math.max(item.end, destination);
  const ranges = destination < item.from
    ? [[item.from,item.end],[destination,item.from]]
    : [[item.end,destination],[item.from,item.end]];
  // Preserve every source byte, including blank lines. A final section without
  // a terminator needs one separator when placed before another section.
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const pieces = ranges.map(([a,b]) => ({a,b,text:source.slice(a,b)}));
  const separator = pieces[0].text.endsWith('\n') ? '' : eol;
  const insert = pieces[0].text + separator + pieces[1].text;
  // Separate deletion/insertion keeps CodeMirror history mappings monotonic
  // for selections inside the moved range (a whole-region replacement does not).
  const moved = source.slice(item.from,item.end);
  const changes = destination < item.from
    ? [{from:destination,insert:moved+separator},{from:item.from,to:item.end}]
    : [{from:item.from,to:item.end},{from:destination,insert:separator+moved}];
  const result = source.slice(0,start)+insert+source.slice(end);
  let at = start;
  const mapped = new Map();
  for (const piece of pieces) {
    for (const h of headings) if(h.from>=piece.a && h.from<piece.b) mapped.set(h.from, at+h.from-piece.a);
    at += piece.text.length + (piece === pieces[0] ? separator.length : 0);
  }
  // Moving an unterminated fence / HTML block can swallow the next heading.
  // Validate the actual parser result, including exact heading coordinates.
  const expected = headings.map(h=>({...h,from:mapped.get(h.from) ?? (h.from >= end ? h.from+insert.length-(end-start) : h.from)})).sort((a,b)=>a.from-b.from);
  const actual = parseOutline(result);
  if (actual.length !== expected.length || actual.some((h,i)=>h.from!==expected[i].from || h.level!==expected[i].level || h.text!==expected[i].text)) return null;
  return {changes, heading:mapped.get(item.from), mapPosition(pos, assoc = 1) {
    for (const piece of pieces) if ((pos>=piece.a && pos<piece.b && assoc>=0) || (pos>piece.a && pos<=piece.b && assoc<0) || (pos===source.length && pos===piece.b)) {
      const base = piece === pieces[0] ? start : start+pieces[0].text.length+separator.length;
      return base+Math.min(pos-piece.a,piece.text.length);
    }
    return pos >= end ? pos+insert.length-(end-start) : pos;
  }};
}
