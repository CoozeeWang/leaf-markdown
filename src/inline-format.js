import { parser } from '@lezer/markdown';
import { leafMarkdownExtensions } from './markdown-extensions.js';
import { indexFootnotes } from './footnotes.js';

const markdown = parser.configure(leafMarkdownExtensions);
const formats = {
  italic: ['*', 'Emphasis'], bold: ['**', 'StrongEmphasis'],
  strike: ['~~', 'Strikethrough'], highlight: ['==', 'LeafHighlight'], code: ['`', 'InlineCode'],
};
const literalBlocks = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'LinkReference', 'HorizontalRule', 'Table']);
const structuralMarks = new Set(['HeaderMark', 'QuoteMark', 'ListMark', 'TaskMarker']);

// Matching characters alone aren't enough: **one** and **two** is two
// constructs, not a single removable wrapper.
function wrapper(text, name) {
  let result = null;
  markdown.parse(text).iterate({ enter(node) {
    if (node.name !== name || node.from !== 0 || node.to !== text.length) return;
    const first = node.node.firstChild, last = node.node.lastChild;
    if (first && last && first.from !== last.from) result = { left: first.to, right: last.from };
  } });
  return result;
}

function renders(text, name, from, to) {
  let found = false;
  markdown.parse(text).iterate({ enter(node) {
    if (node.name === name && node.from === from && node.to === to) found = true;
  } });
  return found;
}

function codeWrapper(text) {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const marker = '`'.repeat(longest + 1);
  const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return marker + padding + text + padding + marker;
}

function subtract(ranges, excluded) {
  for (const block of excluded) ranges = ranges.flatMap(range => block.to <= range.from || block.from >= range.to ? [range] : [
    ...(range.from < block.from ? [{ from: range.from, to: block.from }] : []),
    ...(block.to < range.to ? [{ from: block.to, to: range.to }] : []),
  ]);
  return ranges;
}

// Shared by toolbar/keyboard commands on both desktop platforms. Reading rules
// stay unchanged; only explicit formatting edits write to the document.
function planBodyFormat(source, from, to, type, { bodyFrom = 0, protectedRanges = [] } = {}) {
  const format = formats[type];
  if (!format) return null;
  const [marker, name] = format;
  const containers = [], excluded = [...protectedRanges];
  let selectedWrapper = null;
  markdown.parse(source).iterate({ enter(node) {
    if (literalBlocks.has(node.name)) {
      excluded.push({ from: node.from, to: node.to }); return false;
    }
    if (structuralMarks.has(node.name)) excluded.push({ from: node.from, to: node.to });
    if (node.name === name && node.from >= bodyFrom) {
      const first = node.node.firstChild, last = node.node.lastChild;
      if (first && last && from === first.to && to === last.from && from < to) {
        selectedWrapper = { from: node.from, to: node.to, contentFrom: first.to, contentTo: last.from };
      }
    }
    if (node.name === 'Paragraph' || node.name === 'Task' || /^(ATX|Setext)Heading\d$/.test(node.name)) {
      containers.push({ from: node.from, to: node.to });
    }
    const whole = from <= node.from && to >= node.to;
    // Complete inline constructs can be nested. Partial code, destinations,
    // tags and syntax marks must not be damaged by a text-format command.
    if (!whole && ['InlineCode', 'Image', 'Autolink', 'HTMLTag', 'URL', 'LinkMark', 'LinkLabel',
      'EmphasisMark', 'StrikethroughMark', 'LeafHighlightMark'].includes(node.name)) {
      excluded.push({ from: node.from, to: node.to }); return false;
    }
  } });
  // Live preview hides delimiters: selecting the displayed formatted text
  // must also be sufficient to cancel its formatting.
  if (selectedWrapper) {
    const range = selectedWrapper;
    return { changes: [{ from: range.from, to: range.contentFrom, insert: '' },
      { from: range.contentTo, to: range.to, insert: '' }], anchor: range.from + to - from };
  }
  if (from === to) {
    if (from < bodyFrom || excluded.some(range => from >= range.from && from < range.to)) return null;
    return { changes: [{ from, to, insert: marker + marker }], anchor: from + marker.length };
  }
  let ranges = containers.map(range => ({ from: Math.max(from, bodyFrom, range.from), to: Math.min(to, range.to) }))
    .filter(range => range.from < range.to);
  ranges = subtract(ranges, excluded);
  // Separate pairs retain blank lines, CRLF, list/quote prefixes, indentation
  // and hard-break whitespace. Whitespace-only selections remain unchanged.
  const parts = [];
  for (const range of ranges) {
    for (const match of source.slice(range.from, range.to).matchAll(/[^\r\n]+/g)) {
      const text = match[0], leading = text.length - text.trimStart().length;
      const content = text.trim();
      if (!content) continue;
      const start = range.from + match.index + leading;
      parts.push({ from: start, to: start + content.length, text: content, wrapper: wrapper(content, name) });
    }
  }
  if (!parts.length) return null;
  const remove = parts.every(part => part.wrapper), changes = [];
  for (const part of parts) {
    if (remove) {
      const inner = part.text.slice(part.wrapper.left, part.wrapper.right);
      // CommonMark removes one padding space at each end of a code span.
      const text = type === 'code' && inner.startsWith(' ') && inner.endsWith(' ') && /\S/.test(inner)
        ? inner.slice(1, -1) : inner;
      changes.push({ from: part.from, to: part.to, insert: text });
      continue;
    }
    if (part.wrapper) continue;
    const wrapped = type === 'code' ? codeWrapper(part.text) : marker + part.text + marker;
    const lineFrom = source.lastIndexOf('\n', part.from - 1) + 1;
    const nextLine = source.indexOf('\n', part.to), lineTo = nextLine < 0 ? source.length : nextLine;
    const before = source.slice(lineFrom, part.from), after = source.slice(part.to, lineTo);
    // Choose the least extra whitespace by checking a real parsed node. This
    // also catches escaped markers and adjacent runs of the same delimiter.
    for (const [left, right] of [['', ''], ['', ' '], [' ', ''], [' ', ' ']]) {
      if ((left && (!before || /\s$/.test(before))) || (right && (!after || /^\s/.test(after)))) continue;
      const start = before.length + left.length;
      if (!renders(before + left + wrapped + right + after, name, start, start + wrapped.length)) continue;
      changes.push({ from: part.from, to: part.to, insert: left + wrapped + right });
      break;
    }
  }
  if (!changes.length) return null;
  changes.sort((a, b) => a.from - b.from);
  const last = changes.at(-1);
  const delta = changes.slice(0, -1).reduce((sum, change) => sum + change.insert.length - change.to + change.from, 0);
  return { changes, anchor: last.from + delta + last.insert.length };
}

