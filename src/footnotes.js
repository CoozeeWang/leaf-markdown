// Footnotes have no support in the parser Leaf ships: @lezer/markdown 1.7.2
// exports Table, TaskList, Strikethrough, Autolink, Emoji and the Pandoc
// super/sub extensions, but nothing for footnotes. The base grammar also
// misreads the syntax -- "[^1]: text" satisfies the link reference definition
// rule, which swallows the marker line whole, and the indented continuation
// line below it parses as a CodeBlock, so a multi-line footnote currently
// renders its tail as a code block in the reading view and the PDF.
//
// So this module indexes footnotes from the raw text with a line scanner and
// consults the tree only to learn which ranges are code. Everything here is a
// pure function of the document string: the editor, the reading view and the
// PDF each re-run it on every render, and no offset is ever carried across an
// edit, because inserting one line at the top of a file moves every definition.
import {parser} from '@lezer/markdown';
import {leafMarkdownExtensions} from './markdown-extensions.js';
import {frontmatter} from './markdown-model.js';

const parserInstance = parser.configure(leafMarkdownExtensions);

// GFM requires a definition's continuation lines to be indented by a tab or
// four spaces, the same rule that governs list item content; anything less
// starts a new block. Keep these in step with INDENT below.
const INDENT = '    ';
const CONTINUES = /^(?:\t| {4})/;
const MARKER = /^( {0,3})\[\^([^\[\]\r\n]+)\]:([ \t]*)/;
const REFERENCE = /\[\^([^\[\]\r\n]+)\]/g;
const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'URL', 'HTMLTag']);
const FENCE_NODES = new Set(['FencedCode']);

export function indexFootnotes(text, tree = parserInstance.parse(text)) {
  const lines = linesOf(text);
  // Definitions are scanned against fences only. An indented continuation line
  // is reported as a CodeBlock by the parser, so masking every code range up
  // front would hide the very lines this scanner has to consume.
  const yaml = frontmatter(text);
  const metadata = yaml ? [{from: yaml.from, to: yaml.to}] : [];
  const definitions = scanDefinitions(text, lines, [...metadata, ...rangesOf(tree, FENCE_NODES)].sort(byFrom));
  const body = definitions.map(def => ({from: def.from, to: def.to}));
  const references = scanReferences(text, lines, [...metadata, ...rangesOf(tree), ...body].sort(byFrom));
  // The Markdown parser mistakes definition bodies for link destinations or
  // indented code. Parse each de-indented body separately, then map real
  // citations back to source offsets; code examples must never be renumbered.
  for (const def of definitions) {
    const bodyLines = linesOf(def.body);
    const refs = scanReferences(def.body, bodyLines, rangesOf(parserInstance.parse(def.body)));
    for (const ref of refs) {
      const original = lines[def.line + ref.line - 2];
      const start = ref.line === 1 ? def.bodyFrom : original.from + indentationOf(original.text);
      const offset = start - bodyLines[ref.line - 1].from;
      references.push({...ref, from: ref.from + offset, to: ref.to + offset, line: def.line + ref.line - 1});
    }
  }
  references.sort(byFrom);

  const notes = new Map();
  const referenced = [];
  for (const reference of references) {
    let note = notes.get(reference.id);
    if (!note) {
      note = {id: reference.id, number: null, state: 'unreferenced', refs: [], def: null};
      notes.set(reference.id, note);
      referenced.push(reference.id);
    }
    note.refs.push(reference);
  }

  const warnings = [];
  for (const def of definitions) {
    let note = notes.get(def.id);
    if (!note) {
      note = {id: def.id, number: null, state: 'unreferenced', refs: [], def: null};
      notes.set(def.id, note);
    }
    if (note.def) { warnings.push({code: 'duplicate-definition', id: def.id, line: def.line}); continue; }
    note.def = def;
  }

  // The number is the position of the first reference in the body, not the
  // label and not the definition's spot, so writing [^note] still prints as 1.
  referenced.forEach((id, index) => {
    const note = notes.get(id);
    note.number = index + 1;
    note.state = note.def ? 'complete' : 'undefined';
  });
  const unreferenced = [...notes.values()]
    .filter(note => note.number === null)
    .sort((a, b) => a.def.from - b.def.from);

  // The definition blocks are handed back raw as well: a renderer has to blank
  // every one of them out of the flow, including an orphan nobody cites and a
  // duplicate that lost the id, and those are exactly the two that do not
  // survive into `notes`.
  return {notes: [...referenced.map(id => notes.get(id)), ...unreferenced], warnings, definitions};
}

