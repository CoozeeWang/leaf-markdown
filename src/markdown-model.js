import { parser } from '@lezer/markdown';
import { leafMarkdownExtensions } from './markdown-extensions.js';
import { parseDocument, isMap, isScalar, isSeq } from 'yaml';
import { parseCallout } from './callout.js';

const mdParser = parser.configure(leafMarkdownExtensions);

export function frontmatter(source) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?=\r?\n|$)/.exec(source);
  if (!match) return null;
  const offset = match[0].indexOf('\n') + 1;
  const parsed = parseDocument(match[1], { keepSourceTokens: true, uniqueKeys: true });
  // Two Markdown rules do not by themselves make a property block. In
  // particular, an accidental opening rule must not hide prose/code until the
  // next rule. Keep malformed mappings editable as YAML, but require a mapping
  // (or a mapping-looking first non-comment line) rather than arbitrary text.
  const firstContent = match[1].split(/\r?\n/).find(line => line.trim() && !/^\s*#/.test(line))?.trim() ?? '';
  const mappingStart = /^(?:[^\s:#][^\n]*?:(?:\s|$)|\{)/.test(firstContent);
  if (firstContent && !(isMap(parsed.contents) && !parsed.errors.length) && !mappingStart) return null;
  const fields = [];
  if (!parsed.errors.length && isMap(parsed.contents)) {
    for (const item of parsed.contents.items) {
      const scalar = isScalar(item.value) && item.value.range && !item.value.tag && !item.value.anchor;
      const list = isSeq(item.value) && item.value.range && !item.value.tag && !item.value.anchor
        && !item.value.comment && !item.value.commentBefore && item.value.items.every(v => isScalar(v) && typeof v.value === 'string'
          && !v.tag && !v.anchor && !v.comment && !v.commentBefore && !String(v.type).startsWith('BLOCK_'));
      const editable = isScalar(item.key) && typeof item.key.value === 'string' && (list || (scalar && ['string', 'number', 'boolean'].includes(typeof item.value.value)
        && !String(item.value.type).startsWith('BLOCK_')));
      fields.push({ key: String(item.key?.value ?? ''), editable: !!editable,
        keyFrom: item.key?.range ? offset + item.key.range[0] : null,
        keyTo: item.key?.range ? offset + item.key.range[1] : null,
        value: editable ? (list ? item.value.items.map(v => v.value) : item.value.value) : '复杂属性，请使用源码编辑',
        from: scalar || list ? offset + item.value.range[0] : 0,
        to: scalar || list ? offset + item.value.range[1] : 0 });
    }
  }
  return { kind: 'yaml', from: 0, to: match[0].length, fields, valid: !parsed.errors.length && (isMap(parsed.contents) || !firstContent) };
}

export function rowCells(text, offset = 0) {
  const pipes = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '|') continue;
    let slash = i - 1;
    while (slash >= 0 && text[slash] === '\\') slash--;
    if ((i - slash - 1) % 2 === 0) pipes.push(i);
  }
  let starts = [0, ...pipes.map(p => p + 1)], ends = [...pipes, text.length];
  if (pipes.length && !text.slice(0, pipes[0]).trim()) { starts.shift(); ends.shift(); }
  if (pipes.length && !text.slice(pipes.at(-1) + 1).trim()) { starts.pop(); ends.pop(); }
  return starts.map((start, i) => {
    const part = text.slice(start, ends[i]);
    const left = part.length - part.trimStart().length;
    const value = part.trim();
    return { segmentFrom: offset + start, segmentTo: offset + ends[i], from: offset + start + left, to: offset + start + left + value.length,
      raw: value, value: value.replace(/\\\|/g, '|') };
  });
}

