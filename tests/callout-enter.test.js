import test from 'node:test';
import assert from 'node:assert/strict';
import {calloutEnter} from '../src/callout-enter.js';
test('ordinary paragraphs enter, exit only at the trailing empty paragraph and support hard breaks', () => {
  assert.deepEqual(calloutEnter('Body',4,4),{exit:false,value:'Body\n\n',caret:6});
  assert.equal(calloutEnter('Body\n\n',6,6).exit,true);
  assert.equal(calloutEnter('',0,0).exit,true);
  assert.equal(calloutEnter('Body\n\nLater',6,6).exit,false);
  assert.equal(calloutEnter('Body\n\n',5,6).exit,false);
  assert.equal(calloutEnter('Body',4,4,true).value,'Body\\\n');
  assert.equal(calloutEnter('Body\\\n',6,6).exit,false,'a hard break is not an empty paragraph');
  for(const body of ['- item\n','1. item\n','```\ncode\n','    code\n','> nested\n','| a | b |\n| --- | --- |\n| x | y |\n']) {
    assert.equal(calloutEnter(body,body.length,body.length),null,body);
  }
});
