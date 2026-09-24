import test from 'node:test';
import assert from 'node:assert/strict';
import {paragraphBlankLineChanges} from '../src/blank-lines.js';
function tidy(source) {
  return paragraphBlankLineChanges(source).reverse().reduce((text,c)=>text.slice(0,c.from)+c.insert+text.slice(c.to),source);
}
test('ordinary source lines become paragraphs with exactly one blank; idempotent',()=>{
  for (const source of ['甲\n乙\n\n\n丙\n', '甲\n\n乙\n\n丙\n']) {
    const result=tidy(source);
    assert.equal(result,'甲\n\n乙\n\n丙\n');
    assert.equal(tidy(result),result);
  }
  assert.equal(tidy('甲  \n乙'),'甲  \n\n乙');
  assert.equal(tidy('甲\r\n乙\r\n \t\r\n\r\n丙'),'甲\r\n\r\n乙\r\n\r\n丙');
});
test('structures retain their internal bytes, including loose lists and footnotes',()=>{
  for(const source of [
    '---\ntitle: x\n\n\nnotes: |\n  a\n\n\n  b\n---\n',
    '```md\na\n\n\nb\n```',
    '    a\n\n\n    b',
    '<pre>\na\n\n\nb\n</pre>',
    '- item\n\n\n  continuation\n\n- next',
    '1. item\n   continued\n\n2. next',
    '> [!note]\n> a\n>\n>\n> b',
    '标题\n====',
    '[id]: https://example.com\n  "title"',
    '[^a]: note\n    continued\n\n    another paragraph',
    '文字 `跨行\n代码` 文字',
    '文字 **跨行\n加粗** 文字',
    '文字 [跨行\n链接](url)',
  ]) assert.equal(tidy(source),source,source);
});
test('normalize boundaries around structures without splitting their contents',()=>{
  for(const block of ['# 标题', '```\na\n\nb\n```', '> 引用\n> 第二行', '- 列表\n- 第二项', '| A | B |\n| --- | --- |\n| x | y |']) {
    assert.equal(tidy('前\n\n\n'+block+'\n\n\n后'),'前\n\n'+block+'\n\n后');
  }
  assert.equal(tidy('前\n# 标题\n后'),'前\n\n# 标题\n\n后');
  assert.equal(tidy('---\ntitle: x\n---\n甲\n乙'),'---\ntitle: x\n---\n\n甲\n\n乙');
});
test('remove leading blank lines and preserve trailing whitespace',()=>{
  for(const source of ['', 'a\n', 'a\r\n']) assert.equal(tidy(source),source);
  assert.equal(tidy('\n\na\n\n'),'a\n\n');
  assert.equal(tidy(' \r\n\r\n    code'),'    code');
  assert.equal(tidy('\n'),'');
});
