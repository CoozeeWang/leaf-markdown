import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeDropPoint} from '../src/native-drop-point.js';

for(const platform of ['macOS','MacIntel','Linux']) for(const ratio of [1,1.5,2]) {
  test(`${platform} drag coordinates remain logical at scale ${ratio}`,()=>{
    assert.deepEqual(nativeDropPoint({x:420,y:610},platform,ratio),{x:420,y:610});
  });
}
for(const platform of ['Windows','Win32']) for(const ratio of [1,1.5,2]) {
  test(`${platform} drag coordinates convert physical pixels at scale ${ratio}`,()=>{
    assert.deepEqual(nativeDropPoint({x:420*ratio,y:610*ratio},platform,ratio),{x:420,y:610});
  });
}
test('leave has no drop point',()=>assert.equal(nativeDropPoint(null,'macOS',2),null));
