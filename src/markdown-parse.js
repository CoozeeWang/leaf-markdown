import { parser } from '@lezer/markdown';
import { leafMarkdownExtensions } from './markdown-extensions.js';
import {maskHiddenComments} from './comments.js';
import {incrementalParser} from './incremental-parse.js';
const markdownParser = parser.configure(leafMarkdownExtensions);
const parse = incrementalParser(markdownParser);
const recent = new Map();
// Share immutable syntax trees across scans. Bound retained long snapshots to
// two; short fragments must not evict the current document during note editing.
export function parseMarkdown(source) {
  if (source.length < 16384) return parse(maskHiddenComments(source));
  if (recent.has(source)) return recent.get(source);
  const tree = parse(maskHiddenComments(source));
  recent.set(source, tree);
  if (recent.size > 2) recent.delete(recent.keys().next().value);
  return tree;
}