// ------------------------------------------------------------------ writing

// The number a reader sees is the position of a note's first citation among the
// notes that have a definition at all. Nothing in the file records it, so both
// the editor and the reading view derive it here rather than trusting the label
// written next to the note -- one shared rule is the only thing keeping the two
// views agreeing.
//
// A citation whose definition has not been written yet is printed as its literal
// marker rather than as a number pointing at nothing, so it must not consume a
// slot either: numbering it would make the list read 1, 3, 4.
//
// `map` is keyed by the label as written (no trimming -- matching is exact) and
// `list` is ordered by the number, which is the order the notes must be printed.
export function displayNotes(index) {
  const map = new Map(), list = [];
  for (const note of index.notes) {
    if (!note.def || note.number === null) continue;
    const entry = {label: note.id, number: list.length + 1, body: note.def.body};
    list.push(entry);
    map.set(note.id, entry);
  }
  return {map, list};
}

// What a notes panel lists, in the order a reader meets the notes. Numbered
// notes come first; the ones the document has lost track of follow -- a
// definition nobody cites any more, or a citation whose definition was never
// written. Both still stand for words the author wrote, so neither is dropped
// from the list, and `state` tells a caller how to label them.
export function notePanelRows(index) {
  const { list } = displayNotes(index);
  const rows = list.map(entry => ({ label: entry.label, number: entry.number, body: entry.body, state: 'complete' }));
  // "Not listed" is not the same as "has no number": a citation waiting for its
  // definition is handed a position among the cited notes and then left out of
  // the list, so `displayNotes` -- not the number -- is what says who is printed.
  const listed = new Set(list.map(entry => entry.label));
  for (const note of index.notes) {
    if (listed.has(note.id)) continue;
    rows.push({ label: note.id, number: null, body: note.def?.body ?? '', state: note.def ? 'unreferenced' : 'undefined' });
  }
  return rows;
}

function displayNumbers(index) {
  const numbers = new Map();
  for (const [id, entry] of displayNotes(index).map) numbers.set(id, entry.number);
  return numbers;
}

// Explicit deletion is distinct from removing a citation while moving prose.
// Remove all real uses and duplicate definitions, never examples inside code.
export function planFootnoteDeletion(text, label) {
  const index = indexFootnotes(text);
  const note = index.notes.find(note => note.id === label);
  if (!note) return [];
  const ranges = [
    ...note.refs.map(ref => ({from: ref.from, to: ref.to})),
    ...index.definitions.filter(def => def.id === label).map(def => ({from: def.lineFrom, to: def.to})),
  ].sort(byFrom);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({...range, insert: ''});
  }
  return merged;
}

// A label the document does not use yet. It only has to survive long enough for
// the renumber pass to give it its real number, so digits keep it inside the
// set that pass is allowed to rewrite.
function freeLabel(index) {
  const used = new Set(index.notes.map(note => note.id));
  let next = index.notes.length + 1;
  while (used.has(String(next))) next++;
  return String(next);
}

// Where a definition belongs among the ones the file already has: immediately
// before the definition of the next note a reader meets. A note's number comes
// from the order of its citations, never from the file, so a note inserted in the
// middle of a sentence is numbered in the middle -- and if its definition were
// appended at the end, the file would list the notes in an order nobody wrote.
// Returns null when no later note has a definition, which is the one case that
// leaves the block at the far end of the document.
function definitionSlot(index, from) {
  for (const note of index.notes) {
    if (!note.def || note.number === null) continue;
    if (note.refs[0].from < from) continue;
    return note.def.lineFrom;
  }
  return null;
}

