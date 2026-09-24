import { parser } from '@lezer/markdown';
import { leafMarkdownExtensions } from './markdown-extensions.js';
import { inlineTagSpans, isVoidInlineTag } from './inline-html.js';
import { imageNode, safeTarget } from './resources.js';
import './writing.css';
const inlineParser = parser.configure(leafMarkdownExtensions);

// "[^1]" parses as a Link with no URL child whether or not a definition exists,
// because link reference resolution happens after the block pass. Matching the
// raw text is what tells a citation apart from a real link.
const CITATION = /^\[\^([^\[\]\r\n]+)\]$/;
// Two citations written side by side are one Link to the parser -- "[^1][^2]" is
// a reference link whose text is "^1" and whose label is "^2" -- so a run of
// them arrives as a single node and has to be taken apart by hand. Inserting a
// note right before an existing one produces exactly that.
const CITATION_RUN = /^(?:\[\^[^\[\]\r\n]+\])+$/;
const CITATIONS = /\[\^([^\[\]\r\n]+)\]/g;

// A rendered citation shows a number the widget does not own: it is derived from
// the whole document. Rendered widgets are compared by value, so each one also
// carries this signature -- without it, writing a definition on some other line
// would leave the marker showing the number it had before. `-` stands for a
// citation that has no definition yet, which renders as its literal marker.
// Returns null for anything that is not a run of citations, so a caller can tell
// "no citation here" from "citation whose number is not settled yet".
export function citationSignature(text, map) {
  if (!CITATION_RUN.test(text)) return null;
  if (!map) return '';
  const numbers = [];
  for (const match of text.matchAll(CITATIONS)) numbers.push(map.get(match[1])?.number ?? '-');
  return numbers.join(',');
}

// The label of a lone citation that has a definition, or null. A click on the
// marker opens that note, and a run of markers has no single label to open.
export function citationLabel(text, map) {
  const single = CITATION.exec(text);
  if (!single || !map?.has(single[1])) return null;
  return single[1];
}

// Construct DOM nodes, never interpret a document's HTML or script as UI.
// Only <br> and paired <sup>/<sub> leave inert text; every other tag stays literal.
//
// `footnotes` is optional and only the reading view, the PDF and the editor pass
// it: without it the citations keep rendering as the bare marker. It carries a
// Map from the citation label to its display number, and citations are looked up
// by label rather than by offset because a table cell arrives as its own raw
// string whose offsets do not line up with the document's.
//
// `footnotes.link === false` renders the number without the link to the note:
// the editor would otherwise put an anchor inside the document the webview
// navigates, and there the number is a label on the text, not a destination.
export function renderInline(target, text, footnotes) {
  target.replaceChildren();
  const tree = inlineParser.parse(text);
  const openAt = new Map(), closeAt = new Map();
  for (const span of inlineTagSpans(text, tree)) {
    openAt.set(span.openFrom, span);
    closeAt.set(span.closeFrom, span);
  }
  const byLabel = footnotes?.map ?? null;
  // A citation whose definition is missing is not a footnote: print the marker
  // as written so the gap is visible instead of dangling a number.
  function citation(label) {
    const note = byLabel?.get(label);
    if (!note) return null;
    const sup = document.createElement('sup');
    sup.className = 'footnote-ref';
    sup._footnoteLabel = label;
    if (footnotes.link === false) { sup.textContent = String(note.number); return sup; }
    const seen = (footnotes.seen.get(note.label) ?? 0) + 1;
    footnotes.seen.set(note.label, seen);
    const link = document.createElement('a');
    link.id = seen === 1 ? `fnref-${note.number}` : `fnref-${note.number}-${seen}`;
    link.href = `#fn-${note.number}`;
    link.textContent = String(note.number);
    sup.append(link);
    return sup;
  }
  function visit(node, parent, inLink = false) {
    if (node.name === 'Image') {
      const url = node.getChild('URL');
      if (url) { const raw = text.slice(node.from, node.to); parent.append(imageNode(raw.slice(2, raw.indexOf(']')), text.slice(url.from, url.to))); return; }
    }
    if (byLabel && node.name === 'Link' && !node.getChild('URL')) {
      const raw = text.slice(node.from, node.to);
      const single = CITATION.exec(raw);
      if (single) { parent.append(citation(single[1]) || document.createTextNode(raw)); return; }
      if (CITATION_RUN.test(raw)) {
        let at = 0;
        for (const match of raw.matchAll(CITATIONS)) {
          if (match.index > at) parent.append(document.createTextNode(raw.slice(at, match.index)));
          parent.append(citation(match[1]) || document.createTextNode(match[0]));
          at = match.index + match[0].length;
        }
        if (at < raw.length) parent.append(document.createTextNode(raw.slice(at)));
        return;
      }
    }
    if (/^(EmphasisMark|StrikethroughMark|CodeMark|LinkMark|LeafHighlightMark)$/.test(node.name) || (inLink && node.name === 'URL')) return;
    const tags = { StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 's', InlineCode: 'code', Link: 'span', LeafHighlight: 'mark' };
    let container = parent;
    if (tags[node.name]) {
      container = document.createElement(tags[node.name]); parent.append(container);
      if (node.name === 'Link') {
        container.className = 'leaf-inline-link';
        const url = node.getChild('URL');
        container.title = url ? text.slice(url.from, url.to) : '';
        const target = safeTarget(container.title); if (target) container.dataset.leafLink = target;
      }
    }
    let position = node.from;
    // Paired tags are flat siblings, so the open/close pair is tracked across
    // the child loop rather than inside a recursive visit of its own.
    const stack = [container];
    const current = () => stack[stack.length - 1];
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.from > position) current().append(document.createTextNode(text.slice(position, child.from)));
      if (child.name === 'HTMLTag') {
        const raw = text.slice(child.from, child.to);
        const open = openAt.get(child.from);
        if (isVoidInlineTag(raw)) current().append(document.createElement('br'));
        else if (open) { const el = document.createElement(open.tag); current().append(el); stack.push(el); }
        else if (closeAt.has(child.from)) { if (stack.length > 1) stack.pop(); }
        else current().append(document.createTextNode(raw));
      } else visit(child, current(), inLink || node.name === 'Link');
      position = child.to;
    }
    if (node.to > position) current().append(document.createTextNode(text.slice(position, node.to)));
  }
  visit(tree.topNode, target);
}
