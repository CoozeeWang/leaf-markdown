import { parser } from '@lezer/markdown';
import { leafMarkdownExtensions } from './markdown-extensions.js';
import { frontmatter } from './markdown-model.js';
import { indexFootnotes } from './footnotes.js';

const markdown = parser.configure(leafMarkdownExtensions);

// The manual command treats each ordinary source line as an intended paragraph.
// Parsed structures and multiline inline syntax remain byte-for-byte intact.
export function paragraphBlankLineChanges(source) {
  const yaml = frontmatter(source);
  const offset = yaml?.to ?? 0;
  const tree = markdown.parse(source.slice(offset));
  const protectedRanges = yaml ? [yaml] : [];
  for (let block = tree.topNode.firstChild; block; block = block.nextSibling) {
    if (block.name !== 'Paragraph') {
      protectedRanges.push({from: block.from + offset, to: block.to + offset});
    } else {
      for (let inline = block.firstChild; inline; inline = inline.nextSibling) {
        protectedRanges.push({from: inline.from + offset, to: inline.to + offset});
      }
    }
  }
  protectedRanges.push(...indexFootnotes(source).definitions);
  const lines = [];
  for (const match of source.matchAll(/[^\n]+/g)) {
    const text = match[0].replace(/\r$/, '');
    if (text.trim()) lines.push({from: match.index, to: match.index + text.length});
  }
  const changes = [];
  const leading = /^(?:[ \t]*\r?\n)+/.exec(source);
  if (leading) changes.push({from: 0, to: leading[0].length, insert: ''});
  for (let i = 1; i < lines.length; i++) {
    const before = lines[i - 1], after = lines[i];
    if (protectedRanges.some(range => range.from < before.to && range.to > after.from)) continue;
    const gap = source.slice(before.to, after.from);
    const newline = gap.startsWith('\r\n') ? '\r\n' : '\n';
    const insert = newline + newline;
    if (gap !== insert) changes.push({from: before.to, to: after.from, insert});
  }
  return changes;
}