// Plan an insert at the caret: the marker takes the selection's place, the
// definition is written among the definitions already there (at the end of the
// document when there are none after it), and every numeric label is rewritten to
// the number its note now displays. Everything comes back as one change set, so
// the whole thing is a single undo step.
export function planFootnoteInsertion(text, from = 0, to = from) {
  const index = indexFootnotes(text);
  let start = Math.min(from, to);
  let end = Math.max(from, to);
  // A caret parked inside a citation, or inside the marker of a definition,
  // would split it in half; landing just after it keeps both readable. A
  // definition has to begin its line, so its own start counts as inside.
  if (start === end) {
    const marks = index.notes.flatMap(note => [
      ...note.refs.map(ref => ({from: ref.from, to: ref.to, lineBound: false})),
      ...(note.def ? [{from: note.def.markerFrom, to: note.def.markerTo, lineBound: true}] : []),
    ]);
    const inside = marks.find(mark => (mark.lineBound ? mark.from <= start : mark.from < start) && start < mark.to);
    if (inside) start = end = inside.to;
  }
  const placeholder = freeLabel(index);
  // A selection is carried into the note trimmed: a body that opens or closes
  // with the whitespace around the words renders as an empty line. Only the
  // words themselves are replaced, so selecting a line together with the
  // newline that ends it does not glue the next line onto the marker.
  const selected = text.slice(start, end);
  const body = selected.trim();
  const replaceFrom = body ? start + (selected.length - selected.trimStart().length) : start;
  const replaceTo = body ? end - (selected.length - selected.trimEnd().length) : start;

  let trimmed = text.length;
  while (trimmed > 0 && ' \t\r\n'.includes(text[trimmed - 1])) trimmed--;
  // The tail of the document is where the definition goes when nothing follows
  // the note; it is never placed inside the words being replaced, so the two
  // edits cannot overlap.
  const blockFrom = Math.max(trimmed, end);
  const separator = replaceFrom >= blockFrom ? '\n\n' : gapBefore(text.slice(0, blockFrom));
  // A note written in the middle of a sentence belongs in the middle of the
  // definitions as well, so its block takes the line of the definition that
  // follows it. A caret sitting on that very line has nowhere to put the block
  // without splitting what is already there, and the end of the document is then
  // the only place certainly free.
  const slot = definitionSlot(index, replaceFrom);
  const at = slot !== null && (slot < replaceFrom || slot > replaceTo) ? slot : null;
  const write = label => {
    const block = footnoteDefinitionText(label, body);
    return [
      {from: replaceFrom, to: replaceTo, insert: `[^${label}]`},
      at === null
        ? {from: blockFrom, to: text.length, insert: `${separator}${block}`}
        : {from: at, to: at, insert: `${block}\n`},
    ];
  };

  // Numbers follow the order the citations appear in, which does not depend on
  // the labels, so they can be read off a draft written with a placeholder. A
  // caret that lands immediately before a colon turns the placeholder into text
  // the scanner reads as a marker, leaving the new note without a citation, and
  // then there is nothing to promise.
  const numbers = displayNumbers(indexFootnotes(applyChanges(text, write(placeholder))));
  const counted = numbers.get(placeholder);
  const desired = counted === undefined ? placeholder : String(counted);

  let blocked = counted === undefined;
  const kept = new Set();
  const pending = [];
  for (const note of index.notes) {
    if (!/^[0-9]+$/.test(note.id)) continue;
    const want = numbers.get(note.id);
    const next = want === undefined ? null : String(want);
    if (next === null || next === note.id) { kept.add(note.id); continue; }
    pending.push({next, ranges: labelRanges(note, index)});
  }

  // Every rename has to be expressible on the original text: a label inside the
  // selection, or inside the tail being replaced, cannot be rewritten
  // separately. And a numeric citation with no definition already owns its
  // number as a bare string, so renaming on top of it would merge two notes.
  const taken = new Set(kept);
  const edits = [{from: replaceFrom, to: replaceTo}, at === null ? {from: blockFrom, to: text.length} : {from: at, to: at}];
  for (const {next, ranges} of pending) {
    if (taken.has(next) || ranges.some(range => edits.some(edit => range.from < edit.to && edit.from < range.to))) {
      blocked = true;
      break;
    }
    taken.add(next);
  }
  if (kept.has(desired)) blocked = true;

  let label = blocked ? placeholder : desired;
  let renames = blocked ? [] : pending.flatMap(({next, ranges}) => ranges.map(range => ({...range, insert: next})));
  let changes = mergeAdjacent([...write(label), ...renames].sort(byFrom));

  // The renames reason about the document as text, and a marker can change
  // meaning under the edit: "[^2]:" reads as a definition's own marker, and the
  // same characters turn into a citation the moment the colon behind them is
  // replaced. So the result is checked rather than trusted, and a document that
  // will not settle keeps the labels its author wrote.
  if (!blocked && !labelsMatchNumbers(applyChanges(text, changes))) {
    blocked = true;
    label = placeholder;
    renames = [];
    changes = mergeAdjacent(write(label).sort(byFrom));
  }

  const marker = `[^${label}]`;
  // The caret stays on the sentence, just past the marker: the note itself is
  // written in the box that opens there, not at the far end of the document. A
  // definition that lands in front of the caret pushes it along, like any other
  // edit; one that lands behind it leaves the sentence alone.
  const shifts = [...renames];
  if (at !== null && at < replaceFrom) shifts.push({from: at, to: at, insert: `${footnoteDefinitionText(label, body)}\n`});
  return {
    changes,
    caret: shiftOffset(shifts.sort(byFrom), replaceFrom) + marker.length,
    label,
    body,
    renumbered: renames.length > 0,
    renumberBlocked: blocked,
  };
}

