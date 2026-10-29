import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { safeAppLink } from '../src/app-links.js';
import { safeTarget, safeLinkTarget, markdownLink } from '../src/resources.js';
import { openResourceLink } from '../src/link-opening.js';
const cases=JSON.parse(fs.readFileSync(new URL('./app-link-cases.json',import.meta.url)));
test('verified application links remain links but never become resource paths or images',()=>{
 for(const url of cases.valid){assert.equal(safeAppLink(url),url);assert.equal(safeLinkTarget(url),url);assert.equal(safeTarget(url),null);assert.equal(safeTarget(url,true),null);assert.throws(()=>markdownLink('image',url,true));assert.equal(markdownLink('合成 [访谈]',url),`[合成 \\[访谈\\]](${url})`);}
 for(const url of cases.invalid){assert.equal(safeAppLink(url),null,url);assert.equal(safeLinkTarget(url),null,url);}
 for(const url of ['https://example.com','mailto:test@example.com','#标题','assets/note.md'])assert.equal(safeLinkTarget(url),url);
});
test('explicit desktop opening uses native command with original URL; browser cannot navigate app protocols',async()=>{
 const calls=[];const invoke=async(...args)=>calls.push(args);const openWeb=(...args)=>calls.push(args);
 for(const url of cases.valid){
 await openResourceLink(url,{desktop:true,invoke,openWeb});
 assert.deepEqual(calls,[['open_link',{target:url}]]);
 calls.length=0;
 await assert.rejects(openResourceLink(url,{desktop:false,invoke,openWeb}));
 }
 for(const url of cases.invalid)await assert.rejects(openResourceLink(url,{desktop:true,invoke,openWeb}));
 assert.deepEqual(calls,[]);
});
