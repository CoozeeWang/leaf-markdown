// Existing CriticMarkup forms only. No Leaf-specific metadata or delimiters.
export function commentToken(text, at = 0) {
  const forms = [['{==','==}','CriticRange'],['{>>','<<}','CriticComment'],['{++','++}','CriticRevision'],['{--','--}','CriticRevision'],['{~~','~~}','CriticRevision'],['%%','%%','ObsidianComment']];
  const form = forms.find(([open]) => text.startsWith(open, at));
  if (!form) return null;
  let slash = at; while (slash > 0 && text[slash - 1] === '\\') slash--;
  if ((at - slash) % 2) return null;
  const [open, close, name] = form;
  let end = text.indexOf(close, at + open.length);
  while (end >= 0) {
    let before = end; while (before > 0 && text[before - 1] === '\\') before--;
    if (!((end - before) % 2)) break;
    end = text.indexOf(close, end + close.length);
  }
  if (end < 0) return null;
  const body = text.slice(at + open.length, end);
  // Keep malformed/nested review syntax visible rather than guessing its scope.
  if (name === 'CriticRange' && /\{(?:==|>>|\+\+|--|~~)/.test(body)) return null;
  if (name === 'CriticRevision' && open === '{~~' && !body.includes('~>')) return null;
  return { name, from: at, to: end + close.length, bodyFrom: at + open.length, bodyTo: end, body };
}

export const commentMarkdownExtension = {
  defineNodes: ['CriticRange', 'CriticMark', 'CriticComment', 'CriticRevision', 'ObsidianComment'],
  parseInline: [{
    name: 'CriticMarkup', before: 'Emphasis',
    parse(cx, next, pos) {
      if (next !== 123 && next !== 37 || cx.hasOpenLink) return -1;
      const token = commentToken(cx.text, pos - cx.offset);
      if (!token) return -1;
      const {name} = token, from = pos, to = token.to + cx.offset;
      const children = name === 'CriticRange' ? [cx.elt('CriticMark', from, from + 3),
        ...cx.parser.parseInline(token.body, from + 3), cx.elt('CriticMark', to - 3, to)] : [];
      return cx.addElement(cx.elt(name, from, to, children));
    },
  }],
};
