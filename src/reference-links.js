import { parser } from '@lezer/markdown';
import { leafMarkdownExtensions } from './markdown-extensions.js';
import {incrementalParser} from './incremental-parse.js';
const markdown = parser.configure(leafMarkdownExtensions);
const parse = incrementalParser(markdown);
const cache = new WeakMap();
export const normalizeReferenceLabel = label => label.trim().replace(/\s+/g, ' ').toLowerCase();

// CodeMirror documents are immutable: selection changes reuse this index.
export function referenceLinks(document) {
  if (typeof document === 'object' && cache.has(document)) return cache.get(document);
  const source = String(document), map = new Map();
  if (source.includes(']:')) parse(source).iterate({ enter(node) {
    if (node.name !== 'LinkReference') return;
    const label = node.node.getChild('LinkLabel'), url = node.node.getChild('URL');
    if (!label || !url) return;
    const name = normalizeReferenceLabel(source.slice(label.from + 1, label.to - 1));
    if (!name.startsWith('^') && !map.has(name)) map.set(name, source.slice(url.from, url.to));
  }});
  const result = { map, signature: JSON.stringify([...map]) };
  if (typeof document === 'object') cache.set(document, result);
  return result;
}

export function referenceTarget(node, source, references) {
  const explicit = node.getChild('LinkLabel');
  const label = explicit && source.slice(explicit.from + 1, explicit.to - 1);
  const marks = node.getChildren('LinkMark');
  const text = marks.length >= 2 ? source.slice(marks[0].to, marks[1].from) : '';
  return references?.map.get(normalizeReferenceLabel(label || text));
}
