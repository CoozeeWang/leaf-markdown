import { parser } from '@lezer/markdown';
import { leafMarkdownExtensions } from './markdown-extensions.js';
import { bodyStart } from './markdown-model.js';

const markdown = parser.configure(leafMarkdownExtensions);

// Only move a parsed image, never a substring that merely resembles one.
export function imageMove(source, range, point) {
  const {from, to} = range;
  if (from < bodyStart(source) || point < bodyStart(source) || point > source.length
    || point >= from && point <= to) return null;
  let image = null, protectedTarget = false;
  markdown.parse(source).iterate({enter(node) {
    if (node.name === 'Image' && node.from === from && node.to === to) image = node.node;
    if (node.from < point && node.to > point && /^(?:Link|Image|InlineCode|FencedCode|CodeBlock|HTMLBlock|LinkReference|Table)$/.test(node.name)) protectedTarget = true;
  }});
  if (!image || protectedTarget) return null;
  // Moving a linked image carries its link with it when it is the whole label.
  const link = image.parent;
  if (link?.name === 'Link' && source.slice(link.from, from) === '['
    && source.slice(to, link.to).startsWith(']')) range = {from:link.from, to:link.to};
  if (point >= range.from && point <= range.to) return null;
  const raw = source.slice(range.from, range.to);
  const lineFrom = source.lastIndexOf('\n', range.from - 1) + 1;
  const next = source.indexOf('\n', range.to);
  const lineTo = next < 0 ? source.length : next;
  const standalone = !source.slice(lineFrom, range.from).trim() && !source.slice(range.to, lineTo).trim();
  const before = source.slice(0, point), after = source.slice(point);
  const ending = source.includes('\r\n') ? '\r\n' : '\n';
  const prefix = standalone && before && !before.endsWith(ending + ending)
    ? before.endsWith(ending) ? ending : ending + ending : '';
  const suffix = standalone && after && !after.startsWith(ending + ending)
    ? after.startsWith(ending) ? ending : ending + ending : '';
  const insert = prefix + raw + suffix;
  const at = point - (point > range.to ? range.to - range.from : 0);
  const removed = source.slice(0, range.from) + source.slice(range.to);
  const result = removed.slice(0, at) + insert + removed.slice(at);
  const imageAt = at + prefix.length + from - range.from;
  // Reject code, link destinations and other syntax positions that would turn
  // the moved image into literal text or change its resource reference.
  let valid = false;
  markdown.parse(result).iterate({enter(node) {
    if (node.name === 'Image' && node.from === imageAt && node.to === imageAt + to - from) valid = true;
  }});
  if (!valid) return null;
  return {changes:[{from:range.from,to:range.to,insert:''},{from:point,insert}].sort((a,b)=>a.from-b.from),
    anchor:at + insert.length};
}
