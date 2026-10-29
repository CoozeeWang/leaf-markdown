import test from 'node:test';
import assert from 'node:assert/strict';
import {parser,GFM} from '@lezer/markdown';
import {incrementalParser} from '../src/incremental-parse.js';
import {leafMarkdownExtensions} from '../src/markdown-extensions.js';
import {commentMarkdownExtension} from '../src/comment-syntax.js';
import {parseMarkdown} from '../src/markdown-parse.js';
import {maskHiddenComments} from '../src/comments.js';
const shape=tree=>{const result=[];tree.iterate({enter:n=>{result.push([n.name,n.from,n.to]);}});return result;};
test('fragment reuse matches cold trees across edits to fences, references, comments, UTF-16 and line endings',()=>{
 for(const grammar of [parser.configure(leafMarkdownExtensions),parser.configure([GFM,commentMarkdownExtension])]){
  let reused=0;
  const parse=incrementalParser({parse(source,fragments){if(fragments.length)reused++;return grammar.parse(source,fragments);}});
  let text=Array.from({length:110},(_,i)=>`## Section ${i}\n\nParagraph **words** ==color== [ref][key] 中文🌳.\n\n> [!note] Title\n> Body\n\n`).join('')+'[key]: https://example.com\n';
  const edits=['```\n','~~~\n','%% hidden\n\n','%%','\r\n','{>>note<<}','[^x]: note\n','</code>','🌳','[key]: /changed\n','', '*'];
  for(let i=0;i<70;i++){
   const at=i%5===0?0:i%5===1?text.length:Math.floor(text.length*((i*17%97)/97));
   text=text.slice(0,at)+edits[i%edits.length]+text.slice(Math.min(text.length,at+i%4));
   const incremental=parse(text);
   assert.deepEqual(shape(incremental),shape(grammar.parse(text)),`grammar edit ${i}`);
   assert.equal(parse(text),incremental,'same snapshot is immutable and reused');
  }
  assert.ok(reused>0,'actually passed fragments to the parser');
 }
});
test('masked hidden comments retain correct ranges through incremental edits and undo snapshots',()=>{
 const grammar=parser.configure(leafMarkdownExtensions);
 let text=('Paragraph.\n\n'.repeat(600))+'%% hidden\n\n# not a heading\n%%\n\n## Visible\n';
 for(const insert of ['','x','\n%%\n','```\n','\r\n']){
  const next=insert+text;
  assert.deepEqual(shape(parseMarkdown(next)),shape(grammar.parse(maskHiddenComments(next))));
  assert.deepEqual(shape(parseMarkdown(text)),shape(grammar.parse(maskHiddenComments(text))));
 }
});
test('short nested editor parses do not displace the long-document fragments',()=>{
 let reused=false;
 const grammar=parser.configure(leafMarkdownExtensions);
 const parse=incrementalParser({parse(source,fragments=[]){if(fragments.length)reused=true;return grammar.parse(source,fragments);}});
 const source='Paragraph **text**.\n\n'.repeat(500);
 parse(source);parse('short note');parse('another excerpt');
 assert.deepEqual(shape(parse(source+'x')),shape(grammar.parse(source+'x')));
 assert.ok(reused);
});
