import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOutline,planSectionMove} from '../src/outline-sections.js';
const apply=(s,p)=>p.changes.toReversed().reduce((text,c)=>text.slice(0,c.from)+(c.insert??'')+text.slice(c.to??c.from),s);
const move=(s,a,b,side)=>{const hs=parseOutline(s);return planSectionMove(s,hs[a].from,hs[b].from,side);};

test('real parser excludes YAML, comments, nested quotes/lists and mismatched fences; supports Setext and indentation',()=>{
 const s='---\ntitle: Sample\n# property comment\n---\n\n# Real\n\n```md\n~~~\n# Code\n```\n\n> # Quote\n\n- # List\n\n---\n\n%%\n# Comment\n%%\n\n  ## Indented\n\nSetext\n======\n';
 assert.deepEqual(parseOutline(s).map(h=>h.text),['Real','Indented','Setext']);
 assert.equal(parseOutline(s)[1].from,s.indexOf('  ##'));
});
test('whole subtree moves verbatim including callouts, comments, links and blank lines',()=>{
 const pre='---\ntitle: Example\n---\n\n';
 const a='# Same\n\nA {>>note<<}\n\n## Child\n\n> [!note]\n> body\n\n[link](https://example.com)\n\n\n';
 const b='# Same\n\nB\n\n',c='# End\n\nC\n';
 const s=pre+a+b+c,p=move(s,0,2,'after');
 assert.equal(apply(s,p),pre+b+a+c);
 assert.equal(p.mapPosition(s.indexOf('A {')),pre.length+b.length+a.indexOf('A {'));
 assert.equal(p.mapPosition(s.indexOf('B\n')),pre.length+b.indexOf('B\n'));
 assert.equal(apply(apply(s,p),move(apply(s,p),1,0,'before')),s);
});
test('same parent and exact level, skipped levels do not imply siblinghood',()=>{
 const s='# A\n\n### X\n\n#### child\n\n### Y\n\n## Z\n\n# B\n\n### Other\n';
 assert.ok(move(s,1,3,'after'));
 for(const [a,b] of [[1,4],[1,6],[0,1],[0,0]])assert.equal(move(s,a,b,'after'),null);
 assert.equal(move(s,1,3,'before'),null,'already adjacent');
});
test('EOF without newline adds only a required separator and preserves every original blank line',()=>{
 for(const eol of ['\n','\r\n'])for(const final of ['',eol]) {
 const a=['# A','','alpha','',''].join(eol), b=['# B','','beta'].join(eol)+final;
 const s=a+b,out=apply(s,move(s,1,0,'before'));
 assert.equal(out,b+(final?'':eol)+a);
 }
});
test('reject moves that swallow a heading in an unterminated fence',()=>{
 const s='# A\n\ntext\n\n# B\n\n```\nunfinished';
 assert.equal(move(s,1,0,'before'),null);
});
test('long outline and repeated reorder use positions instead of titles',()=>{
 let s=Array.from({length:300},(_,i)=>`# Repeated\n\nBody ${i}\n\n`).join('');
 for(let i=0;i<8;i++)s=apply(s,move(s,299,0,'before'));
 assert.equal(parseOutline(s).length,300);
 assert.ok(s.startsWith('# Repeated\n\nBody 292'));
 assert.ok(s.endsWith('Body 291\n\n'));
});

test('selection boundary mapping follows whole sections and EOF carets',()=>{
 const s='# A\n\nalpha\n\n# B\n\nbeta';
 const hs=parseOutline(s),p=move(s,1,0,'before');
 assert.equal(p.mapPosition(s.length),s.length-hs[1].from);
 const q=move(s,0,1,'after');
 assert.equal(q.mapPosition(hs[0].end,-1)-q.mapPosition(0,1),hs[0].end);
});

test('tab separators retain existing navigation and parser code protection',()=>{
 const s='####\tTitle\n\n```\n####\tCode\n```\n';
 assert.deepEqual(parseOutline(s).map(h=>[h.text,h.from]),[['Title',0]]);
});
