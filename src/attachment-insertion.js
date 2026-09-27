// Keep the continuation paragraph separate from both the inserted block and
// any existing body. The caret offset is not the end of the replacement text.
export function attachmentInsertion(source, {from, to}, links) {
  const before = source.slice(0, from), after = source.slice(to);
  const prefix = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
  const suffix = after && !after.startsWith('\n\n') ? (after.startsWith('\n') ? '\n' : '\n\n') : '';
  const block = prefix + links.join('\n\n');
  return {text: block + '\n\n' + suffix, anchor: from + block.length + 2};
}
