// Inline HTML is inert text in Leaf except for a tiny allowlist. <br> was the
// first exception; paired <sup>/<sub> are the second, matching how Obsidian
// itself renders superscript and subscript. Everything else stays literal.
const OPEN_TAG = /^<(sup|sub)\s*>$/i;
const CLOSE_TAG = /^<\/(sup|sub)\s*>$/i;
const VOID_TAG = /^<br\s*\/?\s*>$/i;

export function classifyInlineTag(raw) {
  const open = OPEN_TAG.exec(raw);
  if (open) return { name: open[1].toLowerCase(), close: false };
  const close = CLOSE_TAG.exec(raw);
  if (close) return { name: close[1].toLowerCase(), close: true };
  return null;
}

export function isVoidInlineTag(raw) { return VOID_TAG.test(raw); }

// Match opening and closing tags in document order. Ranges may nest but never
// cross: a closing tag discards every unclosed tag above its match, so a
// crossed pair such as "<sup><sub>x</sup></sub>" degrades to one valid span
// instead of producing overlapping ranges that would break DOM nesting.
export function pairInlineTags(tags) {
  const stack = [];
  const spans = [];
  for (const tag of tags) {
    if (!tag.close) { stack.push(tag); continue; }
    let index = -1;
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name === tag.name) { index = i; break; }
    if (index < 0) continue;
    const open = stack.splice(index)[0];
    spans.push({ tag: open.name, openFrom: open.from, openTo: open.to,
      contentFrom: open.to, contentTo: tag.from, closeFrom: tag.from, closeTo: tag.to });
  }
  spans.sort((a, b) => a.openFrom - b.openFrom);
  return spans;
}

// Collect paired spans from a parsed inline tree. Tags are grouped by their
// parent node so an unclosed <sup> in one paragraph can never swallow a stray
// </sup> in another.
export function inlineTagSpans(text, tree) {
  const groups = new Map();
  tree.iterate({ enter(node) {
    if (node.name !== 'HTMLTag') return;
    const classified = classifyInlineTag(text.slice(node.from, node.to));
    if (!classified) return;
    const parent = node.node.parent;
    const key = parent ? `${parent.from}:${parent.name}` : 'root';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ name: classified.name, close: classified.close, from: node.from, to: node.to });
  } });
  const spans = [];
  for (const tags of groups.values()) spans.push(...pairInlineTags(tags));
  spans.sort((a, b) => a.openFrom - b.openFrom);
  return spans;
}
