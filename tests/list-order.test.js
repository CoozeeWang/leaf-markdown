import test from 'node:test';
import assert from 'node:assert/strict';
import {orderedListNumberChanges} from '../src/list-order.js';

test('a gap left by a deleted item is closed from the first marker down',()=>{
 assert.deepEqual(orderedListNumberChanges('1. 一\n3. 三\n4. 四'),[
  {from:5,to:6,insert:'2'},{from:10,to:11,insert:'3'}]);
 assert.deepEqual(orderedListNumberChanges('5. 五\n6. 六\n8. 八'),[{from:10,to:11,insert:'7'}]);
});

test('the first item keeps its number, so an explicit start survives',()=>{
 assert.deepEqual(orderedListNumberChanges('5. 五\n9. 九'),[{from:5,to:6,insert:'6'}]);
 assert.deepEqual(orderedListNumberChanges('5. 五\n6. 六'),[]);
});

test('nested lists renumber within their own level only',()=>{
 const source='1. 一\n3. 三\n   7. 甲\n   9. 乙\n4. 四';
 // The outer 三 closes to 2 and 四 to 3; the inner list keeps its own start 7
 // and only its second item steps down to 8.
 assert.deepEqual(orderedListNumberChanges(source),[
  {from:5,to:6,insert:'2'},{from:21,to:22,insert:'8'},{from:26,to:27,insert:'3'}]);
});

test('every delimiter Leaf writes is understood',()=>{
 assert.deepEqual(orderedListNumberChanges('1) 一\n3) 三'),[{from:5,to:6,insert:'2'}]);
});

test('numbers that already read consecutively cost nothing',()=>{
 assert.deepEqual(orderedListNumberChanges('1. 一\n2. 二\n3. 三'),[]);
 assert.deepEqual(orderedListNumberChanges('无序列表\n\n- 一\n- 二'),[]);
 assert.deepEqual(orderedListNumberChanges('正文里提到 1. 某事'),[]);
});

test('separate lists keep separate starts',()=>{
 assert.deepEqual(orderedListNumberChanges('1. 一\n3. 三\n\n正文\n\n4. 四\n6. 六'),[
  {from:5,to:6,insert:'2'},{from:20,to:21,insert:'5'}]);
});

test('code blocks and document properties are never rewritten',()=>{
 assert.deepEqual(orderedListNumberChanges('```\n1. 一\n3. 三\n```'),[]);
 assert.deepEqual(orderedListNumberChanges('---\ntitle: 1. 一\n---\n\n正文'),[]);
});

test('a quoted list renumbers inside its quote',()=>{
 const source='> 1. 一\n> 3. 三';
 assert.deepEqual(orderedListNumberChanges(source),[{from:9,to:10,insert:'2'}]);
});

test('without touched ranges every list is planned; with them only the reached ones',()=>{
 const source='1. 一\n3. 三\n\n正文\n\n1. 另一\n3. 另三';
 const all=orderedListNumberChanges(source);
 assert.equal(all.length,2);
 const at=source.indexOf('3. 另三');
 const second=orderedListNumberChanges(source,[{from:source.indexOf('另一'),to:source.length}]);
 assert.deepEqual(second,[{from:at,to:at+1,insert:'2'}]);
});
