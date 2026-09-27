import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { indentLess, isolateHistory } from '@codemirror/commands';

// Images on otherwise empty lines can be lazy list continuations even with
// zero source indentation. Only an explicit outdent adds the separating blank
// line; opening a document never rewrites the author's Markdown.
export function imageLines(state) {
  const lines = new Map();
  const through = Math.max(...state.selection.ranges.map(range=>state.doc.lineAt(range.to).to));
  const tree = ensureSyntaxTree(state, through, 50) || syntaxTree(state);
  tree.iterate({enter(ref) {
    if (ref.name !== 'Image') return;
    const line = state.doc.lineAt(ref.from);
    if (line.text.trim() !== state.doc.sliceString(ref.from, ref.to)) return;
    let item = ref.node.parent;
    while (item && item.name !== 'ListItem') item = item.parent;
    lines.set(line.number, {line, item});
  }});
  return lines;
}

export function outdentWritingImage(view) {
  return indentLess({state:view.state, dispatch:tr => {
    const state = tr.state, images = imageLines(state), breaks = new Set();
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.empty ? range.to : range.to - 1).number;
      for (let n = first; n <= last; n++) {
        const image = images.get(n);
        if (image?.item && image.line.text.startsWith('![')) breaks.add(image.line.from);
      }
    }
    if (!breaks.size) { view.dispatch(tr); return; }
    view.dispatch({changes:tr.changes, selection:tr.selection, userEvent:'delete.dedent',
      annotations:isolateHistory.of('full')}, {
      changes:[...breaks].sort((a,b)=>a-b).map(from=>({from,insert:'\n'})), sequential:true,
    });
  }});
}
