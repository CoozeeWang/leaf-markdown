import {parser} from '@lezer/markdown';
import {leafMarkdownExtensions} from './markdown-extensions.js';
import {frontmatter} from './markdown-model.js';
const markdown=parser.configure(leafMarkdownExtensions);

export function selectedParagraphDeletion(source,from,to) {
  const yaml=frontmatter(source);
  for(let node=markdown.parse(source).topNode.firstChild;node;node=node.nextSibling) {
    if(node.name!=='Paragraph'||node.from!==from||node.to!==to||(yaml&&from<yaml.to))continue;
    const after=/^\n(?:[ \t]*\n)+/.exec(source.slice(to));
    if(after)return {from,to:to+after[0].length,insert:''};
    if(!source.slice(to).trim()) {
      const before=/(?:\n[ \t]*){2,}$/.exec(source.slice(0,from));
      if(before)return {from:before.index,to:source.length,insert:''};
    }
  }
  return null;
}

// Take away one layer of the separator between two blocks, the way a plain text
// editor unwinds an empty paragraph: one press removes one line break, so a run
// of blanks is peeled off a blank at a time. Both ends are still checked against
// the parsed blocks, so a heading, table, quote, list or code block is never
// pulled into the text around it.
export function paragraphDeletion(source,head,forward=false) {
  const yaml=frontmatter(source);
  const paragraphs=[];
  for(let node=markdown.parse(source).topNode.firstChild;node;node=node.nextSibling) {
    if(node.name==='Paragraph' && (!yaml || node.from>=yaml.to)) paragraphs.push(node);
  }
  const endingAt=pos=>paragraphs.some(p=>p.to<=pos && /^[ \t]*$/.test(source.slice(p.to,pos)));
  const startingAt=pos=>paragraphs.some(p=>p.from===pos);
  if(forward) {
    if(!endingAt(head) || source[head]!=='\n')return null;
    return {from:head,to:head+1,insert:''};
  }
  const lineStart=source.lastIndexOf('\n',head-1)+1;
  if(head!==lineStart || head<1 || source[head-1]!=='\n')return null;
  const run=/(?:\n[ \t]*)+$/.exec(source.slice(0,head));
  if(!run || !endingAt(run.index))return null;
  const lineEnd=source.indexOf('\n',head);
  const empty=!source.slice(head,lineEnd<0?source.length:lineEnd).trim();
  if(!empty&&!startingAt(head))return null;
  return {from:head-1,to:head,insert:''};
}
