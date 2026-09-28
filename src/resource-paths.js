import {parser} from '@lezer/markdown';
import {safeTarget} from './resources.js';
// Apply destination changes to the latest editor buffer, including edits made
// while native copying was in flight. Unrelated prose stays untouched.
export function rewriteResourcePaths(content, mappings = []) {
  const changes=[];
  const replacements=new Map();
  for(const [before,after] of mappings) {
    const encode=p=>p.split('/').map(encodeURIComponent).join('/');
    const link=p=>p.replace(/ /g,'%20').replace(/\(/g,'%28').replace(/\)/g,'%29');
    for(const [old,next] of [[before,after],[encode(before),encode(after)],[link(before),link(after)]]) replacements.set(old,next);
  }
  parser.parse(content).iterate({enter(node) {
    if(node.name!=='URL')return;
    const raw=content.slice(node.from,node.to),angle=raw.startsWith('<')&&raw.endsWith('>');
    const next=replacements.get(angle?raw.slice(1,-1):raw);
    if(next!==undefined)changes.push({from:node.from,to:node.to,text:angle?`<${next}>`:next});
  }});
  return changes.reverse().reduce((text,c)=>text.slice(0,c.from)+c.text+text.slice(c.to),content);
}

export function localResourcePaths(content) {
  const paths=new Set();
  parser.parse(content).iterate({enter(node) {
    if(node.name!=='URL')return;
    const value=safeTarget(content.slice(node.from,node.to));
    if(value && !/^(?:https?:|mailto:|#)/i.test(value)) paths.add(decodeURIComponent(value.split(/[?#]/)[0]));
  }});
  return [...paths];
}

// A selected reference-style image needs its definition even when the
// definition sits outside the selection. Inline it in the clipboard copy so
// the pasted passage remains self-contained.
export function materializeImageReferences(selection, document) {
  const definitions = new Map();
  parser.parse(document).iterate({enter(node) {
    if (node.name !== 'LinkReference') return;
    const label = node.node.getChild('LinkLabel');
    const url = node.node.getChild('URL');
    if (label && url) {
      const name = normalizeLabel(document.slice(label.from + 1, label.to - 1));
      if (!definitions.has(name)) definitions.set(name, document.slice(url.from, url.to));
    }
  }});
  const changes = [];
  parser.parse(selection).iterate({enter(node) {
    if (node.name !== 'Image' || node.node.getChild('URL')) return;
    const label = node.node.getChild('LinkLabel');
    const close = node.node.getChildren('LinkMark').find(mark => selection.slice(mark.from, mark.to) === ']');
    if (!close) return;
    const imageName = selection.slice(node.from + 2, close.from);
    const labelName = label ? selection.slice(label.from + 1, label.to - 1) : '';
    const url = definitions.get(normalizeLabel(labelName || imageName));
    if (!url) return;
    changes.push({from: label?.from ?? node.to, to: label?.to ?? node.to, text: `(${url})`});
  }});
  return changes.reverse().reduce((text, change) => text.slice(0, change.from) + change.text + text.slice(change.to), selection);
}

function normalizeLabel(label) { return label.trim().replace(/\s+/g, ' ').toLowerCase(); }

export function localImagePaths(content) {
  const paths = new Set();
  parser.parse(content).iterate({enter(node) {
    if (node.name !== 'Image') return;
    const url = node.node.getChild('URL');
    if (!url) return;
    const value = safeTarget(content.slice(url.from, url.to), true);
    if (!value || /^https?:\/\//i.test(value)) return;
    paths.add(decodeURIComponent(value));
  }});
  return [...paths];
}