export function analyzeMarkdown(source) {
  const yaml = frontmatter(source), blocks = yaml ? [yaml] : [];
  const headings = [];
  let hasH1 = false;
  mdParser.parse(source).iterate({ enter(node) {
    if (yaml && node.from < yaml.to && node.name !== 'Document') return false;
    if (node.name === 'Blockquote') {
      const raw = source.slice(node.from, node.to), callout = parseCallout(raw);
      if (callout) { blocks.push({kind:'callout',from:node.from,to:node.to,raw,...callout}); return false; }
    }
    if (['ATXHeading1', 'SetextHeading1'].includes(node.name)) hasH1 = true;
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
    if (heading) {
      const line = source.slice(node.from, node.to).split('\n')[0];
      const mark = node.name.startsWith('ATX') ? /^#{1,6}[ \t]+/.exec(line)?.[0] ?? '' : '';
      const text = line.slice(mark.length);
      const multi = /^([1-9]\d{0,2}(?:\.[1-9]\d{0,2}){1,5})[.、)]?[ \t]+(?=\S)/.exec(text);
      const single = /^([1-9]\d{0,2})[.、)][ \t]*(?!\d)(?=\S)/.exec(text);
      const candidate = multi ?? single;
      headings.push({ from: node.from, to: node.to, level: Number(heading[1]),
        candidate: candidate ? { parts: candidate[1].split('.'), from: node.from + mark.length, to: node.from + mark.length + candidate[0].length } : null });
    }
    if (node.name !== 'Table') return;
    const raw = source.slice(node.from, node.to);
    let offset = node.from;
    const lines = raw.split('\n').map(text => {
      const row = { from: offset, to: offset + text.length, cells: rowCells(text, offset) };
      offset += text.length + 1;
      return row;
    });
    const columns = lines[0].cells.length;
    blocks.push({ kind: 'table', from: node.from, to: node.to, raw, columns,
      align: lines[1].cells.map(c => c.raw.endsWith(':') ? (c.raw.startsWith(':') ? 'center' : 'right') : 'left'),
      rows: [lines[0], ...lines.slice(2)] });
    return false;
  } });
  const stack = [];
  let roots = 0;
  for (const heading of headings) {
    while (stack.length && stack.at(-1).level >= heading.level) stack.pop();
    const candidate = heading.candidate;
    if (candidate) {
      const parent = stack.at(-1)?.candidate;
      const prefix = candidate.parts.slice(0, -1).join('.');
      const parentMatches = (parent && parent.parts.join('.') === prefix) || headings.some(other => other !== heading && other.candidate?.parts.join('.') === prefix);
      const siblingMatches = headings.some(other => other !== heading
        && other.candidate?.parts.length === candidate.parts.length
        && other.candidate.parts.slice(0, -1).join('.') === prefix
        && other.candidate.parts.at(-1) !== candidate.parts.at(-1));
      // Decimal-looking labels need structural evidence; do not hide a lone “3.14 的意义”.
      if (candidate.parts.length === 1 || parentMatches || siblingMatches) heading.legacyPrefix = candidate;
    }
    const index = stack.length ? ++stack.at(-1).children : ++roots;
    heading.number = [...stack.map(h => h.index), index].join('.') + (stack.length ? '' : '.');
    stack.push({ level: heading.level, index, children: 0, candidate: heading.legacyPrefix });
  }
  return { yaml, blocks, hasH1, headings };
}

export function scalarSource(value, previous) {
  if (typeof previous === 'boolean') return value ? 'true' : 'false';
  if (typeof previous === 'number' && value.trim() && Number.isFinite(Number(value))) return String(Number(value));
  // Quoting edited text prevents accidental YAML type changes; untouched bytes stay intact.
  return JSON.stringify(String(value));
}

export function titleInsertion(source, filename) {
  const yaml = frontmatter(source);
  const from = yaml?.to ?? 0;
  const title = filename.replace(/\.(md|markdown|mdown)$/i, '').replace(/[\r\n]/g, ' ');
  return { from, insert: `${from ? '\n\n' : ''}# ${title.replace(/([\\`*_[\]<>#])/g, '\\$1')}\n\n` };
}

export function propertyRemovalChange(source, index) {
  const block=frontmatter(source), field=block?.fields[index];
  if(!field || !block.valid)return null;
  if(block.fields.length===1){
    const blanks=/^(?:[ \t]*\r?\n)+/.exec(source.slice(block.to))?.[0].length ?? 0;
    return {from:0,to:block.to+blanks,insert:''};
  }
  const raw=source.slice(0,block.to),offset=raw.indexOf('\n')+1;
  const closing=raw.lastIndexOf('\n');
  const parsed=parseDocument(raw.slice(offset,closing),{keepSourceTokens:true});
  parsed.delete(field.key);
  const newline=raw.includes('\r\n')?'\r\n':'\n';
  return {from:offset,to:closing+1,insert:parsed.toString().replace(/\r?\n/g,newline)};
}
