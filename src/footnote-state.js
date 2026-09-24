import { StateField, EditorState, MapMode, ChangeSet } from '@codemirror/state';
import { indexFootnotes, displayNotes, labelPartAt, planLabelFollow, planFootnoteRenumbering, planFootnoteDeletion, planFootnoteDefinitionOrder } from './footnotes.js';
import {isolateHistory} from '@codemirror/commands';

// The number a citation shows is derived from the whole document, so the index is
// rebuilt when the text changes and kept across cursor moves -- re-indexing on
// every selection change would scan the document on each arrow key. The editor
// and the reading view read the same rule out of the same module, which is the
// only thing keeping the marker and the printed number from disagreeing.
//
// The field lives here rather than in the editor because a callout draws its own
// preview: its words are held in a text area, outside the document the citation
// pass walks, and that preview has to number its citations from the same index or
// a note would read 1 in the body and something else inside the callout.
export const footnoteIndex = StateField.define({
  create: state => indexFootnotes(state.doc.toString()),
  update(value, tr) {
    return tr.docChanged ? indexFootnotes(tr.state.doc.toString()) : value;
  },
});

// What a renderer reads: the label-to-number map, and `link: false` so the number
// is a label on the text rather than an anchor the webview would navigate to. An
// empty map is handed over all the same -- a fragment has to be rendered with
// its citations suppressed, not left to print as the markers they are written as.
export function footnoteReader(state) {
  const index = state.field(footnoteIndex);
  return { map: displayNotes(index).map, link: false, seen: new Map() };
}

// Renaming a citation by hand used to leave its definition behind under the old
// name, which reads as two halves of one note and renumbers everything after it.
// This puts the other side back inside the very transaction that renamed the
// first, and that is not a detail: `history` groups by transaction, so a second
// dispatch would be its own undo step and one Command-Z would restore half a
// rename. A transaction filter is the only hook that can hand back a longer
// transaction -- a change filter can only take changes away.
export const footnoteLabelFollow = EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged) return tr;
  const before = tr.startState.field(footnoteIndex, false);
  if (!before?.notes.length) return tr;
  const spans = [];
  let onALabel = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    spans.push({fromA, toA, fromB, toB});
    if (labelPartAt(before, fromA, toA)) onALabel = true;
  });
  // Most keystrokes are not a rename, and the second index they need is a full
  // pass over the document. Everything that is not an edit inside a citation or a
  // definition's own marker is answered without it.
  if (!onALabel) return tr;
  const text = tr.newDoc.toString();
  if (!text.includes('[^')) return tr;
  const changes = planLabelFollow(before, text, spans);
  if (!changes.length) return tr;
  // Compose through the public API so selection, effects and history annotations
  // are mapped together and the rename still takes a single undo step.
  return [tr, {changes, sequential: true}];
});

// Runs after label-follow. Loading and undo/redo retain their exact source;
// normal edits keep numeric identifiers in sync with the reading order.
export const footnoteRenumber = EditorState.transactionFilter.of(tr => {
  if (!tr.isUserEvent('input') && !tr.isUserEvent('delete') && !tr.isUserEvent('move')) return tr;
  const text = tr.newDoc.toString();
  if (!text.includes('[^')) return tr;
  const {changes} = planFootnoteRenumbering(text);
  const specs = [tr];
  if (changes.length) specs.push({changes, sequential:true});
  const before = tr.startState.field(footnoteIndex, false);
  const order = index => index.notes.filter(note=>note.refs.length).map(note=>note.id).join('\n');
  const referencesChanged = before && order(before) !== order(indexFootnotes(text));
  if (!tr.isUserEvent('delete.cut') && !tr.isUserEvent('input.cut') &&
      (referencesChanged || tr.isUserEvent('input.footnote-renumber'))) {
    const numbered = ChangeSet.of(changes,tr.newDoc.length).apply(tr.newDoc).toString();
    const reorder = planFootnoteDefinitionOrder(numbered);
    if (reorder.length) specs.push({changes:reorder,sequential:true});
  }
  return specs.length > 1 ? specs : tr;
});

// Clean only notes whose final complete marker was removed by this edit.
// Existing orphans, partially edited markers, loading, history, cut and move
// retain their definitions. In particular a cut keeps the note for its paste.
export const footnoteReferenceDeletion = EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged || (!tr.isUserEvent('delete') && !tr.isUserEvent('input')) ||
      tr.isUserEvent('delete.cut') || tr.isUserEvent('input.cut') || tr.isUserEvent('input.restore')) return tr;
  const before = tr.startState.field(footnoteIndex, false);
  if (!before?.notes.some(note=>note.def && note.refs.length)) return tr;
  const erased = [];
  tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    // Structured inputs replace an entire block: narrow it to the real edit.
    const old = tr.startState.doc.sliceString(from, to), next = inserted.toString();
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(old.length, next.length) && old[prefix] === next[prefix]) prefix++;
    while (suffix < Math.min(old.length, next.length) - prefix && old[old.length-1-suffix] === next[next.length-1-suffix]) suffix++;
    if (from + prefix < to - suffix) erased.push({from:from+prefix, to:to-suffix});
  });
  const candidates = before.notes.filter(note => note.def && note.refs.length &&
    note.refs.every(ref => erased.some(range => range.from <= ref.from && range.to >= ref.to)));
  if (!candidates.length) return tr;
  const text = tr.newDoc.toString(), after = indexFootnotes(text);
  const changes = candidates.filter(note => !after.notes.find(next => next.id === note.id)?.refs.length)
    .flatMap(note => planFootnoteDeletion(text, note.id));
  if (!changes.length) return tr;
  return [tr, {changes:changes.sort((a,b)=>a.from-b.from), sequential:true, annotations:isolateHistory.of('full')}];
});

// Track labels through source positions rather than stale numeric strings.
// The same mapping also follows undo/redo and toolbar insertion renames.
export function footnoteLabelMap(before, after, changes) {
  const refs = new Map(after.notes.flatMap(note => note.refs.map(ref => [ref.from, note.id])));
  const defs = new Map(after.definitions.map(def => [def.markerFrom, def.id]));
  const labels = new Map();
  for (const note of before.notes) {
    const anchors = [...note.refs.map(ref => [refs, ref.from]), ...(note.def ? [[defs, note.def.markerFrom]] : [])];
    for (const [positions, from] of anchors) {
      const mapped = changes.mapPos(from, 1, MapMode.TrackAfter);
      const label = mapped === null ? undefined : positions.get(mapped);
      if (label !== undefined) { labels.set(note.id, label); break; }
    }
  }
  return labels;
}
