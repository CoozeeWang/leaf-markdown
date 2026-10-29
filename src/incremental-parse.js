import {TreeFragment} from '@lezer/common';

// Keep only two immutable snapshots per grammar. Lezer validates open fragment
// boundaries and Markdown context when reusing nodes after an edit.
export function incrementalParser(parser) {
  const recent = new Map();
  let previous = '', tree = null;
  return source => {
    if (recent.has(source)) { previous = source; tree = recent.get(source); return tree; }
    let fragments = [];
    if (tree && source.length >= 4096 && previous.length >= 4096) {
      let from = 0, endA = previous.length, endB = source.length;
      while (from < endA && from < endB && previous.charCodeAt(from) === source.charCodeAt(from)) from++;
      while (endA > from && endB > from && previous.charCodeAt(endA-1) === source.charCodeAt(endB-1)) { endA--; endB--; }
      fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{fromA:from,toA:endA,fromB:from,toB:endB}]);
    }
    tree = parser.parse(source, fragments); previous = source;
    recent.set(source, tree);
    if (recent.size > 2) recent.delete(recent.keys().next().value);
    return tree;
  };
}
