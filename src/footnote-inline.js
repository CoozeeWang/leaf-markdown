import { parseMarkdown } from './markdown-parse.js';

const cached = new WeakMap();
const inlineNodes = new Set([
  'StrongEmphasis', 'Emphasis', 'Strikethrough', 'InlineCode', 'LeafHighlight',
  'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LeafHighlightMark', 'Link', 'Image',
]);

// The document grammar consumes a definition as a link reference or code.
// Parse its de-indented body with the same Markdown extensions as prose, then
// map each inline span back to the untouched file. Split spans at line breaks:
// continuation indents and CRLF bytes are not part of the formatted content.
export function footnoteInlineNodes(source, definition) {
  if (cached.has(definition)) return cached.get(definition);
  const indents = new Map(definition.continuations.map(span => [span.from, span.to - span.from]));
  const lines = [];
  let original = definition.bodyFrom, body = 0;
  for (const raw of source.slice(definition.bodyFrom, definition.bodyTo).split('\n')) {
    const indent = indents.get(original) ?? 0;
    const length = raw.slice(indent).trimEnd().length;
    lines.push({ from: body, to: body + length, original: original + indent });
    original += raw.length + 1;
    body += length + 1;
  }
  const spans = (from, to) => lines.flatMap(line => {
    const start = Math.max(from, line.from), end = Math.min(to, line.to);
    return end > start ? [{ from: line.original + start - line.from, to: line.original + end - line.from }] : [];
  });
  const result = [];
  parseMarkdown(definition.body).iterate({ enter(node) {
    // Real code examples inside a note must retain their literal Markdown.
    if (['FencedCode', 'CodeBlock', 'LinkReference'].includes(node.name)) return false;
    if (!inlineNodes.has(node.name)) return;
    result.push({ name: node.name, from: node.from, to: node.to,
      text: definition.body.slice(node.from, node.to), ranges: spans(node.from, node.to) });
  } });
  cached.set(definition, result);
  return result;
}
