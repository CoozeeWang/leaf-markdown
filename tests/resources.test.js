import test from 'node:test';
import assert from 'node:assert/strict';
import { safeTarget, markdownLink } from '../src/resources.js';
test('resource and link targets reject active protocols and traversal', () => {
 for (const path of ['javascript:alert(1)','data:text/html,test','file:///etc/passwd','//host/a','../secret','assets/%2e%2e/secret','assets/%5csecret','https://user:secret@host/a']) assert.equal(safeTarget(path),null,path);
 assert.equal(safeTarget('assets/中文.png'),'assets/中文.png');
 assert.equal(safeTarget('mailto:writer@example.com'),'mailto:writer@example.com');
 assert.equal(safeTarget('#标题'),'#标题');
 assert.equal(safeTarget('mailto:writer@example.com',true),null);
 assert.equal(markdownLink('A [B]','assets/test(1).png',true),'![A \\[B\\]](assets/test%281%29.png)');
});