// Only the label between the brackets is rewritten, so a marker keeps its shape
// and a definition keeps its colon.
function labelRanges(note, index) {
  return [
    ...note.refs.map(ref => ({from: ref.from + 2, to: ref.to - 1})),
    ...index.definitions.filter(def => def.id === note.id).map(def => ({from: def.markerFrom + 2, to: def.markerTo - 2})),
  ];
}

// Follow only edits inside the label, excluding the brackets and colon. Typing
// a new citation next to an existing one must never rename the existing note.
// Which note an edit landed in: the citation whose label covers the range, or
// the marker of a definition. A name can only be followed when the range the
// edit replaced was one of those two to begin with, which is also what keeps an
// unrelated stray elsewhere in the document from being paired with it.
export function labelPartAt(index, from, to) {
  for (const note of index.notes) {
    for (const ref of note.refs) {
      if (ref.from + 2 <= from && to <= ref.to - 1) return {id: note.id, part: 'citation'};
    }
    const def = note.def;
    if (def && def.markerFrom + 2 <= from && to <= def.markerTo - 2) return {id: note.id, part: 'definition'};
  }
  return null;
}

// A label is the only thing tying a citation to its definition, so renaming one
// side on its own splits a note in half: the citation prints as the marker it is
// written as, the definition drops out of the numbering, and every note behind it
// moves up a place. Both halves are still in the file, and the span the edit
// landed in says which note was meant -- so the other half is renamed to match.
// Renaming a definition moves the whole note, one citation at a time.
//
// `spans` are a transaction's changes, each written as the range it replaced in
// both documents. The changes returned are in the coordinates of `afterText`, so
// a caller can fold them back into the transaction that caused them.
export function planLabelFollow(before, afterText, spans) {
  const after = indexFootnotes(afterText);
  const target = new Map();
  for (const span of spans) {
    const was = labelPartAt(before, span.fromA, span.toA);
    const is = labelPartAt(after, span.fromB, span.toB);
    if (!was || !is || was.part !== is.part || was.id === is.id) continue;
    const seen = target.get(was.id);
    // Two edits writing different names over one label cannot both be followed.
    if (seen === undefined) target.set(was.id, {part: was.part, to: is.id});
    else if (seen && seen.to !== is.id) target.set(was.id, null);
  }

  const taken = new Set(), pairs = [], changes = [];
  for (const [from, want] of target) {
    if (!want || taken.has(want.to)) continue;
    const old = after.notes.find(note => note.id === from);
    const fresh = after.notes.find(note => note.id === want.to);
    if (!old || !fresh) continue;
    let ranges;
    if (want.part === 'citation') {
      // The citation carries the new name: the definition left behind follows it,
      // once nothing cites the old name any more and the new one is still free.
      if (!old.def || old.refs.length || fresh.def) continue;
      ranges = [{from: old.def.markerFrom + 2, to: old.def.markerTo - 2}];
    } else {
      // The definition carries the new name: every citation of the old one follows.
      if (old.def || !old.refs.length || !fresh.def || fresh.refs.length) continue;
      ranges = old.refs.map(ref => ({from: ref.from + 2, to: ref.to - 1}));
    }
    taken.add(want.to);
    pairs.push({from, to: want.to});
    for (const range of ranges) changes.push({...range, insert: want.to});
  }
  if (!changes.length) return [];

  changes.sort(byFrom);
  if (changes.some((change, i) => i && change.from < changes[i - 1].to)) return [];
  // The result is checked rather than trusted, the way an insertion checks its
  // own renumbering: the name a rename aims at has to come out printing, with the
  // old half gone, or the document is left exactly as the author wrote it.
  const settled = indexFootnotes(applyChanges(afterText, changes));
  for (const {from, to} of pairs) {
    const note = settled.notes.find(candidate => candidate.id === to);
    if (!note || !note.def || note.number === null) return [];
    const left = settled.notes.find(candidate => candidate.id === from);
    if (left && (left.def ? !left.refs.length : left.refs.length)) return [];
  }
  return changes;
}

