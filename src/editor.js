import { leafSelection } from './selection.js';
import { sourceMode, setSourceMode } from './view-mode.js';
import { unfoldAll } from '@codemirror/language';
import { Compartment, EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state';
import { renderBlock, sourceBlock, propertiesFolded, toggleProperties } from './structured-preview.js';
import { labels as calloutLabels, titleSlotInSource, bodyToSource } from './callout.js';
import { footnoteIndex, footnoteLabelFollow, footnoteRenumber, footnoteReferenceDeletion, footnoteLabelMap } from './footnote-state.js';
import { orderedListRenumber } from './list-order.js';
import { planFootnoteInsertion, planFootnoteDeletion, indexFootnotes, displayNotes, footnoteBodyText, appendDefinition } from './footnotes.js';
import { uiIcon } from './ui-icons.js';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
  invertedEffects,
  indentMore,
  indentLess,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from '@codemirror/commands';
import {
  HighlightStyle,
  bracketMatching,
  defaultHighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language';
import { insertNewlineContinueMarkup, deleteMarkupBackward, markdown } from '@codemirror/lang-markdown';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { LeafSearchPanel } from './search-panel.js';
import { tags } from '@lezer/highlight';
import { leafMarkdownExtensions } from './markdown-extensions.js';
import { structuredPreview, documentName, fileNameTitle, toggleFileNameTitle } from './structured-preview.js';
import { renderInline, citationSignature, citationLabel } from './inline-preview.js';
import { paragraphBlankLineChanges } from './blank-lines.js';
import { frontmatter } from './markdown-model.js';
import { paragraphDeletion, selectedParagraphDeletion } from './paragraph-delete.js';
import {outlineFolding} from './outline-folding.js';
import { classifyInlineTag, pairInlineTags } from './inline-html.js';

const toggleBlankMarkers = StateEffect.define();
const typedProperties = StateEffect.define();
const blankMarkers = StateField.define({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(toggleBlankMarkers)) value = effect.value;
    return value;
  },
});

const lineNumberCompartment = new Compartment();
const toggleHeadingNumbers = StateEffect.define();
const headingNumbers = StateField.define({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(toggleHeadingNumbers)) value = effect.value;
    return value;
  },
});

class InlinePreview extends WidgetType {
  constructor(from, text, { rule = false, title = '', footnotes = null, signature = '', note = null } = {}) {
    super();
    this.from = from; this.text = text; this.rule = rule; this.title = title;
    this.footnotes = footnotes; this.signature = signature; this.note = note;
  }
  // Rendered widgets are compared by value, and a citation's number is not part
  // of its source text: without the signature, adding or removing a definition
  // elsewhere would leave the marker printed with its old number.
  eq(other) {
    return this.from === other.from && this.text === other.text && this.rule === other.rule && this.title === other.title && this.signature === other.signature && this.note === other.note;
  }
  updateDOM(span) {
    const old = span._preview;
    if (!old || this.text !== old.text || this.rule !== old.rule || this.title !== old.title || this.signature !== old.signature || this.note !== old.note) return false;
    span._preview = this;
    return true;
  }
  toDOM(view) {
    const span = document.createElement('span');
    span._preview = this;
    if (this.rule) { span.className = 'leaf-rule'; span.setAttribute('role', 'separator'); }
    else { renderInline(span, this.text, this.footnotes && { ...this.footnotes, seen: new Map() }); if (this.title) span.title = this.title; }
    span.addEventListener('mousedown', event => {
      event.preventDefault(); view.dispatch({ selection: { anchor: span._preview.from } }); view.focus();
      // A marker stands for a note: clicking it takes the reader to that note in
      // the notes panel, the way a printed footnote sends you to the foot of the
      // page, instead of leaving the caret on a label with nothing to edit.
      const label = event.target.closest?.('.footnote-ref')?._footnoteLabel ?? span._preview.note;
      if (label) onNoteActivate?.(label);
    });
    return span;
  }
  ignoreEvent() { return true; }
}

// A definition reads "[^1]: body" in the file. The caret is not on it most of the
// time, and then what the line says is a numbered note: the brackets stay, the
// caret and the colon go. The number drawn is the one the reader sees, which is
// computed from the whole document and need not be the label in the file -- so it
// is not part of the source text and has to take part in `eq` by itself.
class FootnoteLabel extends WidgetType {
  constructor(number, to) { super(); this.number = number; this.to = to; }
  eq(other) { return this.number === other.number && this.to === other.to; }
  toDOM(view) {
    const span = document.createElement('span');
    span.className = 'leaf-footnote-label';
    span.textContent = `[${this.number}]`;
    span.addEventListener('mousedown', event => {
      event.preventDefault(); view.dispatch({ selection: { anchor: this.to } }); view.focus();
    });
    return span;
  }
  ignoreEvent() { return true; }
}

class TaskCheckbox extends WidgetType {
  constructor(from, checked) { super(); this.from = from; this.checked = checked; }
  eq(other) { return this.from === other.from && this.checked === other.checked; }
  toDOM(view) {
    const input = document.createElement('input');
    input.type = 'checkbox'; input.checked = this.checked;
    input.className = 'leaf-task-checkbox'; input.setAttribute('aria-label', '完成任务');
    input.addEventListener('change', () => view.dispatch({ changes: { from: this.from + 1, to: this.from + 2, insert: input.checked ? 'x' : ' ' }, userEvent: 'input' }));
    return input;
  }
  ignoreEvent() { return true; }
}

// Align labels with the first text line, not the top of a heading/paragraph's
// spacing box. Never change the gutter row's measured height.
const alignLineNumbers = ViewPlugin.fromClass(class {
  constructor(view) { this.measure(view); }
  update(update) { this.measure(update.view); }
  measure(view) {
    this.view = view;
    this.extraPass = false;
    view.requestMeasure({
      key: this,
      read: () => this.read(view),
      write: rows => this.write(rows),
    });
  }
  read(view) {
    return [...view.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].map(el => {
      const n = Number(el.textContent);
      if (el.style.visibility === 'hidden' || !Number.isInteger(n) || n < 1 || n > view.state.doc.lines) return [el, 0];
      // Read the actual text DOM. The provisional CodeMirror height map can
      // briefly re-estimate preceding widgets on every keystroke.
      const from = view.state.doc.line(n).from;
      const dom = view.domAtPos(from);
      const line = (dom.node.nodeType === 1 ? dom.node : dom.node.parentElement)?.closest?.('.cm-line');
      let coords;
      if (line) {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let text;
        while ((text = walker.nextNode())) {
          if (!text.length || text.parentElement.closest('.leaf-editing-marker, .leaf-image, .leaf-heading-fold')) continue;
          const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 1);
          const rect = range.getBoundingClientRect();
          if (rect.height) { coords = rect; break; }
        }
      }
      if (!coords) return [el, parseFloat(el.style.paddingTop) || 0];
      const labelHeight = parseFloat(getComputedStyle(el).lineHeight) || 11;
      return [el, coords ? Math.max(0, (coords.top + coords.bottom - labelHeight) / 2 - el.getBoundingClientRect().top) : 0];
    });
  }
  write(rows) {
    let moved = false;
    for (const [el, offset] of rows) {
      const value = `${offset}px`;
      if (el.style.paddingTop !== value) { el.style.paddingTop = value; moved = true; }
    }
    // coordsAtPos reads the height map, so a change that re-sizes line boxes is
    // still seen at its old geometry here. One more pass on the next frame places
    // the rows that moved from the geometry they actually ended up with; the
    // second pass finds nothing left to move and stops.
    if (!moved || this.extraPass) return;
    this.extraPass = true;
    requestAnimationFrame(() => { if (this.view.dom.isConnected) this.view.requestMeasure({ key: this, read: () => this.read(this.view), write: r => this.write(r) }); });
  }
});

