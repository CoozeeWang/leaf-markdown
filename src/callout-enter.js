import {parseMarkdown} from './markdown-parse.js';

// Decide from Markdown structure, never from a global Enter-key counter.
export function calloutEnter(value, from, to, shift = false) {
  const tree = parseMarkdown(value);
  let node = tree.resolveInner(from, -1);
  for (; node; node = node.parent) {
    if (/^(?:BulletList|OrderedList|ListItem|FencedCode|CodeBlock|Blockquote|Table)$/.test(node.name)) return null;
  }
  const last = tree.topNode.lastChild;
  if (last && last.name !== 'Paragraph' && from >= last.to) return null;
  if (!shift && from === to && to === value.length &&
      (!value.trim() || /\n[ \t]*\n[ \t]*$/.test(value)) &&
      (!last || last.name === 'Paragraph')) {
    return {exit:true, value:value.replace(/\n[\s]*$/, '')};
  }
  const insert = shift ? '\\\n' : '\n\n';
  return {exit:false, value:value.slice(0, from) + insert + value.slice(to), caret:from + insert.length};
}
