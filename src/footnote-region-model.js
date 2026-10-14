import { indexFootnotes } from './footnotes.js';

// Keep Markdown definitions intact. The editing region can already display them
// at the end without rewriting a file merely because it was opened.
export function collectFootnoteDefinitions(text) {
  const defs = indexFootnotes(text).definitions;
  if (!defs.length || defs.every((def, i) => !text.slice(def.to, defs[i + 1]?.lineFrom ?? text.length).trim())) return [];
  const changes = defs.map(def => {
    let to=def.to<text.length?def.to+1:def.to;
    // One separator belongs to the moved definition, not to the body. Keep
    // additional deliberate blank lines and do not join two body paragraphs.
    if(text[to]==='\n')to++;
    const insert=def.lineFrom>1&&text[def.lineFrom-2]!=='\n'&&to<text.length&&text[to]!=='\n'?'\n':'';
    return {from:def.lineFrom,to,insert};
  });
  let body = '', at = 0;
  for (const change of changes) { body += text.slice(at, change.from)+change.insert; at = change.to; }
  body += text.slice(at);
  const separator = !body || body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n';
  const notes = defs.map(def => text.slice(def.lineFrom, def.to)).join('\n\n');
  // Use a separate insertion so every body position maps through the move.
  if (changes.at(-1).to === text.length) changes.at(-1).insert = separator + notes;
  else changes.push({from:text.length, insert:separator + notes});
  return changes;
}

export function footnoteHiddenRanges(doc, definitions) {
  const ranges = [];
  for (const def of definitions) {
    const from = def.lineFrom, to = Math.min(doc.length, def.to + 1);
    const last = ranges.at(-1);
    if (last && !doc.sliceString(last.to, from).trim()) last.to = to;
    else ranges.push({from, to});
  }
  return ranges;
}

export function continueBodyPosition(doc, definitions) {
  let end = doc.length;
  for (const def of [...definitions].reverse()) {
    if (!doc.sliceString(def.to, end).trim()) end = def.lineFrom;
    else break;
  }
  while (end > 0 && /\s/.test(doc.sliceString(end - 1, end))) end--;
  return end;
}
