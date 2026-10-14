import { t, h, setText, setAttr } from './i18n.js';
import { calloutBadge } from './callout-icons.js';
import { parser } from '@lezer/markdown';
import { leafMarkdownExtensions } from './markdown-extensions.js';
import { analyzeMarkdown } from './markdown-model.js';
import { renderInline } from './inline-preview.js';
import { applyTableWidths } from './table-layout.js';
import { parseCallout, labels as calloutLabels } from './callout.js';
import { indexFootnotes, displayNotes } from './footnotes.js';
import {indexComments,maskHiddenComments} from './comments.js';

const markdown = parser.configure(leafMarkdownExtensions);

// Export the complete source, never the virtualized/partially visible editor DOM.
// All document text is inserted as text nodes. Raw HTML remains inert text.
//
// The reading view and the PDF both land here, so the footnote pass is written
// once and both get it. Only the outermost call indexes the document and appends
// the list; the callout recursion below reuses the same index so a citation keeps
// its number inside a callout instead of starting a second, local numbering.
export function renderPrintDocument(target, source, {
  name = t("desktop.untitled_md"), numbered = false, properties = false,
  fallbackTitle = true, fileNameTitle = false, expandCallouts = true, sourcePositions = false, footnotes: shared, annotations = false, annotationNotes = [], resources = true,
} = {}) {
  const root = !shared;
  const state = shared ?? createFootnoteState(source);
  target.replaceChildren();
  const model = analyzeMarkdown(source);
  const annotationIndex=indexComments(source).notes.map((n,i)=>({...n,id:annotationNotes[i]?.id??'reading-comment-'+n.from}));
  const inline=(target,text,at=0)=>renderInline(target,text,state,{show:annotations,notes:annotationIndex,offset:at,resources});
  const add = (tag, parent = target, text) => {
    const el = document.createElement(tag); if (text !== undefined) el.textContent = text; parent.append(el); return el;
  };
  if (fileNameTitle || fallbackTitle && !model.hasH1) {
    const title = add('h1', target, name.replace(/\.(md|markdown|mdown)$/i, ''));
    if (fileNameTitle) title.className = 'leaf-file-name-title';
  }
  if (properties && model.yaml) {
    const box = add('section'); box.className = 'print-properties'; setText(add('h2', box), () => t("pdf_export.document_properties"));
    if (sourcePositions) {
      box.dataset.sourceFrom = '0';
      box.dataset.sourceTo = String(model.yaml.to);
    }
    // Preserve complex YAML values rather than silently replacing them with a hint.
    if (model.yaml.valid && model.yaml.fields.every(f => f.editable)) {
      const list = add('dl', box);
      for (const field of model.yaml.fields) { add('dt', list, field.key); add('dd', list, String(field.value)); }
    } else add('pre', box, source.slice(0, model.yaml.to));
  }
  const offset = model.yaml?.to ?? 0;
  const region = maskHiddenComments(source).slice(offset);
  // A definition is blanked rather than skipped while walking the tree: the base
  // grammar reads "[^1]: text" as a link reference definition and the indented
  // continuation below it as a CodeBlock, so dropping just the definition's own
  // node would leave the tail behind as a code block. Blanking keeps every offset
  // identical and gives the parser nothing to misread, in a list or a callout too.
  const body = root ? maskRanges(region, state.definitions, offset) : region;
  const markSource = (element, node, doc) => {
    if (sourcePositions && doc === body) {
      element.dataset.sourceFrom = String(node.from + offset);
      element.dataset.sourceTo = String(node.to + offset);
    }
    return element;
  };
  function visit(node, parent, doc) {
    const isMain = doc === body;
    const text = doc.slice(node.from, node.to);
    const callout = node.name === 'Blockquote' ? parseCallout(text) : null;
    if (callout) {
      const box = add(callout.fold && !expandCallouts ? 'details' : 'section', parent);
      box.className = 'leaf-callout'; box.dataset.type = callout.type;
      markSource(box, node, doc);
      if (box.tagName === 'DETAILS') box.open = callout.fold !== '-';
      const title = add(box.tagName === 'DETAILS' ? 'summary' : 'div', box); title.className = 'leaf-callout-title';
      const badge = add('span', title); badge.className = 'leaf-callout-type-icon'; badge.innerHTML = calloutBadge(callout.type);
      const titleText = add('span', title);
      if (callout.customTitle) renderInline(titleText, callout.title, state, {resources});
      else setText(titleText, () => calloutLabels[callout.type]);
      const content = add('div', box); content.className = 'leaf-callout-body';
      renderPrintDocument(content, callout.body, { fallbackTitle:false, expandCallouts, footnotes: state, resources });
      return;
    }
    const level = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name)?.[1];
    if (level) {
      const heading = model.headings.find(h => h.from === node.from + offset);
      let content = text.replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '').replace(/[ \t]+#+[ \t]*$/, '');
      if (node.name.startsWith('Setext')) content = content.replace(/\r?\n[ \t]*(?:=+|-+)[ \t]*$/, '');
      if (numbered && heading?.legacyPrefix) {
        const start = heading.legacyPrefix.to - offset;
        content = doc.slice(start, node.to).replace(/[ \t]+#+[ \t]*$/, '');
      }
      if (node.name.startsWith('Setext')) content = content.replace(/\r?\n[ \t]*(?:=+|-+)[ \t]*$/, '');
      const h = markSource(add(`h${level}`, parent), node, doc);
      if (isMain && heading) h.dataset.sourceLine = String(source.slice(0, heading.from).split('\n').length);
      if (numbered && isMain && heading) add('span', h, heading.number + ' ').className = 'print-heading-number';
      const title = add('span', h); inline(title, content, node.from+offset+text.indexOf(content)); return;
    }
    if (node.name === 'Table') {
      const block = model.blocks.find(b => b.kind === 'table' && b.from === node.from + offset);
      if (!block) { markSource(add('pre', parent, text), node, doc); return; }
      const table = markSource(add('table', parent), node, doc); applyTableWidths(table, block);
      const head = add('thead', table), tbody = add('tbody', table);
      block.rows.forEach((row, i) => {
        const tr = add('tr', i ? tbody : head);
        for (let c = 0; c < block.columns; c++) {
          const cell = add(i ? 'td' : 'th', tr); cell.style.textAlign = block.align[c];
          inline(cell, row.cells[c]?.value ?? '', row.cells[c]?.from ?? 0);
        }
      }); return;
    }
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
      const code = node.getChildren('CodeText');
      const pre = markSource(add('pre', parent), node, doc), info = node.getChild('CodeInfo');
      if (info) pre.dataset.language = doc.slice(info.from, info.to);
      add('code', pre, code.map(part => doc.slice(part.from, part.to)).join('')); return;
    }
    if (node.name === 'HorizontalRule') { markSource(add('hr', parent), node, doc); return; }
    if (node.name === 'Paragraph') {
      // Continuation quote markers are parser children, not inline content.
      // Remove only those marks; a literal > inside text/code must survive.
      let content = '', cursor = node.from;
      for (const mark of node.getChildren('QuoteMark')) {
        content += doc.slice(cursor, mark.from);
        cursor = mark.to + (/^[ \t]/.test(doc.slice(mark.to)) ? 1 : 0);
      }
      content += doc.slice(cursor, node.to);
      inline(markSource(add('p', parent), node, doc), content,node.from+offset); return;
    }
    if (node.name === 'Task') {
      const p = markSource(add('p', parent), node, doc); p.textContent = /^\[[xX]\]/.test(text) ? '☑ ' : '☐ ';
      renderInline(add('span', p), text.replace(/^\[[ xX]\]\s*/, ''), state, {resources}); return;
    }
    if (['ListMark', 'QuoteMark', 'CodeMark', 'CodeInfo'].includes(node.name)) return;
    const tags = { BulletList: 'ul', OrderedList: 'ol', ListItem: 'li', Blockquote: 'blockquote' };
    const container = tags[node.name] ? markSource(add(tags[node.name], parent), node, doc) : parent;
    if (node.name === 'OrderedList') container.start = Number(/^\d+/.exec(text)?.[0] ?? 1);
    if (!node.firstChild) { if (text.trim()) markSource(add('p', container, text), node, doc); return; }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child, container, doc);
  }
  const renderBlocks = (container, text) => visit(markdown.parse(text).topNode, container, text);
  renderBlocks(target, body);
  for (const label of target.querySelectorAll('.leaf-inline-link')) {
    if (!label.dataset.leafLink) continue;
    const link = document.createElement('a'); link.href = label.title;
    link.className = label.className; link.dataset.leafLink = label.dataset.leafLink; link.replaceChildren(...label.childNodes);
    label.replaceWith(link);
  }
  if (root && state.list.length) {
    const section = add('section'); section.className = 'print-footnotes';
    const title = setText(add('h2', section), () => t("print_document.footnotes")); title.className = 'print-footnotes-title';
    const list = add('ol', section); list.className = 'print-footnotes-list';
    // Native printing clips outside markers at the content margin. Reserve
    // space for the widest number, including long documents with 100+ notes.
    list.style.setProperty('--footnote-marker-width', `${String(state.list.length).length + 2}ch`);
    for (const note of state.list) {
      const item = add('li', list); item.id = `fn-${note.number}`;
      const definition = state.notesByLabel.get(note.label)?.def;
      if (sourcePositions && definition) {
        item.dataset.sourceFrom = String(definition.from);
        item.dataset.sourceTo = String(definition.to);
      }
      const entry = add('div', item); entry.className = 'footnote-text';
      renderBlocks(entry, note.body);
      const back = document.createElement('a');
      back.className = 'footnote-backref'; back.textContent = '↩';
      back.href = `#fnref-${note.number}`; setAttr(back, 'title', () => t("print_document.back_to_text"));
      setAttr(back, 'aria-label', () => t("print_document.back_to_text"));
      // Drop the arrow inside the last block of the note: appending it to the
      // entry itself puts it after that block, so a note ending in a paragraph
      // or a list pushes the arrow onto a line of its own.
      lastInlineHost(entry).append(back);
    }
  }
}

