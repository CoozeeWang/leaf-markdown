import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentReveal} from '../src/document-reveal.js';
import {t} from '../src/i18n.js';

test('document reveal asks the native recipient for its location without a renderer path',async()=>{
 const calls=[],statuses=[];
 const action=createDocumentReveal({invoke:async(...args)=>calls.push(args),status:(...args)=>statuses.push(args)});
 await action();await action();assert.deepEqual(calls,[['reveal_document'],['reveal_document']]);assert.deepEqual(statuses,[]);
});
test('missing locations and launch failures use persistent localized status feedback',async()=>{
 for(const error of ['File manager launch failed',JSON.stringify({leafError:1,code:'main.the_document_is_no_longer_at_its',params:{}})]){
  const statuses=[];await createDocumentReveal({invoke:async()=>{throw error},status:(...args)=>statuses.push(args)})();
  assert.equal(statuses.length,1);const [message,kind]=statuses[0];assert.equal(kind,'error');
  for(const lng of ['zh-Hans','zh-Hant-TW','en'])assert.equal(t(message.key,{...message.values,lng}),t('main.could_not_show_the_file_in_the',{error,lng}));
 }
});
