const aliases = {summary:'abstract',tldr:'abstract',hint:'tip',important:'tip',check:'success',done:'success',help:'question',faq:'question',caution:'warning',attention:'warning',fail:'failure',missing:'failure',error:'danger',cite:'quote'};
export const labels = {note:'笔记',abstract:'摘要',info:'信息',todo:'待办',tip:'提示',success:'完成',question:'问题',warning:'注意',failure:'失败',danger:'警告',bug:'问题排查',example:'示例',quote:'引用'};
export function parseCallout(raw) {
  const unquoted = raw.replace(/^ {0,3}>[ \t]?/gm, '');
  const match = /^\[!([\w-]+)\]([+-])?(?:[ \t]+([^\r\n]*))?(?:\r?\n|$)/.exec(unquoted);
  if (!match) return null;
  const id = match[1].toLowerCase(), type = aliases[id] ?? id;
  const customTitle = match[3] ?? '';
  return { type: labels[type] ? type : 'note', customTitle, title: customTitle || labels[type] || match[1], fold: match[2] ?? '', body: unquoted.slice(match[0].length) };
}

// A callout is written through two text areas while its source keeps the "> " of
// every line, so the offset a box reports is not an offset in the document. This
// is how an insert finds the character the caret is on: a marker written into a
// box has to land on the same character of the same line in the file. Pure text
// work, which is what keeps it testable away from the editor.
const QUOTE_PREFIX = /^ {0,3}>[ \t]?/;
const HEADER = /^ {0,3}>[ \t]?\[![\w-]+\][+-]?/;

// Where the editable title begins, and whether the space that separates it from
// the "[!type]" is there yet. The widget writes "> [!note] title", but a
// callout the toolbar has just made has no title and no space: a marker put
// straight after the "]" would read as part of the type and stop the block
// being a callout at all, so the caller has to know to write that space.
export function titleSlotInSource(raw) {
  const head = HEADER.exec(raw)?.[0].length ?? 0;
  const gap = /^[ \t]+/.exec(raw.slice(head))?.[0].length ?? 0;
  return {at: head + gap, spaced: gap > 0};
}

// The lines a box's text is made of, each with where it starts in the source and
// how many characters of the source are its quote marker.
function bodyLines(raw) {
  const lines = raw.split(/\r?\n/);
  const eol = raw.includes('\r\n') ? 2 : 1;
  const spans = [];
  let source = lines[0].length + eol, body = 0;
  for (let i = 1; i < lines.length; i++) {
    const prefix = QUOTE_PREFIX.exec(lines[i])?.[0].length ?? 0;
    const length = lines[i].length - prefix;
    spans.push({ source, prefix, length, body });
    source += lines[i].length + eol;
    body += length + 1;
  }
  return spans;
}

// An offset inside the body a box holds, as an offset inside the block's source.
export function bodyToSource(raw, offset) {
  for (const span of bodyLines(raw)) {
    if (offset <= span.body + span.length) return span.source + span.prefix + Math.max(0, offset - span.body);
  }
  return raw.length;
}