// One blank line between whatever the document ends with and the footnotes,
// whatever the author left at the end of the file.
function gapBefore(before) {
  if (!before) return '';
  if (before.endsWith('\n\n')) return '';
  return before.endsWith('\n') ? '\n' : '\n\n';
}

// What the reader is going to see: a numeric label has to equal the number its
// note ends up with, or the file and the page disagree.
function labelsMatchNumbers(text) {
  let displayed = 0;
  for (const note of indexFootnotes(text).notes) {
    if (!note.def || note.number === null) continue;
    displayed++;
    if (/^[0-9]+$/.test(note.id) && note.id !== String(displayed)) return false;
  }
  return true;
}

const byFrom = (a, b) => a.from - b.from || a.to - b.to;

function applyChanges(text, changes) {
  let out = '', at = 0;
  for (const change of [...changes].sort(byFrom)) {
    out += text.slice(at, change.from) + change.insert;
    at = change.to;
  }
  return out + text.slice(at);
}

// Two edits can share a boundary -- inserting at the very end of the document
// leaves the marker and the definition at one offset -- and a change set does
// not take two ranges at a single point. Their text is the same either way.
function mergeAdjacent(changes) {
  const merged = [];
  for (const change of changes) {
    const last = merged.at(-1);
    if (last && last.to === change.from) {
      last.to = change.to;
      last.insert += change.insert;
      continue;
    }
    merged.push({...change});
  }
  return merged;
}

// Renames are applied together, so the caret only moves for the ones that end
// at or before it.
function shiftOffset(changes, offset) {
  let shifted = offset;
  for (const change of changes) {
    if (change.to > offset) break;
    shifted += change.insert.length - (change.to - change.from);
  }
  return shifted;
}

