import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeMarkdown} from '../src/markdown-model.js';
import {tableOperation} from '../src/table-operations.js';
test('table structural edits preserve Markdown, alignment and protected structure',()=>{
 const raw='| A | B |\r\n| :---: | ---: |\r\n| a\\|b | [link](url)<br>x |';
 const b={...analyzeMarkdown(raw.replaceAll('\r\n','\n')).blocks[0],raw};
 const col=tableOperation(b,'col',1);
 assert.ok(col.includes('a\\|b'));assert.ok(col.includes('[link](url)<br>x'));
 assert.ok(col.includes(':---: | --- | ---:'));assert.ok(col.includes('\r\n'));
 assert.equal(analyzeMarkdown(tableOperation(b,'row',1).replaceAll('\r\n','\n')).blocks[0].rows.length,3);
 assert.equal(tableOperation(b,'row',0),null);
 assert.equal(tableOperation(b,'row',0,true),null);
 const single=analyzeMarkdown('| A |\n| --- |\n| x |').blocks[0];
 assert.equal(tableOperation(single,'col',0,true),null);
});
