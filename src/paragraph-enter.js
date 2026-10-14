import { EditorSelection } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { sourceMode } from './view-mode.js';
import { footnoteIndex } from './footnote-state.js';

const structural = new Set(['ListItem', 'Blockquote', 'FencedCode', 'CodeBlock', 'HTMLBlock', 'Table', 'LinkReference']);

// A prose line's incidental leading spaces aren't indentation for the next
// paragraph. Structure-specific Enter commands run first; source/code/notes keep
// their existing indentation behavior. Never normalize the rest of the file.
export function insertPlainParagraphNewline({ state, dispatch }) {
  if (state.readOnly || state.field(sourceMode, false)) return false;
  for (const range of state.selection.ranges) {
    for (const pos of [range.from, range.to]) {
      const line = state.doc.lineAt(pos);
      if (/^(?: {4}|\t)/.test(line.text)) return false;
      for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
        if (structural.has(node.name)) return false;
      }
      if (state.field(footnoteIndex, false)?.definitions.some(def => pos >= def.lineFrom && pos <= def.to)) return false;
    }
  }
  dispatch(state.update(state.changeByRange(range => {
    const line = state.doc.lineAt(range.to);
    let from = range.from, to = range.to;
    while (to < line.to && /[ \t]/.test(line.text[to - line.from])) to++;
    const firstLine = state.doc.lineAt(from);
    if (/^[ \t]*$/.test(firstLine.text.slice(0, from - firstLine.from))) from = firstLine.from;
    return {changes: {from, to, insert: '\n'}, range: EditorSelection.cursor(from + 1)};
  }), {scrollIntoView: true, userEvent: 'input'}));
  return true;
}
