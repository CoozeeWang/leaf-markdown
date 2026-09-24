import test from 'node:test';
import assert from 'node:assert/strict';
import {propertyRemovalChange,frontmatter} from '../src/markdown-model.js';
const remove=(s,i)=>{const c=propertyRemovalChange(s,i);return s.slice(0,c.from)+c.insert+s.slice(c.to);};
test('last property removes delimiters and separator blanks, preserving body',()=>{
 for(const nl of ['\n','\r\n']) assert.equal(remove(['---','a: ""','---','','# 正文',''].join(nl),0),'# 正文'+nl);
});
test('deleting one property preserves remaining values, comments and body',()=>{
 for(const s of ['---\na: ""\nb: true # comment\n---\n正文','---\n{a: "", b: true}\n---\n正文']){
 const result=remove(s,0);assert.equal(frontmatter(result).fields.length,1);assert.equal(frontmatter(result).fields[0].value,true);assert.ok(result.endsWith('---\n正文'));
 if(s.includes('# comment'))assert.ok(result.includes('# comment'));
 }
});
