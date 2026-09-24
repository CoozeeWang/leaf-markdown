import test from 'node:test';
import assert from 'node:assert/strict';
import {localResourcePaths,rewriteResourcePaths} from '../src/resource-paths.js';
test('attachment path updates preserve prose and encode document names',()=>{
 const source='![图](旧%20稿.assets/a.png)\n正文旧%20稿.assets/a.png\n[附件](旧%20稿.assets/a.png "标题")';
 assert.equal(rewriteResourcePaths(source,[['旧 稿.assets/a.png','新 稿.assets/a.png']]),'![图](新%20稿.assets/a.png)\n正文旧%20稿.assets/a.png\n[附件](新%20稿.assets/a.png "标题")');
});
test('bundle collects local resources, including reference links, without remote URLs or code examples',()=>{
 assert.deepEqual(localResourcePaths('![图](稿.assets/a.png)\n[文件](附件/a.pdf)\n![远程](https://example.com/a.png)\n[引用][x]\n\n[x]: other.png\n\n`![例](no.png)`'),['稿.assets/a.png','附件/a.pdf','other.png']);
});

test('path rewrites leave fenced and inline Markdown examples unchanged',()=>{
 const source='`![图](old.assets/a.png)`\n\n```md\n![图](old.assets/a.png)\n```\n\n![图](old.assets/a.png)';
 assert.equal(rewriteResourcePaths(source,[['old.assets/a.png','new.assets/a.png']]),source.slice(0,source.lastIndexOf('old.assets'))+'new.assets/a.png)');
});
