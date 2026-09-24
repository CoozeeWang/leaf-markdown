import { GFM } from '@lezer/markdown';

const highlightDelimiter = { resolve: 'LeafHighlight', mark: 'LeafHighlightMark' };
export const leafMarkdownExtensions = [GFM, {
  defineNodes: ['LeafHighlight', 'LeafHighlightMark'],
  parseInline: [{
    name: 'LeafHighlight',
    before: 'Emphasis',
    parse(cx, next, pos) {
      if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos - 1) === 61 || cx.char(pos + 2) === 61) return -1;
      const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
      return cx.addDelimiter(highlightDelimiter, pos, pos + 2,
        !!after && !/\s/.test(after), !!before && !/\s/.test(before));
    },
  }],
}];