// Walk to the innermost element that can still hold inline content at the end of
// a rendered block: a paragraph, or the last item of a trailing list.
function lastInlineHost(entry) {
  let host = entry;
  for (;;) {
    const last = host.lastElementChild;
    if (!last || !['P', 'UL', 'OL', 'LI'].includes(last.tagName)) return host;
    host = last;
  }
}

// The display numbering is computed, not taken from the index's `number`: a
// citation whose definition has not been written yet is printed as its literal
// marker rather than as a number pointing at nothing, so it must not consume a
// slot either -- otherwise the list would read 1, 3, 4. The rule lives in the
// index layer because the editor renders the same numbers in the same order.
function createFootnoteState(source) {
  const index = indexFootnotes(source);
  const { map, list } = displayNotes(index);
  return { map, list, definitions: index.definitions, notesByLabel: new Map(index.notes.map(note => [note.id, note])), seen: new Map() };
}

// Replace the definition blocks with spaces, keeping every newline, so the text
// keeps its exact length and the parser sees nothing where the definitions were.
function maskRanges(text, ranges, offset) {
  const cuts = ranges
    .map(range => ({ from: range.from - offset, to: range.to - offset }))
    .filter(range => range.from >= 0 && range.to <= text.length)
    .sort((a, b) => a.from - b.from);
  let out = '', cursor = 0;
  for (const cut of cuts) {
    if (cut.to <= cursor) continue;
    const from = Math.max(cut.from, cursor);
    out += text.slice(cursor, from) + text.slice(from, cut.to).replace(/[^\n]/g, ' ');
    cursor = cut.to;
  }
  return out + text.slice(cursor);
}
