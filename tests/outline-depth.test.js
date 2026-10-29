import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOutline,planOutlineMove} from '../src/outline-sections.js';
const apply=(s,p)=>p?.changes.toReversed().reduce((s,c)=>s.slice(0,c.from)+(c.insert??'')+s.slice(c.to??c.from),s);
const source='# Root\n\nIntro\n\n## One\n\nA {>>note<<}\n\n### Same\n\n> [!note]\n> body\n\n#### Detail\n\nD\n\n### Other\n\nO\n\n## Two\n\nB\n\n### Same\n\nC\n\n## Three\n\nT\n\n# End\n\nE';
const plan=(s,a,b,level)=>{const h=parseOutline(s);return planOutlineMove(s,h[a].from,b===null?null:h[b].from,level);};
test('depth move preserves full subtree and all outside parent identities',()=>{
 const p=plan(source,5,7,3),out=apply(source,p),h=parseOutline(out);
 assert(p);assert.equal(h.find(x=>x.text==='Two').level,3);assert.equal(h.filter(x=>x.text==='Same')[1].level,4);assert.equal(h.find(x=>x.text==='Two').parent,h.find(x=>x.text==='One').from);
 const body=source.slice(source.indexOf('## Two'),source.indexOf('## Three')).replace(/^## Two/m,'### Two').replace(/^### Same/m,'#### Same');
 assert(out.includes(body));assert(out.includes('A {>>note<<}'));assert(out.includes('> [!note]\n> body'));
 assert.equal(out.slice(p.mapPosition(source.indexOf('B\n')),p.mapPosition(source.indexOf('B\n'))+1),'B');
});
test('before/after whole parent upgrades do not adopt existing siblings',()=>{
 for(const b of [1,5]){const out=apply(source,plan(source,2,b,2)),h=parseOutline(out);assert(out);assert.equal(h.find(x=>x.text==='Other').parent,h.find(x=>x.text==='One').from);assert.equal(h.filter(x=>x.text==='Same')[0].level,2);}
});
test('self descendants, missing parents, jumps and subtree depth limits are rejected',()=>{
 assert.equal(plan(source,1,2,4),null);assert.equal(plan(source,5,0,2),null);assert.equal(plan(source,1,null,6),null);assert.equal(plan('# R\n\n### Jump\n\n# End\n',1,null,1),null);assert.equal(plan(source,5,5,2),null);
});
test('in-place depth change and EOF separators preserve exact blank lines and CRLF',()=>{
 for(const eol of ['\n','\r\n']){const s=['# A','','a','','## B','','b','','# C','','c'].join(eol);const p=plan(s,1,2,1);assert.equal(apply(s,p),s.replace('## B','# B'));const q=plan(s,2,0,1);assert.equal(apply(s,q),'# C'+eol+eol+'c'+eol+s.slice(0,s.indexOf('# C')));}
});
test('Setext levels preserve underline format or explicitly convert a single-line heading',()=>{
 const s='# Root\n\nOne\n---\n\nbody\n\n## Two\n\nlast\n\n';
 assert.equal(apply(s,plan(s,1,null,1)),'# Root\n\n## Two\n\nlast\n\nOne\n===\n\nbody\n\n');
 const out=apply(s,plan(s,1,null,3));assert(out?.includes('### One\n\nbody\n\n'));
 const multi='# R\n\nFirst\nsecond\n---\n\n## Last\n';assert.equal(plan(multi,1,null,3),null);
});
test('frontmatter, fences, lists, callouts, comments and deep links are not rewritten',()=>{
 const s='---\ntitle: Demo\n# hidden\n---\n\n# A\n\n```md\n# fake\n```\n\n> # quote\n\n- # list\n\n%%\n# comment\n%%\n\n## B\n\n> [!note]\n> [safe](https://example.com)\n\n# C\n\nend\n';
 const p=plan(s,1,null,1),out=apply(s,p);assert(out);assert(out.startsWith(s.slice(0,s.indexOf('## B'))));assert(out.endsWith('# B\n\n> [!note]\n> [safe](https://example.com)\n\n'));assert.equal(parseOutline(out).length,3);
});
test('actual parser rejects unterminated blocks swallowing moved headings',()=>{
 assert.equal(plan('# A\n\ntext\n\n# B\n\n```\nunfinished',1,0,1),null);
});
test('indented hashes, tabs and closing hashes retain spelling when changing depth',()=>{
 const s='# R\n\n  ##\tChild  ##\n\nbody\n\n# End\n';const out=apply(s,plan(s,1,null,1));assert(out?.endsWith('  #\tChild  ##\n\nbody\n\n'));
});
