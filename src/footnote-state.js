import { StateField, StateEffect, EditorState, Transaction, MapMode, ChangeSet } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { indexFootnotes, displayNotes, labelPartAt, planLabelFollow, planFootnoteRenumbering, planFootnoteDeletion, planFootnoteDefinitionOrder, appendDefinition } from './footnotes.js';
import {isolateHistory} from '@codemirror/commands';
import {sourceMode} from './view-mode.js';

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

function newInlineCitations(tr) {
  const before = tr.startState.field(footnoteIndex, false);
  if (!before) return [];
  const oldNotes = new Map(before.notes.flatMap(note => note.refs.map(ref => [tr.changes.mapPos(ref.from, -1), note])));
  const touched = [];
  tr.changes.iterChangedRanges((_fromA, _toA, from, to) => touched.push({from, to}));
  return indexFootnotes(tr.newDoc.toString()).notes.flatMap(note => note.refs)
    .filter(ref => {
      const old = oldNotes.get(ref.from);
      // Editing a shared/undefined citation into a new label is an explicit new
      // reference too. A sole defined citation keeps label-follow ownership of
      // its existing body instead of creating an unrelated empty definition.
      const edited = old && old.id !== ref.id && (!old.def || old.refs.length > 1);
      return (!old || edited) && touched.some(range => range.from < ref.to && range.to > ref.from);
    });
}

function editingCitation(tr, ref) {
  return tr.newSelection.ranges.some(range => range.from >= ref.from && range.to < ref.to);
}

// IMEs can finish a citation before compositionend. Remember just the newly
// created references, without appending definitions or changing their labels
// while the input method still owns the text. Opening/paste/undo don't queue work.
export const finishFootnoteComposition = StateEffect.define();
const pendingCitations = StateField.define({
  create: () => ({starts: [], composing: false}),
  update(value, tr) {
    if (tr.isUserEvent('input.type.note') || tr.state.field(sourceMode, false) || (tr.docChanged && !tr.isUserEvent('input.type'))) return {starts: [], composing: false};
    const finishing = tr.effects.some(e => e.is(finishFootnoteComposition));
    const typing = tr.docChanged && tr.isUserEvent('input.type');
    const starts = new Set(value.starts.map(pos => tr.changes.mapPos(pos, -1)));
    if (typing) for (const ref of newInlineCitations(tr)) starts.add(ref.from);
    return {
      starts: indexFootnotes(tr.newDoc.toString()).notes.flatMap(note => note.refs
        .filter(ref => starts.has(ref.from) && (!note.def || editingCitation(tr, ref)))).map(ref => ref.from),
      composing: finishing ? false : typing ? tr.isUserEvent('input.type.compose') : value.composing,
    };
  },
});

// Detect a newly completed citation, including typing ^6 inside existing [].
// Unrelated edits to an already undefined reference leave its source intact.
const completeCitations = EditorState.transactionFilter.of(tr => {
  const finishing = tr.effects.some(e => e.is(finishFootnoteComposition));
  const pending = tr.startState.field(pendingCitations, false) ?? {starts: [], composing: false};
  const typing = tr.docChanged && tr.isUserEvent('input.type');
  const leaving = !tr.docChanged && tr.selection && pending.starts.length;
  if (tr.isUserEvent('input.type.note') || tr.startState.field(sourceMode, false) || (!typing && !leaving && !finishing) ||
    (!finishing && (tr.isUserEvent('input.type.compose') || (pending.composing && !typing)))) return tr;
  const starts = new Set(pending.starts.map(pos => tr.changes.mapPos(pos, -1)));
  if (typing && !finishing) for (const ref of newInlineCitations(tr)) starts.add(ref.from);
  if (!starts.size) return tr;
  let doc = tr.newDoc;
  const candidates = indexFootnotes(doc.toString()).notes.filter(note => !note.def && note.refs.some(ref =>
    starts.has(ref.from) && doc.sliceString(doc.lineAt(ref.from).from, ref.from).trim().length > 0 &&
    // In pre-existing brackets the label may still be growing (^6 -> ^66).
    // Wait for the caret to leave it before assigning a number.
    !editingCitation(tr, ref)));
  if (!candidates.length) return tr;
  // Selection-only completion still belongs to the preceding typed label. Give
  // the combined edit a compose event so numbering and history see one edit.
  const specs = [leaving ? {
    changes: tr.changes, selection: tr.newSelection, effects: [...tr.effects, finishFootnoteComposition.of(null)],
    annotations: [...tr.annotations.filter(a => a.type !== Transaction.userEvent), Transaction.userEvent.of('input.type.compose')],
    scrollIntoView: tr.scrollIntoView,
  } : tr];
  for (const note of candidates) {
    const changes = appendDefinition(doc.toString(), note.id, '');
    specs.push({changes,sequential:true});
    doc = ChangeSet.of(changes, doc.length).apply(doc);
  }
  return specs;
});

export const footnoteReferenceCompletion = [pendingCitations, completeCitations, EditorView.domEventHandlers({
  compositionend(_event, view) {
    // Let CodeMirror flush the final DOM mutation first. Its compose event joins
    // this completion to the same undo step even though the definition is remote.
    setTimeout(() => {
      if (view.dom.isConnected && !view.compositionStarted && view.state.field(pendingCitations).composing) {
        view.dispatch({effects: finishFootnoteComposition.of(null), userEvent: 'input.type.compose'});
      }
    }, 0);
    return false;
  },
})];

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
  const pending = new Set(tr.startState.field(pendingCitations, false)?.starts ?? []);
  // A newly created reference may temporarily spell an existing label while
  // the author is still typing (^1 -> ^12). It isn't a rename of the old note.
  if (before.notes.flatMap(note => note.refs).some(ref => pending.has(ref.from) &&
    tr.changes.touchesRange(ref.from, ref.to))) return tr;
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
  if (tr.isUserEvent('input.type') && !tr.startState.field(sourceMode, false) &&
    !tr.effects.some(effect => effect.is(finishFootnoteComposition))) {
    const starts = new Set([...(tr.startState.field(pendingCitations, false)?.starts ?? []).map(pos => tr.changes.mapPos(pos, -1)),
      ...newInlineCitations(tr).map(ref => ref.from)]);
    if (indexFootnotes(text).notes.flatMap(note => note.refs).some(ref => starts.has(ref.from) && editingCitation(tr, ref))) return tr;
  }
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
