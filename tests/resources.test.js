import test from 'node:test';
import assert from 'node:assert/strict';
import { safeTarget, markdownLink, mime } from '../src/resources.js';
test('resource and link targets reject active protocols and traversal', () => {
 for (const path of ['javascript:alert(1)','data:text/html,test','file:///etc/passwd','//host/a','../secret','assets/%2e%2e/secret','assets/%5csecret','https://user:secret@host/a']) assert.equal(safeTarget(path),null,path);
 assert.equal(safeTarget('assets/中文.png'),'assets/中文.png');
 assert.equal(safeTarget('mailto:writer@example.com'),'mailto:writer@example.com');
 assert.equal(safeTarget('#标题'),'#标题');
 assert.equal(safeTarget('mailto:writer@example.com',true),null);
 assert.equal(markdownLink('A [B]','assets/test(1).png',true),'![A \\[B\\]](assets/test%281%29.png)');
});
// The blob type decides whether a picture decodes at all, so sniffing has to
// recognise more than the formats that happen to be common.
test('image sniffing reads HEIF brands and SVG text, and rejects what it cannot read', () => {
 const of = (head, ...rest) => Uint8Array.from([...head, ...rest]);
 const text = value => new TextEncoder().encode(value);
 assert.equal(mime(of([137,80,78,71])),'image/png');
 assert.equal(mime(of([255,216,255])),'image/jpeg');
 // "ftyp" then the brand: an iPhone photo, and the still-image brand the same
 // container uses when it is not HEVC.
 assert.equal(mime(of([0,0,0,24],...text('ftypheic'))),'image/heic');
 assert.equal(mime(of([0,0,0,24],...text('ftypmif1'))),'image/heic');
 // SVG is text: with and without an XML declaration.
 assert.equal(mime(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),'image/svg+xml');
 assert.equal(mime(text('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"/>')),'image/svg+xml');
 for (const [label, bytes] of [['tiff',of([73,73,42,0,8,0,0,0])],['unknown',text('not an image at all')]]) assert.throws(() => mime(bytes), Error, label);
});