function leafLineNumbers() {
  return [alignLineNumbers, lineNumbers({
    // A blank row stays anonymous: it is the space between two blocks, and a
    // number floating in it points at nothing the writer wrote. Source mode
    // numbers every line, because there a blank line is literal text.
    formatNumber(lineNumber, state) {
      // CodeMirror asks for 9/99/999 as virtual width-measurement labels.
      if (lineNumber > state.doc.lines) return String(lineNumber);
      return state.field(sourceMode) || state.doc.line(lineNumber).text.trim() ? String(lineNumber) : '';
    },
  })];
}

const leafHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, class: 'tok-heading tok-heading-1' },
  { tag: tags.heading2, class: 'tok-heading tok-heading-2' },
  { tag: tags.heading3, class: 'tok-heading tok-heading-3' },
  { tag: tags.heading4, class: 'tok-heading tok-heading-4' },
  { tag: tags.strong, class: 'tok-strong' },
  { tag: tags.emphasis, class: 'tok-emphasis' },
  { tag: tags.strikethrough, class: 'tok-strike' },
  { tag: tags.link, class: 'tok-link' },
  { tag: tags.url, class: 'tok-url' },
  { tag: tags.monospace, class: 'tok-code' },
  { tag: tags.quote, class: 'tok-quote' },
  { tag: tags.meta, class: 'tok-meta' },
]);

// Obsidian's live preview hides syntax only while you are not editing it. A
// span of markup is displayed as-is when the caret sits inside the node it
// belongs to, which lets the rest of the active line stay rendered. Both
// boundaries count as inside: the markup then stays put right after its closing
// delimiter is typed, and clicking a rendered span reveals its source instead of
// being swallowed by a replacement that covers the caret.
function caretInRange(state, from, to) {
  return state.selection.ranges.some(range => range.from <= to && range.to >= from);
}

// Marks are children of the node they delimit, so the test runs against the
// parent: emphasis marks against StrongEmphasis or Emphasis, code marks against
// InlineCode, highlight marks against LeafHighlight, header marks against the
// heading, quote marks against the blockquote.
function caretInParent(state, node) {
  const parent = node.node.parent;
  return parent ? caretInRange(state, parent.from, parent.to) : false;
}

