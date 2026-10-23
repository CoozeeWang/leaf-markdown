import test from 'node:test';
import assert from 'node:assert/strict';
import {splitUpdateResult} from '../src/update-result.js';
import {resources} from '../src/i18n.js';
test('failure layout preserves approved multilingual recovery instructions without a duplicate title paragraph',()=>{
 for(const locale of Object.values(resources))for(const state of ['install_failed','rolled_back','rollback_failed']){
  const original=locale['updates.'+state],{title,detail}=splitUpdateResult(original);
  assert.ok(title&&detail);assert.equal((title+detail).replace(/\s/g,''),original.replace(/\s/g,''));
 }
 assert.deepEqual(splitUpdateResult('No punctuation'),{title:'No punctuation',detail:''});
});
