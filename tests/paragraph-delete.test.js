import test from 'node:test';
import assert from 'node:assert/strict';
import {paragraphDeletion,selectedParagraphDeletion} from '../src/paragraph-delete.js';
test('whole paragraph selection deletes its redundant separator, not a neighbouring paragraph',()=>{
 assert.deepEqual(selectedParagraphDeletion('甲\n\n乙\n\n丙',3,4),{from:3,to:6,insert:''});
 assert.deepEqual(selectedParagraphDeletion('甲\n\n乙',3,4),{from:1,to:4,insert:''});
 assert.equal(selectedParagraphDeletion('甲\n\n乙乙',3,4),null);
 assert.equal(selectedParagraphDeletion('# 标题\n\n正文',0,4),null);
});
test('Backspace takes away one blank layer at a time',()=>{
 assert.deepEqual(paragraphDeletion('上段\n\n下段',4),{from:3,to:4,insert:''});
 assert.deepEqual(paragraphDeletion('上段\n\n',4),{from:3,to:4,insert:''});
});
test('forward Delete takes away one blank layer at a time',()=>{
 assert.deepEqual(paragraphDeletion('上段\n\n下段',2,true),{from:2,to:3,insert:''});
 assert.deepEqual(paragraphDeletion('上段\n\n\n下段',2,true),{from:2,to:3,insert:''});
 assert.equal(paragraphDeletion('上段\n下段',2,true),null);
});
test('unwinding a run of blank lines costs one press per blank',()=>{
 assert.deepEqual(paragraphDeletion('上段\n\n\n\n下段',6),{from:5,to:6,insert:''});
 assert.deepEqual(paragraphDeletion('上段\n\n\n\n下段',5),{from:4,to:5,insert:''});
 assert.deepEqual(paragraphDeletion('上段\n\n\n\n下段',4),{from:3,to:4,insert:''});
});
test('leave soft breaks and mid-line positions to normal commands',()=>{
 assert.equal(paragraphDeletion('上段\n下段',3),null);
 assert.equal(paragraphDeletion('上段\n\n下段',5),null);
});
test('never pull a structured block into the text before it',()=>{
 for(const block of ['# 标题','- 列表','> 引用','```\n代码\n```','| A |\n| --- |\n| B |','    代码','---\ntitle: x\n---']){
  assert.equal(paragraphDeletion(block+'\n\n正文',block.length+2),null);
  // Forward removes one line break and stops: the block keeps its own line.
  assert.deepEqual(paragraphDeletion('正文\n\n'+block,2,true),{from:2,to:3,insert:''});
 }
});
