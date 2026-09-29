import test from 'node:test';
import assert from 'node:assert/strict';
import {imageMove} from '../src/image-move.js';

function move(source, raw, at) {
  const from=source.indexOf(raw),plan=imageMove(source,{from,to:from+raw.length},at);
  if(!plan)return null;
  let result=source;
  for(const change of [...plan.changes].reverse())result=result.slice(0,change.from)+change.insert+result.slice(change.to??change.from);
  return result;
}
const raw='![a](assets/my%20photo.png "title")';
test('moves an independent image forward and backward without rewriting its reference',()=>{
  const source=`Intro\n\n${raw}\n\nTarget\n\nEnd`;
  const forward=move(source,raw,source.indexOf('End'));
  assert.equal(forward,`Intro\n\n\n\nTarget\n\n${raw}\n\nEnd`);
  assert.equal(move(source,raw,0),`${raw}\n\nIntro\n\n\n\nTarget\n\nEnd`);
});
test('inline move preserves surrounding text and a linked image carries its link',()=>{
  const source=`Before ${raw} after\n\nTarget`;
  assert.equal(move(source,raw,source.length),`Before  after\n\nTarget${raw}`);
  const linked=`Before [${raw}](https://example.test) after\n\nTarget`;
  assert.equal(move(linked,raw,linked.length),`Before  after\n\nTarget[${raw}](https://example.test)`);
});
test('self drop, properties and code destinations do not edit',()=>{
  const source=`---\ntitle: Test\n---\n\nBefore ${raw} after\n\n\`code\``;
  assert.equal(move(source,raw,source.indexOf(raw)+3),null);
  assert.equal(move(source,raw,5),null);
  assert.equal(move(source,raw,source.indexOf('code')+2),null);
  assert.equal(move(source,raw,source.length+1),null);
});
test('CRLF and document properties remain unchanged',()=>{
  const source=`---\r\ntitle: Test\r\n---\r\n\r\n${raw}\r\n\r\nTarget`;
  const result=move(source,raw,source.indexOf('Target'));
  assert.ok(result.startsWith('---\r\ntitle: Test\r\n---\r\n'));
  assert.equal(result.replaceAll('\r\n','').includes('\n'),false);
  assert.equal(result.split(raw).length,2);
});