// Lay a canonical, de-indented body out the way a definition holds it: the first
// line shares the marker's line, every later non-blank line carries the indent
// that keeps it inside the definition. Blank lines stay blank, which is what lets
// a footnote hold more than one paragraph. This is the text the note box writes,
// without the marker in front of it.
//
// A body that ends on a newline ends on the line the caret is sitting on, not on
// a line with anything written in it yet, so that one newline is dropped: kept,
// it would put a blank line into the file under a note nobody meant to break, and
// a blank line between two definitions is exactly what ends the block above it.
export function footnoteBodyText(body) {
  const text = String(body).replace(/\r\n?/g, '\n');
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').map((line, index) => {
    const bare = line.replace(/[ \t]+$/, '');
    if (index === 0) return bare;
    return bare ? `${INDENT}${bare}` : '';
  }).join('\n');
}

// Rebuild the whole definition block from that body.
export function footnoteDefinitionText(id, body) {
  const head = `[^${id}]:`;
  const [first, ...rest] = footnoteBodyText(body).split('\n');
  return [first ? `${head} ${first}` : head, ...rest].join('\n');
}

// Put words into a note that has no definition yet -- the way in for a citation
// typed by hand, written by the box or by the panel. It lands exactly where the
// insert control puts one, so the two ways of starting a note cannot drift apart;
// only a note with nothing after it keeps the old place at the end of the file.
export function appendDefinition(text, id, body) {
  const index = indexFootnotes(text);
  const note = index.notes.find(candidate => candidate.id === id);
  const block = footnoteDefinitionText(id, body);
  const at = note && note.refs.length ? definitionSlot(index, note.refs[0].from) : null;
  if (at !== null) return [{from: at, to: at, insert: `${block}\n`}];
  let end = text.length;
  while (end > 0 && ' \t\r\n'.includes(text[end - 1])) end--;
  const separator = end === 0 ? '' : (text.slice(0, end).endsWith('\n\n') ? '' : '\n\n');
  return [{from: end, to: text.length, insert: `${separator}${block}`}];
}

function linesOf(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text[i] !== '\n') continue;
    lines.push({from: start, to: i, text: text.slice(start, i)});
    start = i + 1;
  }
  return lines;
}

function scanDefinitions(text, lines, fences) {
  const definitions = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (covers(fences, line.from)) continue;
    const match = MARKER.exec(line.text);
    if (!match) continue;

    // match[0] also spans the whitespace that separates the colon from the
    // text, so the marker ends before it and the body starts after it.
    const markerFrom = line.from + match[1].length;
    const markerTo = line.from + match[0].length - match[3].length;
    const bodyFrom = Math.min(markerTo + match[3].length, line.to);

    // Blank lines are held back rather than consumed: they only belong to the
    // definition if an indented line follows, otherwise they end it.
    let last = i;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (covers(fences, next.from)) break;
      if (next.text.trim() === '') continue;
      if (!CONTINUES.test(next.text)) break;
      last = j;
    }

    const body = [text.slice(bodyFrom, line.to).trimEnd()];
    // The indent that holds a continuation line inside the definition is part of
    // the file format, not of the note's text: the editor hides it the way it
    // hides the marker's own brackets, so a note reads as one block. A blank line
    // carries no indent and is simply left as it is.
    const continuations = [];
    for (let j = i + 1; j <= last; j++) {
      const indent = indentationOf(lines[j].text);
      if (indent) continuations.push({from: lines[j].from, to: lines[j].from + indent});
      body.push(stripIndent(lines[j].text).trimEnd());
    }

    definitions.push({
      id: match[2],
      line: i + 1,
      // The block's own line, kept as well as the marker: a definition written
      // into the file elsewhere takes this line's place, indent and all.
      lineFrom: line.from,
      from: markerFrom,
      to: lines[last].to,
      markerFrom,
      markerTo,
      bodyFrom,
      bodyTo: lines[last].to,
      body: body.join('\n'),
      continuations,
    });
  }
  return definitions;
}

