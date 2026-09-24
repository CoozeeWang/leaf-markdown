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
