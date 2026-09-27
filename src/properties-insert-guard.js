import { EditorSelection, StateEffect } from '@codemirror/state';
import { bodyStart, frontmatter } from './markdown-model.js';

// Protect changes, not just the caret: CodeMirror drops and pending attachment
// imports can write at a position without first moving the current selection.
// Explicit property editing and history must keep their original transactions.
export function protectPropertyInsertions(tr) {
  if (!tr.docChanged || tr.isUserEvent('input.properties') || tr.isUserEvent('delete.properties')
    || tr.isUserEvent('undo') || tr.isUserEvent('redo')) return tr;
  const source = tr.startState.doc.toString();
  if (!/^(?:\uFEFF)?---/.test(source.slice(0, 4))) return tr;
  const yaml = frontmatter(source);
  if (!yaml) return tr;
  const floor = bodyStart(source, yaml), edits = [];
  let protectedEdit = false;
  tr.changes.iterChanges((from, to, fromB, toB, text) => {
    // A deliberate replacement/deletion of the whole block (e.g. Select All)
    // remains possible. Partial body edits cannot consume the block or its
    // closing newline. A property-only document needs that newline on typing.
    const wholeBlock = from === 0 && to >= yaml.to;
    let start = from, end = to, insert = text.toString(), prefix = '';
    if (!wholeBlock && from < floor) {
      start = floor; end = Math.max(to, floor); protectedEdit = true;
    }
    if (!wholeBlock && start === source.length && start === yaml.to && insert && !insert.startsWith('\n')) {
      prefix = '\n'; protectedEdit = true;
    }
    edits.push({ from: start, to: end, insert: prefix + insert, fromB, toB, prefix, redirected: start !== from || end !== to || !!prefix });
  });
  if (!protectedEdit) return tr;
  edits.sort((a, b) => a.from - b.from || a.to - b.to);
  let delta = 0;
  for (const edit of edits) {
    edit.newFrom = edit.from + delta;
    delta += edit.insert.length - (edit.to - edit.from);
  }
  const changes = tr.startState.changes(edits);
  const mapping = tr.changes.invertedDesc.composeDesc(changes);
  const selection = tr.selection ?? tr.startState.selection.map(tr.changes);
  const position = (pos, assoc) => {
    const edit = edits.find(e => e.redirected && pos >= e.fromB && pos <= e.toB);
    return edit ? edit.newFrom + edit.prefix.length + pos - edit.fromB : mapping.mapPos(pos, assoc);
  };
  const ranges = selection.ranges.map(range => range.empty
    ? EditorSelection.cursor(position(range.head, 1))
    : EditorSelection.range(position(range.anchor, -1), position(range.head, 1)));
  return { changes, selection: EditorSelection.create(ranges, selection.mainIndex),
    effects: StateEffect.mapEffects(tr.effects, mapping), annotations: tr.annotations, scrollIntoView: tr.scrollIntoView };
}
