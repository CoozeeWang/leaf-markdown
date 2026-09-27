import { parser } from '@lezer/markdown';
import { leafMarkdownExtensions } from './markdown-extensions.js';
import { frontmatter } from './markdown-model.js';
import { indexFootnotes } from './footnotes.js';

const markdown = parser.configure(leafMarkdownExtensions);

// The manual command treats each ordinary source line as an intended paragraph.
// Lists expose only their structural separators; their continuation lines and
// literal blocks stay protected. Positions always refer to the original source.
export function paragraphBlankLineChanges(source) {
  const leading = /^(?:[ \t]*\r?\n)+/.exec(source);
  const start = leading?.[0].length ?? 0;
  const properties = frontmatter(source.slice(start));
  const yaml = properties && {from: start, to: start + properties.to};
  const offset = yaml?.to ?? start;
  const tree = markdown.parse(source.slice(offset));
  const protectedRanges = yaml ? [yaml] : [];
  const listGaps = [];
  const isList = node => node.name === 'BulletList' || node.name === 'OrderedList';
  // Lezer includes the CR in a block's end offset when parsing raw CRLF text.
  const endOf = node => node.to + offset - (source[node.to + offset - 1] === '\r' ? 1 : 0);
  const addGap = (before, after, newlines) => {
    const from = endOf(before), to = after.from + offset;
    if (/^[ \t\r\n]*$/.test(source.slice(from, to))) listGaps.push({from, to, newlines});
  };
  function visitList(list) {
    let previous = null;
    for (let item = list.firstChild; item; item = item.nextSibling) {
      if (item.name !== 'ListItem') continue;
      if (previous) addGap(previous, item, 1);
      previous = item;
      let before = null;
      let marker = null;
      for (let block = item.firstChild; block; block = block.nextSibling) {
        if (block.name === 'ListMark') { marker = block; continue; }
        // A paragraph followed by its child list needs no blank separator.
        // Other item blocks (including two paragraphs) need exactly one.
        if (before) addGap(before, block,
          isList(block) && ['Paragraph', 'Task'].includes(before.name) ? 1 : 2);
        else if (marker && isList(block)) addGap(marker, block, 1);
        if (isList(block)) visitList(block);
        before = block;
      }
    }
  }
  for (let block = tree.topNode.firstChild; block; block = block.nextSibling) {
    if (block.name !== 'Paragraph') {
      protectedRanges.push({from: block.from + offset, to: endOf(block)});
      if (isList(block)) visitList(block);
    } else {
      for (let inline = block.firstChild; inline; inline = inline.nextSibling) {
        protectedRanges.push({from: inline.from + offset, to: inline.to + offset});
      }
    }
  }
  const footnotes = indexFootnotes(source).definitions;
  protectedRanges.push(...footnotes);
  listGaps.sort((a, b) => a.from - b.from);
  const lines = [];
  for (const match of source.matchAll(/[^\n]+/g)) {
    const text = match[0].replace(/\r$/, '');
    if (text.trim()) lines.push({from: match.index, to: match.index + text.length});
  }
  const changes = [];
  if (!lines.length) return source ? [{from: 0, to: source.length, insert: ''}] : [];
  if (leading) changes.push({from: 0, to: leading[0].length, insert: ''});
  let gapIndex = 0;
  for (let i = 1; i < lines.length; i++) {
    const before = lines[i - 1], after = lines[i];
    while (gapIndex < listGaps.length && listGaps[gapIndex].to < after.from) gapIndex++;
    const candidate = listGaps[gapIndex];
    const listGap = candidate?.from <= before.to && candidate.to >= after.from ? candidate : null;
    if (footnotes.some(range => range.from < before.to && range.to > after.from)) continue;
    if (!listGap && protectedRanges.some(range => range.from < before.to && range.to > after.from)) continue;
    const gap = source.slice(before.to, after.from);
    const newline = gap.startsWith('\r\n') ? '\r\n' : '\n';
    const insert = newline.repeat(listGap?.newlines ?? 2);
    if (gap !== insert) changes.push({from: before.to, to: after.from, insert});
  }
  const last = lines.at(-1);
  const tail = source.slice(last.to);
  // One final line ending terminates the content line; further blank rows go.
  // An unclosed literal block may own those rows, in which case keep its bytes.
  const ending = /^(\r?\n)(?:[ \t]*\r?\n)*[ \t]*$/.exec(tail);
  if (ending && tail !== ending[1] && !protectedRanges.some(range => range.to > last.to)) {
    changes.push({from: last.to, to: source.length, insert: ending[1]});
  }
  return changes;
}
