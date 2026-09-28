import test from 'node:test';
import assert from 'node:assert/strict';
import {localResourcePaths,localImagePaths,materializeImageReferences,rewriteResourcePaths} from '../src/resource-paths.js';
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

test('a copied image keeps its definition and excludes links, remote images and code',()=>{
 const document='![图][photo] [附件](note.pdf)\n\n[photo]: 稿.assets/photo.png';
 const copied=materializeImageReferences('![图][photo] [附件](note.pdf)',document);
 assert.equal(copied,'![图](稿.assets/photo.png) [附件](note.pdf)');
 assert.deepEqual(localImagePaths(copied+'\n![远程](https://example.com/photo.png)\n`![示例](example.png)`'),['稿.assets/photo.png']);
 assert.equal(rewriteResourcePaths(copied,[['稿.assets/photo.png','目标.assets/photo-1.png']]),'![图](目标.assets/photo-1.png) [附件](note.pdf)');
 assert.equal(materializeImageReferences('![图][] ![图]', '![图][] ![图]\n\n[图]: 稿.assets/photo.png'), '![图](稿.assets/photo.png) ![图](稿.assets/photo.png)');
});
