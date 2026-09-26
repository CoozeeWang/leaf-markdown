import { parser } from '@lezer/markdown';
import { leafMarkdownExtensions } from './markdown-extensions.js';
import { frontmatter } from './markdown-model.js';
import { EditorState } from '@codemirror/state';

const markdown = parser.configure(leafMarkdownExtensions);

// Any digit-and-delimiter pair is enough to suspect a list; the parse decides.
const markerHint = /\d+[.)][ \t]/;

// The number an ordered list shows is the first item's marker plus consecutive
// steps from there -- CommonMark ignores later markers when it renders, so a
// list left reading 1, 3, 4 prints as 1, 2, 3 everywhere outside the editor and
// only the editor's own marker shows the gap. Renumbering the source keeps what
// the writer sees in step with what every reader gets. The first item's own
// number is kept: a list opened at "5." stays a list that starts at 5.
export function orderedListNumberChanges(source, touched = null) {
  if (!markerHint.test(source)) return [];
  const yaml = frontmatter(source);
  const offset = yaml?.to ?? 0;
  const changes = [];
  markdown.parse(source.slice(offset)).iterate({ enter(node) {
    if (node.name !== 'OrderedList') return;
    const listFrom = node.from + offset, listTo = node.to + offset;
    // A list the edit never came near keeps its written numbers, so a document
    // that deliberately carries gaps in an untouched list stays as it is.
    if (touched && !touched.some(range => range.from < listTo && range.to > listFrom)) return;
    let expected = null;
    for (let item = node.node.firstChild; item; item = item.nextSibling) {
      if (item.name !== 'ListItem') continue;
      const marker = /^\d+/.exec(source.slice(item.from + offset, item.to + offset));
      if (!marker) continue;
      expected = expected === null ? Number(marker[0]) : expected + 1;
      if (marker[0] !== String(expected)) {
        changes.push({from: item.from + offset, to: item.from + offset + marker[0].length, insert: String(expected)});
      }
    }
  } });
  // A nested list is visited after its parent finished, so plans can come out
  // of position; a change set insists on ascending, non-overlapping ranges.
  return changes.sort((a, b) => a.from - b.from);
}

// Runs with the edit rather than after it, the way the footnote renumbering
// does: the fixes join the same transaction, so one Cmd-Z takes back the edit
// and the renumbering together and the file on disk never sees the gap. Only
// edits that could plausibly touch a list pay for the parse, and only the lists
// the edit reached are rewritten.
export const orderedListRenumber = EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged) return tr;
  if (!tr.isUserEvent('input') && !tr.isUserEvent('delete') && !tr.isUserEvent('move')) return tr;
  const doc = tr.newDoc;
  const touched = [];
  let suspected = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    // The deleted lines matter too: removing "2. 第二项" is exactly the edit
    // that leaves the rest of the list numbered 3, 4, and the surrounding lines
    // may carry no marker at all once it is gone.
    if (markerHint.test(inserted.toString()) ||
        fromA < toA && markerHint.test(tr.startState.doc.sliceString(fromA, toA))) suspected = true;
    // Whole lines, one line of slack on each side: the list the edit landed in
    // may begin or end just past the lines the change itself covers.
    const first = Math.max(1, doc.lineAt(fromB).number - 1);
    const last = Math.min(doc.lines, doc.lineAt(Math.min(toB, doc.length)).number + 1);
    const range = {from: doc.line(first).from, to: doc.line(last).to};
    touched.push(range);
    if (markerHint.test(doc.sliceString(range.from, range.to))) suspected = true;
  });
  if (!suspected) return tr;
  const changes = orderedListNumberChanges(doc.toString(), touched);
  if (!changes.length) return tr;
  return [tr, {changes, sequential: true}];
});