// A zero-width decoration labels source boundaries without inserting text,
// changing wrapping, or leaking markers into copy/export.
class EditingMarker extends WidgetType {
  constructor(symbol) { super(); this.symbol = symbol; }
  eq(other) { return other.symbol === this.symbol; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'leaf-editing-marker';
    span.dataset.symbol = this.symbol;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  ignoreEvent() { return true; }
}
function editingMarkerRanges(view) {
  if (!view.state.field(blankMarkers)) return [];
  const source = view.state.field(sourceMode), doc = view.state.doc;
  const paragraphEnds = new Set(), literalRanges = [];
  if (!source) syntaxTree(view.state).iterate({enter(node) {
    if (node.name === 'Paragraph') paragraphEnds.add(node.to);
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') literalRanges.push({from:node.from,to:node.to});
  }});
  const blocks = view.state.field(structuredPreview).model.blocks;
  const ranges = [];
  for (const visible of view.visibleRanges) {
    let line = doc.lineAt(visible.from);
    while (line.from <= visible.to) {
      // Structured previews own their DOM; inspect their source in source mode.
      const structured = !source && blocks.some(b => b.from <= line.from && b.to >= line.to);
      const literal = !source && literalRanges.some(b => b.from <= line.from && b.to >= line.to);
      if (!structured && !literal && (line.number < doc.lines || (!source && paragraphEnds.has(line.to)))) {
        const symbol = !source && paragraphEnds.has(line.to) ? '¶' : '↵';
        ranges.push(Decoration.widget({widget:new EditingMarker(symbol), side:1}).range(line.to));
      }
      if (line.to >= doc.length) break;
      line = doc.line(line.number + 1);
    }
  }
  return ranges;
}

function livePreviewDecorations(view) {
  if (view.state.field(sourceMode, false)) return Decoration.set(editingMarkerRanges(view), true);
  const ranges = editingMarkerRanges(view);
  const { doc } = view.state;
  const numbered = view.state.field(headingNumbers);
  const numbers = new Map(view.state.field(structuredPreview).model.headings.map(h => [h.from, h]));
  const tree = syntaxTree(view.state);

  // Citations print the number the reading view prints, so a marker says the same
  // thing in both places. The editor never builds the jump-to-note anchors: an
  // anchor in the document is a place the webview would navigate to.
  const index = view.state.field(footnoteIndex);
  const noteNumbers = index.notes.length ? displayNotes(index).map : null;
  const footnotes = noteNumbers ? { map: noteNumbers, link: false } : undefined;

  // The grammar has no footnote syntax: it reads "[^1]: text" as a link reference
  // definition, so the note body is highlighted as if it were a URL. The marker is
  // drawn as the note's number instead, and goes back to its source while the
  // caret is on the definition, the way every other construct behaves.
  const definitionLines = new Set();
  for (const note of index.notes) {
    if (!note.def) continue;
    // A definition's own label is not a citation. The grammar turns "[^1]" into a
    // link whenever the definition does not open a block -- inside a list item, or
    // under a paragraph with no blank line between them -- and the citation pass
    // would then print the number with the definition's colon dangling after it.
    definitionLines.add(note.def.markerFrom);
    const number = noteNumbers?.get(note.id)?.number;
    // The whole definition reads as a note or as its source, never half of each:
    // the marker's label and the continuation indents come back together.
    const editing = caretInRange(view.state, note.def.from, note.def.to);
    if (number === undefined || editing) {
      ranges.push(Decoration.mark({ class: 'leaf-footnote-marker' }).range(note.def.markerFrom, note.def.markerTo));
    } else {
      ranges.push(Decoration.replace({ widget: new FootnoteLabel(number, note.def.markerTo) }).range(note.def.markerFrom, note.def.markerTo));
    }
    if (note.def.bodyTo > note.def.bodyFrom) {
      ranges.push(Decoration.mark({ class: 'leaf-footnote-body' }).range(note.def.bodyFrom, note.def.bodyTo));
    }
    // A continuation line is held inside the definition by an indent nobody wrote
    // on purpose, and the grammar reads the line as code on top of that. Hide the
    // indent so the note reads as one paragraph rather than as a stray code block.
    if (!editing) {
      for (const indent of note.def.continuations) {
        ranges.push(Decoration.replace({}).range(indent.from, indent.to));
      }
    }
  }

  // Paired <sup>/<sub> collapse into a rendered widget while the caret is
  // outside them, so each span's range must suppress every nested decoration.
  // Tags are grouped by parent, matching how the inline parser lays them out.
  const groups = new Map();
  tree.iterate({ enter(node) {
    if (node.name !== 'HTMLTag') return;
    const classified = classifyInlineTag(doc.sliceString(node.from, node.to));
    if (!classified) return;
    const parent = node.node.parent;
    const key = parent ? `${parent.from}:${parent.name}` : 'root';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...classified, from: node.from, to: node.to });
  } });
  const inlineSpans = new Map();
  for (const tags of groups.values()) for (const span of pairInlineTags(tags)) inlineSpans.set(span.openFrom, span);

  let suppressUntil = -1;
  tree.iterate({
    enter(node) {
      if (node.from < suppressUntil) return false;
      const line = doc.lineAt(node.from);
      const heading = node.name.match(/^(?:ATX|Setext)Heading([1-6])$/);
      const yaml = view.state.field(structuredPreview).model.yaml;
      if (yaml && node.from < yaml.to && node.name !== 'Document') return false;

      const inline = inlineSpans.get(node.from);
      if (inline && !caretInRange(view.state, inline.openFrom, inline.closeTo)) {
        ranges.push(Decoration.replace({ widget: new InlinePreview(inline.openFrom, doc.sliceString(inline.openFrom, inline.closeTo)) }).range(inline.openFrom, inline.closeTo));
        suppressUntil = inline.closeTo;
        return false;
      }

      if (node.name === 'Paragraph' && node.node.parent?.name === 'Document') {
        const last = doc.lineAt(node.to).number;
        for (let n = line.number + 1; n <= last; n++) {
          ranges.push(Decoration.line({attributes:{class:'cm-leaf-paragraph-line'}}).range(doc.line(n).from));
        }
      }
      if (heading) {
        const details = numbers.get(node.from);
        const editing = caretInRange(view.state, node.from, node.to);
        ranges.push(
          Decoration.line({ attributes: { class: `cm-leaf-heading cm-leaf-heading-${heading[1]}`, ...(numbered && !editing ? { 'data-heading-number': details?.number ?? '' } : {}) } }).range(line.from),
        );
        if (numbered && !editing && details?.legacyPrefix) {
          ranges.push(Decoration.replace({}).range(details.legacyPrefix.from, details.legacyPrefix.to));
        }
      }
      // A definition's own label belongs to the line it opens, not to the text it
      // sits under, so the citation pass leaves it where it is.
      if (node.name === 'Link' && definitionLines.has(node.from)) return false;
      if (!caretInRange(view.state, node.from, node.to) && ['Link', 'Image', 'HorizontalRule'].includes(node.name)) {
        const raw = doc.sliceString(node.from, node.to);
        const signature = citationSignature(raw, noteNumbers);
        // A citation is not a link you can open, so it must not keep offering
        // "click to edit link" -- that promises an action the marker has not got.
        const title = node.name === 'Image' ? '点击编辑图片 · ⌘K 编辑替代文字与路径' : node.name === 'Link' && signature !== null ? '' : '点击编辑链接';
        const note = node.name === 'Link' ? citationLabel(raw, noteNumbers) : null;
        ranges.push(Decoration.replace({ widget: new InlinePreview(node.from, raw, { rule: node.name === 'HorizontalRule', title, footnotes, signature: signature ?? '', note }) }).range(node.from, node.to));
        return false;
      }

      // Delimiters stay hidden unless the caret is inside the construct they
      // belong to, so the rest of the line keeps its styling while you type.
      if (['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LeafHighlightMark'].includes(node.name) && !caretInParent(view.state, node)) {
        let to = node.to;
        if (node.name === 'HeaderMark' && doc.sliceString(to, to + 1) === ' ') to += 1;
        ranges.push(Decoration.replace({}).range(node.from, to));
      }

      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        const first = doc.lineAt(node.from).number, last = doc.lineAt(node.to).number;
        for (let n = first; n <= last; n++) {
          // Markdown's parser also calls indented footnote continuations code.
          // They remain note text, including while their source is being edited.
          if (index.notes.some(note => note.def && doc.line(n).from >= note.def.from && doc.line(n).from < note.def.to)) continue;
          const fence = node.name === 'FencedCode' && /^\s*(?:`{3,}|~{3,})/.test(doc.line(n).text);
          ranges.push(Decoration.line({attributes:{class:`cm-leaf-code-block${n === first ? ' cm-leaf-code-first' : ''}${n === last ? ' cm-leaf-code-last' : ''}${fence ? ' cm-leaf-code-fence' : ''}`}}).range(doc.line(n).from));
        }
      }
      if (node.name === 'InlineCode') {
        ranges.push(Decoration.mark({ class: 'cm-leaf-inline-code' }).range(node.from, node.to));
      }
      if (node.name === 'LeafHighlight') {
        ranges.push(Decoration.mark({ class: 'leaf-highlight' }).range(node.from, node.to));
      }
      if (node.name === 'Blockquote') {
        for (let n = line.number; n <= doc.lineAt(node.to).number; n++) {
          const first = n === doc.lineAt(node.from).number, last = n === doc.lineAt(node.to).number;
          const gap = /^\s*(?:>\s*)+$/.test(doc.line(n).text);
          ranges.push(Decoration.line({ attributes: { class: `cm-leaf-quote${first ? ' cm-leaf-quote-first' : ''}${last ? ' cm-leaf-quote-last' : ''}${gap ? ' cm-leaf-quote-gap' : ''}` } }).range(doc.line(n).from));
        }
      }
      if (node.name === 'QuoteMark' && !caretInParent(view.state, node)) {
        ranges.push(Decoration.replace({}).range(node.from, node.to));
      }
      if (node.name === 'TaskMarker') {
        ranges.push(Decoration.replace({ widget: new TaskCheckbox(node.from, /x/i.test(doc.sliceString(node.from, node.to))) }).range(node.from, node.to));
      }
    },
  });

  for (const visible of view.visibleRanges) {
    let line = doc.lineAt(visible.from);
    while (line.from <= visible.to) {
      // The last line is where the caret goes after a trailing newline, not a
      // blank line the writer left in the file, so it keeps a full row and the
      // document does not jump when the first character lands on it.
      if (!line.text.trim() && line.number < doc.lines && separatorBlank(view.state, line)) {
        // Every blank line keeps a compact row of its own, so a run of them reads
        // as that many rows. A blank that is literal text (source mode, a code
        // block, the attribute block) falls through and keeps its own height.
        ranges.push(Decoration.line({ attributes: { class: 'cm-leaf-blank-line' } }).range(line.from));
      }
      if (line.to >= doc.length) break;
      line = doc.line(line.number + 1);
    }
  }

  return Decoration.set(ranges, true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = livePreviewDecorations(view);
    }

    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.startState.field(sourceMode) !== update.state.field(sourceMode) || update.startState.field(blankMarkers) !== update.state.field(blankMarkers) || update.startState.field(headingNumbers) !== update.state.field(headingNumbers)) {
        this.decorations = livePreviewDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function inCodeBlock(state, pos) {
  let node = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(node.name)) return true;
    node = node.parent;
  }
  return false;
}

// Blank markers are display-only; code and document properties keep literal rows.
function separatorBlank(state, line) {
  if (state.field(sourceMode) || line.text.trim()) return false;
  if (inCodeBlock(state, line.from)) return false;
  const yaml = state.field(structuredPreview).model.yaml;
  if (yaml && line.from < yaml.to) return false;
  return true;
}

function exitEmptyList(view) {
  if (view.composing || view.state.selection.ranges.length !== 1) return false;
  const selection = view.state.selection.main;
  if (inCodeBlock(view.state, selection.head)) return false;
  const line = view.state.doc.lineAt(selection.head);
  if (!selection.empty || !/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+$/.test(line.text)) return false;
  const insert = line.number > 1 && view.state.doc.line(line.number - 1).text.trim() ? '\n' : '';
  view.dispatch({changes:{from:line.from,to:line.to,insert},selection:{anchor:line.from+insert.length},
    scrollIntoView:true,userEvent:'delete',annotations:isolateHistory.of('full')});
  return true;
}

function deleteFootnoteReference(view, forward = false) {
  const selection = view.state.selection.main;
  if (view.composing || !selection.empty || view.state.selection.ranges.length !== 1) return false;
  const ref = view.state.field(footnoteIndex).notes.flatMap(note=>note.refs)
    .find(ref => (forward ? ref.from : ref.to) === selection.head);
  if (!ref) return false;
  view.dispatch({changes:{from:ref.from,to:ref.to},selection:{anchor:ref.from},userEvent:'delete.selection',annotations:isolateHistory.of('full')});
  return true;
}

function clearListContinuation(view) {
  const selection = view.state.selection.main, line = view.state.doc.lineAt(selection.head);
  if (view.composing || view.state.selection.ranges.length !== 1) return false;
  for (let node=syntaxTree(view.state).resolveInner(selection.head,-1);node;node=node.parent) {
    if (node.name === 'FencedCode') return false;
  }
  if (!selection.empty || !/^[ \t]+$/.test(line.text)) return false;
  let previous = line.number - 1;
  while (previous > 0 && !view.state.doc.line(previous).text.trim()) previous--;
  if (!previous || !/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/.test(view.state.doc.line(previous).text)) return false;
  view.dispatch({changes:{from:line.from,to:line.to,insert:'\n'},selection:{anchor:line.from+1},
    scrollIntoView:true,userEvent:'input',annotations:isolateHistory.of('full')});
  return true;
}

function insertWritingTab(view) {
  if (view.state.field(sourceMode) || inCodeBlock(view.state,view.state.selection.main.head)) return indentMore(view);
  let node = syntaxTree(view.state).resolveInner(view.state.selection.main.head,-1);
  for (; node; node=node.parent) if (node.name === 'ListItem') return indentMore(view);
  if (!view.state.selection.main.empty) return indentMore(view);
  view.dispatch(view.state.replaceSelection('\t'),{scrollIntoView:true,userEvent:'input'});
  return true;
}

// The fold lives in editor state, so every change to it goes through here: the
// widget is rebuilt from that state after a scroll away, and a caller that
// poked `body.hidden` alone would be silently undone by the next rebuild.
function setPropertiesFolded(view, folded) {
  view.dispatch({effects: toggleProperties.of(folded)});
  const body = view.dom.querySelector('.leaf-property-body');
  if (body) body.hidden = folded;
  view.requestMeasure();
}

function focusNewProperty(view) {
  requestAnimationFrame(() => {
    const body = view.dom.querySelector('.leaf-property-body');
    if (body) { setPropertiesFolded(view, false); body.querySelector('[aria-label="添加文档属性"]')?.click(); }
  });
}

function openYamlProperties(view) {
  const source = view.state.doc.toString();
  if (!frontmatter(source)) {
    const from = 0, insert = '---\n\n---\n\n';
    view.dispatch({ changes: {from, insert},
      selection: {anchor: from + insert.length}, effects: renderBlock.of(0), userEvent: 'input', annotations: isolateHistory.of('full') });
  } else view.dispatch({effects: renderBlock.of(0), selection: {anchor: frontmatter(source).to}, scrollIntoView: true});
  focusNewProperty(view);
}

function insertYamlNewline(view) {
  const yaml = frontmatter(view.state.doc.toString());
  const {from, to} = view.state.selection.main;
  if (!yaml || from >= yaml.to) return false;
  view.dispatch({changes: {from, to, insert: '\n'}, selection: {anchor: from + 1}, userEvent: 'input'});
  return true;
}

function deleteLeafParagraphSeparator(view,forward=false) {
  if(view.composing || view.state.selection.ranges.length!==1)return false;
  const selection=view.state.selection.main;
  const source=view.state.doc.toString();
  const change=selection.empty ? paragraphDeletion(source,selection.head,forward) : selectedParagraphDeletion(source,selection.from,selection.to);
  if(!change)return false;
  view.dispatch({changes:change,selection:EditorSelection.cursor(change.from),scrollIntoView:true,
    userEvent:'delete',annotations:isolateHistory.of('full')});
  return true;
}

function wrapMark(view, left, right = left) {
  const range = view.state.selection.main;
  const selected = view.state.doc.sliceString(range.from, range.to);
  let insert;
  let anchor;

  if (selected.startsWith(left) && selected.endsWith(right) && selected.length >= left.length + right.length) {
    insert = selected.slice(left.length, selected.length - right.length);
    anchor = range.from + insert.length;
  } else {
    insert = `${left}${selected}${right}`;
    anchor = selected ? range.from + insert.length : range.from + left.length;
  }

  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(anchor),
    userEvent: 'input',
  });
  view.focus();
}

function transformLines(view, transform) {
  const range = view.state.selection.main;
  const startLine = view.state.doc.lineAt(range.from);
  const endLine = view.state.doc.lineAt(range.to);
  const source = view.state.doc.sliceString(startLine.from, endLine.to);
  const insert = source.split('\n').map(transform).join('\n');
  view.dispatch({
    changes: { from: startLine.from, to: endLine.to, insert },
    selection: EditorSelection.range(startLine.from, startLine.from + insert.length),
    userEvent: 'input',
  });
  view.focus();
}

function setHeadingLevel(view, level) {
  const { state } = view;
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from).number;
  const last = state.doc.lineAt(range.empty ? range.to : Math.max(range.from, range.to - 1)).number;
  const model = state.field(structuredPreview).model;
  const changes = [];
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    if (inCodeBlock(state, line.from) || model.blocks.some(b => line.from >= b.from && line.from < b.to)) continue;
    const heading = model.headings.find(h => h.from === line.from);
    const prefix = line.text.match(/^ {0,3}#{1,6}(?:[ \t]+|$)/)?.[0] ?? '';
    if (!range.empty && !line.text.trim()) continue;
    changes.push({ from: line.from, to: line.from + prefix.length, insert: level ? `${'#'.repeat(level)} ` : '' });
    // Convert Setext headings as a whole, not just their first text line.
    if (heading && !prefix && state.doc.lineAt(heading.to).number > n) {
      const end = state.doc.lineAt(heading.to);
      if (/^\s*(?:=+|-+)\s*$/.test(end.text)) {
        changes.push({ from: end.from - 1, to: end.to, insert: '' });
        n = end.number;
      }
    }
    if (prefix) {
      const closing = line.text.match(/[ \t]+#+[ \t]*$/);
      if (closing && closing.index >= prefix.length) changes.push({ from: line.from + closing.index, to: line.to, insert: '' });
    }
  }
  const changeSet = state.changes(changes);
  // Where the caret stands once the markers have moved. A caret inside a line's
  // marker region -- including one parked exactly at its start, in front of the
  // `#` -- belongs on the far side of the new marker, so that applying a level to
  // an empty line (or to a line whose start the caret is on) leaves the writer
  // ready to type the title instead of behind the hashes. Anywhere else keeps its
  // distance from the text it was in. The mapping cannot come from
  // `selection.map`: a position at the start of a *replaced* range always maps to
  // the near side there, whatever association it is given.
  const afterMarker = (pos) => {
    let shift = 0;
    for (const change of changes) {
      const inserted = change.insert.length;
      if (pos < change.from) break;
      if (pos <= change.to) return change.from + shift + inserted;
      shift += inserted - (change.to - change.from);
    }
    return pos + shift;
  };
  // A real selection keeps the default mapping, so its own span does not creep.
  const selection = range.empty ? EditorSelection.cursor(afterMarker(range.head)) : state.selection.map(changeSet);
  view.dispatch({ changes: changeSet, selection, userEvent: 'input' });
  view.focus();
}

// A callout keeps its words in a text area rather than in the document, so the
// caret the editor can see is not the one the writer is looking at. An insert has
// to be aimed at the box that owns the caret, or the marker lands wherever the
// document selection was last left -- outside the callout, on some other line.
let calloutCaret = null;

function calloutFieldOf(input) {
  if (!input || input.tagName !== 'TEXTAREA') return null;
  const root = input.closest('.leaf-callout-widget');
  if (!root?._widget) return null;
  return { input, block: root._widget.block, title: !!input.closest('.leaf-callout-title') };
}

// The box that owns the caret, found again rather than held on to: a callout is
// rebuilt whenever the document changes, so the text area that had the caret a
// moment ago may already be gone, while the block it belonged to has not moved.
function focusedCalloutField(view) {
  const live = calloutFieldOf(document.activeElement);
  if (live) return live;
  if (!calloutCaret) return null;
  const root = [...view.dom.querySelectorAll('.leaf-callout-widget')].find(node => node._widget?.block.from === calloutCaret.from);
  const wrap = root?.querySelector(`.leaf-callout-${calloutCaret.title ? 'title' : 'body'}`);
  const input = wrap?.querySelector('textarea');
  return input ? { input, block: root._widget.block, title: calloutCaret.title } : null;
}

// The one marker that stands for a note, found in the callout that holds it. It is
// looked up by the label rather than by a remembered offset: every edit between
// opening a note and closing it -- the renumber pass above all -- may have moved
// the block, while the marker itself reads the same wherever it landed.
function calloutRootOf(view, label) {
  const marker = `[^${label}]`;
  return [...view.dom.querySelectorAll('.leaf-callout-widget')]
    .find(root => root._widget && (root._widget.block.body.includes(marker) || root._widget.block.customTitle.includes(marker))) ?? null;
}

// The only way a footnote is written. The marker takes the selection's place,
// the definition is written among the definitions already in the file, and the
// numeric labels are renumbered to the numbers the reader will see, all in one
// transaction so one Cmd-Z puts the document back the way it was.
const insertedFootnoteAt = StateEffect.define({map: (position, changes) => changes.mapPos(position, 1)});
function dispatchFootnoteInsertion(view, changes, plan, select = true) {
  const tr = view.state.update({
    changes,
    effects: insertedFootnoteAt.of(plan.caret),
    ...(select ? {selection: EditorSelection.cursor(plan.caret), scrollIntoView: true} : {}),
    userEvent: 'input',
  });
  const caret = tr.effects.find(effect => effect.is(insertedFootnoteAt)).value;
  const note = tr.state.field(footnoteIndex).notes.find(note => note.refs.some(ref => ref.to === caret));
  view.dispatch(tr);
  return {label: note?.id ?? plan.label, caret};
}

function insertFootnote(view) {
  const field = focusedCalloutField(view);
  if (field) return insertFootnoteInCallout(view, field);
  const { from, to } = view.state.selection.main;
  const plan = planFootnoteInsertion(view.state.doc.toString(), from, to);
  const inserted = dispatchFootnoteInsertion(view, plan.changes, plan);
  view.focus();
  openFootnotePopup(view, inserted.label, inserted.caret);
}

// The same note, written from inside a callout. The marker belongs in the box the
// caret is in, and the definition still belongs among the definitions in the file,
// so the plan is made against the document and only the marker's own place is
// aimed at the box. One transaction, so one Cmd-Z takes back the marker and the
// definition together -- exactly as it does for a note inserted in the body.
function insertFootnoteInCallout(view, { input, block, title }) {
  const text = view.state.doc.toString();
  const start = input.selectionStart, end = input.selectionEnd;
  // The title and the body are laid out differently in the source, so each one
  // says where the caret is in its own terms; from there on the two are the same.
  const slot = title ? titleSlotInSource(block.raw) : null;
  const head = block.from + (slot ? slot.at + start : bodyToSource(block.raw, start));
  const tail = title ? head + (end - start) : block.from + bodyToSource(block.raw, end);
  const spaced = !!slot && !slot.spaced;
  const source = spaced ? `${text.slice(0, head)} ${text.slice(head)}` : text;
  const shift = offset => (spaced && offset >= head ? offset + 1 : offset);
  const unshift = offset => (spaced && offset > head ? offset - 1 : offset);
  const plan = planFootnoteInsertion(source, shift(head), shift(tail));
  // The space and the marker land on one offset, and a change set keeps two
  // insertions at a point in the order they were given: opening the title comes
  // first, so the marker lands after it rather than in front of it.
  const changes = spaced
    ? [{ from: head, to: head, insert: ' ' }, ...plan.changes.map(change => ({ ...change, from: unshift(change.from), to: unshift(change.to) }))]
    : plan.changes;
  const inserted = dispatchFootnoteInsertion(view, changes, plan, false);
  openFootnotePopup(view, inserted.label, null, () => calloutRootOf(view, footnoteBoxLabel)?.getBoundingClientRect() ?? null);
}

// A note is written where it is read: a box floats under the marker, so the caret
// never has to go looking for the definition at the far end of the file. The box
// is a plain element over the editor rather than a widget -- a widget lives inside
// a line and cannot float above what follows it. What is typed lands in the
// definition in the document, so the file keeps the shape it would have had if the
// note had been typed there, and the reading view follows along as words arrive.
let footnoteBox = null, footnoteBoxView = null, footnoteBoxAt = 0, footnoteBoxOutside = null;
let footnoteBoxAnchor = null, footnoteBoxLabel = null;
// Set by createLeafEditor: a click on an existing marker leaves the editor, and
// the host decides where the note is read -- the floating box is for the note
// being written now, an already-written note belongs to the notes panel.
let onNoteActivate = null;

function closeFootnotePopup() {
  if (!footnoteBox) return;
  window.removeEventListener('scroll', placeFootnotePopup, true);
  window.removeEventListener('resize', placeFootnotePopup);
  document.removeEventListener('mousedown', footnoteBoxOutside, true);
  footnoteBox.remove();
  footnoteBox = null; footnoteBoxView = null; footnoteBoxOutside = null; footnoteBoxAnchor = null; footnoteBoxLabel = null;
}

function placeFootnotePopup() {
  if (!footnoteBox) return;
  const view = footnoteBoxView;
  // A marker written inside a callout has no position in the document to be
  // measured at -- the whole block is one replaced range -- so the box that holds
  // it is what the note hangs under instead.
  const coords = footnoteBoxAnchor
    ? footnoteBoxAnchor()
    : view.coordsAtPos(Math.min(footnoteBoxAt, view.state.doc.length));
  if (!coords) return;
  const width = footnoteBox.offsetWidth || 320, height = footnoteBox.offsetHeight || 40;
  const left = Math.max(8, Math.min(coords.left, window.innerWidth - width - 8));
  const below = coords.bottom + 6;
  const top = below + height > window.innerHeight - 8 ? coords.top - height - 6 : below;
  footnoteBox.style.left = `${left}px`;
  footnoteBox.style.top = `${Math.max(8, top)}px`;
}

// The definition in the document is the only copy. An empty box still leaves a
// definition behind, so the marker and the note stay paired.
function applyFootnoteBody(view, label, body) {
  const text = view.state.doc.toString();
  const note = indexFootnotes(text).notes.find(candidate => candidate.id === label);
  if (!note) return;
  const changes = note.def
    ? [{ from: note.def.markerTo, to: note.def.bodyTo, insert: body.trim() ? ` ${footnoteBodyText(body)}` : '' }]
    : appendDefinition(text, label, body);
  view.dispatch({ changes, userEvent: 'input' });
}

function openFootnotePopup(view, label, pos, anchor = null) {
  closeFootnotePopup();
  const note = indexFootnotes(view.state.doc.toString()).notes.find(candidate => candidate.id === label);
  const box = document.createElement('div');
  box.className = 'footnote-box';
  const input = document.createElement('textarea');
  input.rows = 1; input.placeholder = '输入注释内容'; input.setAttribute('aria-label', '脚注内容');
  input.value = note?.def?.body ?? '';
  box.append(input);
  document.body.append(box);
  footnoteBox = box; footnoteBoxView = view; footnoteBoxAt = pos ?? 0; footnoteBoxAnchor = anchor; footnoteBoxLabel = label;

  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
    placeFootnotePopup();
  };
  input.addEventListener('input', () => { applyFootnoteBody(view, footnoteBoxLabel, input.value); grow(); });
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault();
      const currentLabel = footnoteBoxLabel;
      closeFootnotePopup();
      // Writing resumes where it started: the note that was written from a callout
      // gives the caret back to the callout, the way a note written from the body
      // gives it back to the sentence.
      if (!resumeCalloutNote(view, currentLabel)) view.focus();
    }
  });
  footnoteBoxOutside = event => {
    // The marker itself opens the box, so a click on it must not close the one it
    // just opened -- and it cannot, because that click never leaves the box.
    if (!box.contains(event.target)) closeFootnotePopup();
  };
  document.addEventListener('mousedown', footnoteBoxOutside, true);
  window.addEventListener('scroll', placeFootnotePopup, true);
  window.addEventListener('resize', placeFootnotePopup);
  requestAnimationFrame(() => {
    grow();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

// Hand the caret back to the box the marker was written in, on the character just
// after it. Returns false when the marker is not in a callout, which is the
// document's own case.
function resumeCalloutNote(view, label) {
  const root = calloutRootOf(view, label);
  if (!root) return false;
  const marker = `[^${label}]`;
  const field = root._widget.block.body.includes(marker) ? 'body' : 'title';
  const wrap = root.querySelector(`.leaf-callout-${field}`);
  const input = wrap?.querySelector('textarea');
  if (!input) return false;
  wrap.classList.add('is-editing');
  input.focus();
  const at = input.value.indexOf(marker);
  const caret = at < 0 ? input.value.length : at + marker.length;
  input.setSelectionRange(caret, caret);
  view.requestMeasure();
  return true;
}

function formatEditor(view, type) {
  if (type.startsWith('callout-')) {
    const kind=type.slice(8);if(!calloutLabels[kind])return;
    const {doc,selection}=view.state,range=selection.main;
    const first=doc.lineAt(range.from),last=doc.lineAt(range.to>range.from&&doc.lineAt(range.to).from===range.to?range.to-1:range.to);
    const from=range.empty?first.to:first.from,to=range.empty?from:last.to;
    // Whole selected lines retain their Markdown (including nested lists/code).
    const content=range.empty?'内容':doc.sliceString(from,to);
    const prefix=from>0?'\n\n':'';
    const header=`> [!${kind}]`,insert=prefix+header+'\n'+content.split('\n').map(line=>'> '+line).join('\n')+'\n\n';
    const start=from+prefix.length;
    view.dispatch({changes:{from,to,insert},effects:renderBlock.of(start),
      selection:{anchor:start},userEvent:'input',annotations:isolateHistory.of('full')});
    view.focus();
    requestAnimationFrame(() => {
      const input = [...view.dom.querySelectorAll('.leaf-callout-widget')].find(root => root._widget?.block.from === start)?.querySelector('textarea');
      input?.parentElement.classList.add('is-editing'); input?.focus(); input?.select();
    });
    return;
  }
  if (type === 'footnote') return insertFootnote(view);
  const marks = {
    bold: ['**', '**'],
    italic: ['*', '*'],
    strike: ['~~', '~~'],
    code: ['`', '`'],
    codeblock: ['```\n', '\n```'],
    // Obsidian renders superscript/subscript from HTML tags, not ^x^ / ~x~.
    sup: ['<sup>', '</sup>'],
    sub: ['<sub>', '</sub>'],
  };
  if (marks[type]) return wrapMark(view, ...marks[type]);
  if (/^heading[0-6]$/.test(type)) return setHeadingLevel(view, Number(type.at(-1)));
  if (type === 'quote') return transformLines(view, (line) => line.startsWith('> ') ? line.slice(2) : `> ${line}`);
  if (type === 'bullet') return transformLines(view, (line) => /^[-*+]\s+/.test(line) ? line.replace(/^[-*+]\s+/, '') : `- ${line}`);
  if (type === 'ordered') {
    let index = 0;
    return transformLines(view, (line) => {
      index += 1;
      return /^\d+\.\s+/.test(line) ? line.replace(/^\d+\.\s+/, '') : `${index}. ${line}`;
    });
  }
  if (type === 'table') {
    const range = view.state.selection.main;
    const table = '| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |';
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: table },
      selection: EditorSelection.cursor(range.from + table.length),
      userEvent: 'input',
    });
    view.focus();
  }
}