export function planInlineFormat(source, from, to, type, { bodyFrom = 0 } = {}) {
  // Definitions look like URLs/indented code to Lezer. Use Leaf's established
  // footnote index and parse the de-indented body, retaining original offsets.
  const definitions = /^ {0,3}\[\^[^\]\r\n]+\]:/m.test(source)
    ? indexFootnotes(source).definitions.filter(def => def.bodyFrom >= bodyFrom && def.from <= to && def.to >= from) : [];
  const insideNote = from === to && definitions.some(def => from >= def.from && from <= def.to);
  const main = insideNote ? null : planBodyFormat(source, from, to, type, { bodyFrom, protectedRanges: definitions });
  if (!definitions.length) return main;
  const changes = [...(main?.changes ?? [])];
  let emptyAnchor = null;
  for (const def of definitions) {
    const lines = [];
    let original = def.bodyFrom, virtual = 0;
    for (const text of def.body.split('\n')) {
      const indent = def.continuations.find(range => range.from === original);
      const start = indent?.to ?? original;
      lines.push({ original: start, virtual, length: text.length });
      const newline = source.indexOf('\n', start);
      original = newline < 0 ? source.length : newline + 1;
      virtual += text.length + 1;
    }
    const toVirtual = pos => {
      const line = lines.findLast(line => line.original <= pos) ?? lines[0];
      return line.virtual + Math.max(0, Math.min(line.length, pos - line.original));
    };
    const toOriginal = pos => {
      const line = lines.findLast(line => line.virtual <= pos) ?? lines[0];
      return line.original + Math.min(line.length, pos - line.virtual);
    };
    // A marker-only selection does not create empty formatting in the body.
    if (to < def.bodyFrom || (from !== to && toVirtual(from) === toVirtual(to))) continue;
    const plan = planBodyFormat(def.body, toVirtual(from), toVirtual(to), type);
    for (const change of plan?.changes ?? []) {
      const mapped = { from: toOriginal(change.from), to: toOriginal(change.to), insert: change.insert };
      changes.push(mapped);
      if (from === to) emptyAnchor = mapped.from + plan.anchor - change.from;
    }
  }
  if (!changes.length) return null;
  changes.sort((a, b) => a.from - b.from);
  const last = changes.at(-1);
  const delta = changes.slice(0, -1).reduce((sum, change) => sum + change.insert.length - change.to + change.from, 0);
  return { changes, anchor: emptyAnchor ?? last.from + delta + last.insert.length };
}