function scanReferences(text, lines, masked) {
  const references = [];
  const pattern = new RegExp(REFERENCE.source, 'g');
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    // "[^1]:" is the definition's own marker, and "[1]" without the caret is a
    // link reference. Both would otherwise be counted as a citation.
    const line = lines[lineNumberAt(lines, from) - 1];
    // Only a marker at the start of a definition line owns the colon.
    // A sentence such as “来源[^1]: …” still contains a citation.
    if (text[to] === ':' && /^(?: {0,3}>[ \t]?)* {0,3}$/.test(text.slice(line.from, from))) continue;
    if (escaped(text, from)) continue;
    if (covers(masked, from, to)) continue;
    references.push({id: match[1], from, to, line: lineNumberAt(lines, from)});
  }
  return references;
}

function rangesOf(tree, names = CODE_NODES) {
  const ranges = [];
  tree.iterate({enter(node) { if (names.has(node.name)) ranges.push({from: node.from, to: node.to}); }});
  return ranges.sort((a, b) => a.from - b.from);
}

function covers(ranges, from, to = from) {
  for (const range of ranges) {
    if (range.from > from) return false;
    if (from >= range.from && to <= range.to) return true;
  }
  return false;
}

function escaped(text, offset) {
  let backslashes = 0;
  for (let i = offset - 1; i >= 0 && text[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

// How deep a continuation line is held by the indent that keeps it inside the
// definition: a tab counts as one, otherwise up to four spaces.
function indentationOf(line) {
  if (line.startsWith('\t')) return 1;
  const match = /^ {1,4}/.exec(line);
  return match ? match[0].length : 0;
}

function stripIndent(line) {
  return line.slice(indentationOf(line));
}

function lineNumberAt(lines, offset) {
  let lo = 0, hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].from <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// Rename all uses together. Incomplete notes reserve their labels so a repair
// cannot attach an orphan definition or unresolved citation to a different note.
export function planFootnoteRenumbering(text, {includeNamed = false} = {}) {
  const index = indexFootnotes(text);
  const list = displayNotes(index).list;
  const moves = new Map(list.filter(note => (includeNamed || /^[0-9]+$/.test(note.label)) && note.label !== String(note.number))
    .map(note => [note.label, String(note.number)]));
  const reserved = new Set(index.notes.filter(note => !moves.has(note.id)).map(note => note.id));
  if ([...moves.values()].some(label => reserved.has(label))) return {changes: [], blocked: true};
  const changes = index.notes.flatMap(note => moves.has(note.id)
    ? labelRanges(note, index).map(range => ({...range, insert: moves.get(note.id)})) : []).sort(byFrom);
  return {changes, blocked: false};
}

// Only reorder the final uninterrupted group of definitions. Ordinary prose
// between definitions is never moved, and each multiline body remains intact.
export function planFootnoteDefinitionOrder(text) {
  const index = indexFootnotes(text), defs = index.definitions;
  if (defs.length < 2 || text.slice(defs.at(-1).to).trim()) return [];
  let start = defs.length - 1;
  while (start > 0 && !text.slice(defs[start-1].to, defs[start].lineFrom).trim()) start--;
  const group = defs.slice(start), numbers = displayNotes(index).map;
  const complete = group.filter(def=>numbers.has(def.id)).sort((a,b)=>numbers.get(a.id).number-numbers.get(b.id).number);
  let next = 0;
  const sorted = group.map(def=>numbers.has(def.id) ? complete[next++] : def);
  if (group.every((def,i)=>def===sorted[i])) return [];
  const from = group[0].lineFrom, to = group.at(-1).to;
  const insert = sorted.map((def,i)=>text.slice(def.lineFrom,def.to)+(i<group.length-1 ? text.slice(group[i].to,group[i+1].lineFrom) : '')).join('');
  const result = text.slice(0,from)+insert+text.slice(to);
  // Nested citations in definitions must not acquire a new reading order.
  const labels = source => displayNotes(indexFootnotes(source)).list.map(note=>note.label).join('\n');
  if (labels(result) !== labels(text)) return [];
  return [{from,to,insert}];
}