// Describe selected source lines, not the last heading above the caret.
function selectionHeadingLevel(state) {
  const headings = state.field(structuredPreview).model.headings;
  let selected;
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.empty ? range.to : range.to - 1).number;
    for (let number = first; number <= last; number++) {
      const line = state.doc.line(number);
      const level = headings.find(h => h.from <= line.to && h.to >= line.from)?.level ?? 0;
      if (selected !== undefined && selected !== level) return null;
      selected = level;
    }
  }
  return selected ?? 0;
}

export function createLeafEditor(options) {
  const historyCompartment = new Compartment();
  const setLineEnding = StateEffect.define();
  const endingOf = value => /\r\n/.test(value) ? '\r\n' : '\n';
  const lineEnding = StateField.define({
    create: () => endingOf(options.doc || ''),
    update(value, tr) { for (const effect of tr.effects) if (effect.is(setLineEnding)) value = effect.value; return value; },
  });
  const sourceOf = state => state.doc.sliceString(0, state.doc.length, state.field(lineEnding));
  let suppressChanges = false;
  let reading = false;
  onNoteActivate = options.onNoteActivate ?? null;
  // Which callout box owns the caret is noted as the focus moves, because the
  // editor's own selection knows nothing about the text areas a callout is written
  // in. Leaving the box -- for the toolbar, which takes the focus on its way in --
  // must not lose it, while a caret put back in the document does end it.
  window.addEventListener('focusin', event => {
    const field = calloutFieldOf(event.target);
    if (field) calloutCaret = { from: field.block.from, title: field.title };
    else if (event.target?.closest?.('.cm-content')) calloutCaret = null;
  }, true);
  // A widget takes its own events, so the editor's keymap never sees a key pressed
  // inside a callout -- which is what keeps Enter and Backspace meaning what they
  // mean in a text area. The one shortcut worth reaching past that for is this one:
  // half of what it does, the definition, is written into the document, outside the
  // box that has the caret. It mirrors the "Mod-Shift-f" binding below and answers
  // only when a box owns the caret, so the document keeps the editor's keymap.
  window.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
    if (event.key.toLowerCase() !== 'f' || !focusedCalloutField(view)) return;
    event.preventDefault();
    insertFootnote(view);
  }, true);

  const editorTheme = EditorView.theme({
    '&': { height: '100%' },
    '.cm-scroller': { overflow: 'auto' },
    '.cm-content': { minHeight: '100%' },
  });

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.transactions.some(tr => tr.effects.some(effect => effect.is(typedProperties)))) focusNewProperty(update.view);
    if (update.docChanged && !suppressChanges) {
      const labels = footnoteLabelMap(update.startState.field(footnoteIndex), update.state.field(footnoteIndex), update.changes);
      if (footnoteBox && footnoteBoxView === update.view) {
        footnoteBoxLabel = labels.get(footnoteBoxLabel) ?? footnoteBoxLabel;
        footnoteBoxAt = update.changes.mapPos(footnoteBoxAt, 1);
        if (!update.state.field(footnoteIndex).notes.some(note => note.id === footnoteBoxLabel)) closeFootnotePopup();
      }
      options.onChange?.(sourceOf(update.state), labels);
    }
    if (update.docChanged || update.selectionSet) {
      const head = update.state.selection.main.head;
      const line = update.state.doc.lineAt(head);
      options.onCursor?.({ line: line.number, column: head - line.from + 1, headingLevel: selectionHeadingLevel(update.state) });
      options.onOutlineChange?.(update.state.doc.toString());
    }
    // While text is selected the current-line band is dropped (style.css): it is
    // painted over the selection, so keeping it would tint the selection's rows
    // on the caret's line and draw a third band where the two overlap.
    if (update.selectionSet) {
      update.view.dom.classList.toggle('leaf-selection', !update.state.selection.main.empty);
    }
  });

  const appKeymap = keymap.of([
    { key: 'Mod-e', run: () => (options.onExport?.(), true) },
    { key: 'Mod-Shift-s', run: () => (options.onSaveAs?.(), true) },
    { key: 'Mod-s', run: () => (options.onSave?.(), true) },
    { key: 'Mod-o', run: () => (options.onOpen?.(), true) },
    { key: 'Mod-p', run: () => (options.onCommandPalette?.(), true) },
    { key: 'Mod-f', run: openSearchPanel },
    { key: 'Mod-b', run: (view) => (formatEditor(view, 'bold'), true) },
    { key: 'Mod-i', run: (view) => (formatEditor(view, 'italic'), true) },
    { key: 'Mod-Shift-x', run: (view) => (formatEditor(view, 'strike'), true) },
    { key: 'Mod-.', run: (view) => (formatEditor(view, 'sup'), true) },
    { key: 'Mod-,', run: (view) => (formatEditor(view, 'sub'), true) },
    { key: 'Mod-Shift-f', run: (view) => (formatEditor(view, 'footnote'), true) },
    { key: 'Mod-Shift-7', run: (view) => (formatEditor(view, 'ordered'), true) },
    { key: 'Mod-Shift-8', run: (view) => (formatEditor(view, 'bullet'), true) },
    ...Array.from({ length: 7 }, (_, level) => ['Alt', 'Mod-Alt'].map(modifier => ({
      key: `${modifier}-${level}`,
      run: (view) => (formatEditor(view, `heading${level}`), true),
    }))).flat(),
    { key: 'Backspace', run: view => !view.state.field(sourceMode) && (deleteFootnoteReference(view) || exitEmptyList(view) || deleteLeafParagraphSeparator(view) || deleteMarkupBackward(view)) },
    { key: 'Delete', run: view => !view.state.field(sourceMode) && (deleteFootnoteReference(view,true) || deleteLeafParagraphSeparator(view,true)) },
    {
      key: 'Enter',
      run: (view) => !view.state.field(sourceMode) && (insertYamlNewline(view) || clearListContinuation(view) || insertNewlineContinueMarkup(view)),
    },
    { key: 'Tab', run: insertWritingTab },
    { key: 'Shift-Tab', run: indentLess },
  ]);

  const state = EditorState.create({
    doc: options.doc || '',
    extensions: [
      lineNumberCompartment.of(options.showLineNumbers ? leafLineNumbers() : []),
      historyCompartment.of(history()),
      lineEnding,
      invertedEffects.of(tr => tr.effects.some(effect => effect.is(setLineEnding)) ? [setLineEnding.of(tr.startState.field(lineEnding))] : []),
      drawSelection(),
      leafSelection,
      dropCursor(),
      highlightActiveLine(),
      bracketMatching(),
      markdown({ extensions: leafMarkdownExtensions, addKeymap: false }),
      sourceMode,
      fileNameTitle.init(() => options.showFileNameTitle !== false),
      structuredPreview,
      propertiesFolded,
      footnoteIndex,
      // Registered before the reading-mode filter below, which runs first: a
      // document that is only being read has no edit for this one to follow.
      footnoteRenumber,
      footnoteReferenceDeletion,
      footnoteLabelFollow,
      orderedListRenumber,
      outlineFolding,
      blankMarkers.init(() => !!options.showBlankMarkers),
      headingNumbers.init(() => !!options.showHeadingNumbers),
      search({ top: true, createPanel: view => new LeafSearchPanel(view) }),
      EditorState.phrases.of({
        Find: '查找',
        Replace: '替换为',
        next: '下一处',
        previous: '上一处',
        all: '全选',
        'match case': '大小写',
        regexp: '正则',
        'by word': '整词',
        replace: '替换',
        'replace all': '全部替换',
        close: '关闭',
      }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      syntaxHighlighting(leafHighlightStyle),
      // macOS Option+number produces symbols (e.g. ¡), not event.key "1".
      // Match the physical number row, without intercepting IME composition.
      EditorView.domEventHandlers({
        copy(event, view) {
          if (!view.state.selection.ranges.every(range => range.empty)) return false;
          event.preventDefault(); return true;
        },
        cut(event, view) {
          if (!view.state.selection.ranges.every(range => range.empty)) return false;
          event.preventDefault(); return true;
        },
        keydown(event, view) {
        if (event.isComposing || !event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false;
        const digit = /^Digit([0-6])$/.exec(event.code);
        if (!digit) return false;
        event.preventDefault();
        setHeadingLevel(view, Number(digit[1]));
        return true;
      } }),
      appKeymap,
      // Complete the delimiters before any rendering/atomic selection pass.
      // An intermediate opening delimiter could otherwise consume the article
      // up to a later horizontal rule and replace it with one giant YAML widget.
      EditorState.transactionFilter.of(tr => {
        if (suppressChanges || tr.startState.field(sourceMode) || tr.startState.field(structuredPreview).yamlSource
          || !tr.docChanged || !tr.isUserEvent('input.type')
          || tr.newDoc.line(1).text !== '---' || frontmatter(tr.startState.doc.toString())) return tr;
        let openingTyped = false;
        tr.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
          if (toB === 3 && fromB < 3 && /^-{1,3}$/.test(inserted.toString())) openingTyped = true;
        });
        if (!openingTyped) return tr;
        return [tr, {changes:{from:3, insert:'\n\n---\n'}, selection:{anchor:9},
          effects:[renderBlock.of(0), typedProperties.of(null)], sequential:true,
          annotations:isolateHistory.of('full')}];
      }),
      EditorState.transactionFilter.of(tr => {
        if (suppressChanges || !tr.docChanged || !tr.isUserEvent('delete')) return tr;
        const yaml = frontmatter(tr.startState.doc.toString());
        if (!yaml) return tr;
        let removed = false;
        tr.changes.iterChanges((from, to, _a, _b, inserted) => {
          if (from === 0 && to >= yaml.to && !inserted.length) removed = true;
        });
        const leading = removed && /^(?:[ \t]*\r?\n)+/.exec(tr.newDoc.toString());
        return leading ? [tr, {changes:{from:0,to:leading[0].length},sequential:true}] : tr;
      }),
      EditorState.transactionFilter.of(tr => reading && tr.docChanged && !suppressChanges ? [] : tr),
      keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]),
      livePreview,
      updateListener,
      editorTheme,
      EditorView.lineWrapping,
    ],
  });

  const view = new EditorView({ state, parent: options.parent });
  view.dom.addEventListener("leaf-image-ready", () => view.requestMeasure());


  return {
    view,
    setReading(value) { reading = value; },
    createProperties() { openYamlProperties(view); },
    // The region is a block widget, so it is only in the DOM while it is near
    // the viewport. The fold is kept in editor state, which is what makes this
    // answerable at any scroll position: reading the DOM instead reported a
    // scrolled-away region as folded. A document without frontmatter has no
    // region to report on, so it reads as off and checking the switch is what
    // builds one.
    propertiesExpanded() {
      return !!frontmatter(view.state.doc.toString()) && !view.state.field(propertiesFolded);
    },
    setPropertiesVisible(visible) {
      // Source mode draws the properties as YAML text, and a document without
      // frontmatter has no region at all, so there is nothing to show or fold.
      if (view.state.field(sourceMode, false) || !frontmatter(view.state.doc.toString())) return null;
      setPropertiesFolded(view, !visible);
      // Unfolding brings the rows back into view: they only ever sit at the top
      // of the document, so a caret left mid-document would otherwise see
      // nothing happen. The scroll goes through a transaction, because the
      // measure pass that follows the DOM change overrides a plain scrollTop.
      if (visible) view.dispatch({effects: EditorView.scrollIntoView(0, {y: 'start'})});
      return visible;
    },
    revealProperties() {
      view.dispatch({effects:[renderBlock.of(0), toggleProperties.of(false)],selection:{anchor:0},scrollIntoView:true});
      view.scrollDOM.scrollTop=0;
      view.focus();
      // The field is already unfolded by the transaction above; this reaches a
      // widget that was on screen the whole time and so was never rebuilt.
      requestAnimationFrame(()=>{ if(view.dom.querySelector('.leaf-property-body'))setPropertiesFolded(view,false); });
    },
    setSource(value) {
      closeFootnotePopup(); unfoldAll(view);
      view.dispatch({ effects: setSourceMode.of(value) });
      view.dom.classList.toggle('cm-source-mode', value); view.focus();
    },
    getValue: () => sourceOf(view.state),
    setHeadingNumbers(show) { view.dispatch({ effects: toggleHeadingNumbers.of(show) }); },
    setFileNameTitle(show) { view.dispatch({effects:toggleFileNameTitle.of(show)}); },
    setFileName(name) {
      if (view.state.field(structuredPreview).name !== name) view.dispatch({ effects: documentName.of(name) });
    },
    setValue(value) {
      suppressChanges = true;
      // A newly opened/reloaded document must never undo into the previous file.
      // The replacement has to be dispatched before the history is dropped and
      // re-installed: a compartment reconfigured in the same transaction as the
      // change still sees that change, so the other order leaves the replacement
      // sitting at the bottom of the fresh history and one undo walks back into
      // the old document.
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: EditorSelection.cursor(0),
        effects: [documentName.of(view.state.field(structuredPreview).name), setLineEnding.of(endingOf(value)), toggleProperties.of(false)],
        scrollIntoView: true,
      });
      view.dispatch({ effects: historyCompartment.reconfigure([]) });
      view.dispatch({ effects: historyCompartment.reconfigure(history()) });
      suppressChanges = false;
      options.onOutlineChange?.(value);
    },
    restoreValue(value) {
      // Restoration is one edit in this document, never a fresh document load.
      // Filters must not renumber or otherwise normalize the stored source.
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value },
        effects: setLineEnding.of(endingOf(value)),
        selection: EditorSelection.cursor(0), filter: false,
        userEvent: 'input.restore', annotations: isolateHistory.of('full') });
      view.focus();
    },
    setLineNumbers(show) {
      view.dispatch({
        effects: lineNumberCompartment.reconfigure(show ? leafLineNumbers() : []),
      });
    },
    focus: () => view.focus(),
    renameHeading(number, original, title) {
      if(number<1||number>view.state.doc.lines||!title.trim()||/[\r\n]/.test(title))return false;
      const line=view.state.doc.line(number);
      if(line.text!==original)return false;
      const match=/^(#{1,6}[ \t]+)(.*?)([ \t]+#+[ \t]*)?$/.exec(original);
      if(!match)return false;
      view.dispatch({changes:{from:line.from+match[1].length,to:line.to-(match[3]?.length??0),insert:title.trim()},
        userEvent:'input',annotations:isolateHistory.of('full')});
      return true;
    },
    setBlankMarkers(show) { view.dispatch({effects:toggleBlankMarkers.of(show)}); },
    tidyBlankLines() {
      const changes=paragraphBlankLineChanges(view.state.doc.toString());
      if (changes.length) view.dispatch({changes, userEvent:'input', annotations:isolateHistory.of('full')});
      return changes.length;
    },
    openSearch: () => openSearchPanel(view),
    format: (type) => formatEditor(view, type),
    // Driven by the application menu: on macOS the menu owns Cmd-Z, so the
    // key never reaches the editor's own historyKeymap binding.
    undo: () => undo(view),
    redo: () => redo(view),
    // Drives the toolbar buttons' disabled state.
    historyDepth: () => ({ undo: undoDepth(view.state), redo: redoDepth(view.state) }),
    headingLevel: () => selectionHeadingLevel(view.state),
    goToLine(number) {
      const line = view.state.doc.line(Math.max(1, Math.min(number, view.state.doc.lines)));
      view.dispatch({
        selection: EditorSelection.cursor(line.from),
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      });
      view.focus();
    },
    // The notes panel writes through here rather than keeping a copy of the note:
    // what it shows and what the file holds are the same words, so the reading
    // view and the PDF follow the panel as it is typed into.
    setFootnoteBody(label, body) { applyFootnoteBody(view, label, body); },
    deleteFootnote(label) {
      if (reading) return false;
      const changes = planFootnoteDeletion(view.state.doc.toString(), label);
      if (!changes.length) return false;
      closeFootnotePopup();
      view.focus();
      view.dispatch({changes, userEvent:'delete.footnote', annotations:isolateHistory.of('full')});
      return true;
    },
    renumberFootnotes() { view.dispatch({userEvent: 'input.footnote-renumber', annotations: isolateHistory.of('full')}); },
    // The reverse of a click on a marker: put the citation back in front of the
    // reader. The caret is left where it is -- moving it onto the marker would
    // print the raw "[^1]" under it, which is not what was asked for.
    goToNote(label) {
      const note = indexFootnotes(view.state.doc.toString()).notes.find(candidate => candidate.id === label);
      const at = note?.refs[0]?.from ?? note?.def?.markerFrom;
      if (at === undefined) return false;
      view.dispatch({ effects: EditorView.scrollIntoView(at, { y: 'center' }) });
      view.focus();
      return true;
    },
    destroy() {
      view.destroy();
    },
  };
}
