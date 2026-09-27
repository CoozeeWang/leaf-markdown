import test from 'node:test';
import assert from 'node:assert/strict';
import {paragraphBlankLineChanges} from '../src/blank-lines.js';
import {parser} from '@lezer/markdown';
import {leafMarkdownExtensions} from '../src/markdown-extensions.js';
const markdown=parser.configure(leafMarkdownExtensions);
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
test('literal structures and multiline inline syntax retain their internal bytes',()=>{
  for(const source of [
    '---\ntitle: x\n\n\nnotes: |\n  a\n\n\n  b\n---\n',
    '```md\na\n\n\nb\n```',
    '    a\n\n\n    b',
    '<pre>\na\n\n\nb\n</pre>',
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
test('remove leading and trailing blank rows but retain a final line ending',()=>{
  for(const source of ['', 'a\n', 'a\r\n']) assert.equal(tidy(source),source);
  assert.equal(tidy('\n\na\n\n'),'a\n');
  assert.equal(tidy(' \r\n\r\n    code'),'    code');
  assert.equal(tidy('\n'),'');
  assert.equal(tidy(' \t'),'');
  assert.equal(tidy(' \r\n\r\n\t'),'');
  assert.equal(tidy('a\n \t\n\n \t'),'a\n');
  assert.equal(tidy('a  \r\n \t\r\n\r\n'),'a  \r\n');
  for (const block of ['# 标题', '- A\n- B', '```\nx\n```', '> 引用', '[^a]: 脚注']) {
    const expected=block+'\n';
    assert.equal(tidy('\n\n'+block+'\n\n\n'),expected);
    assert.equal(tidy(expected),expected);
  }
});

test('compact bullet, ordered and task items, preserving markers and CRLF',()=>{
  for (const [source,expected] of [
    ['-\n\n  - 子项\n\n- B','-\n  - 子项\n- B'],
    ['- A\n\n\n- B','- A\n- B'],
    ['1. A\n \t\n3. B','1. A\n3. B'],
    ['- [ ] A\n\n- [x] B','- [ ] A\n- [x] B'],
    ['1) A\r\n\r\n2) B\r\n\r\n','1) A\r\n2) B\r\n'],
    ['- A\n  续行\n\n- B','- A\n  续行\n- B'],
  ]) {
    assert.equal(tidy(source),expected);
    assert.equal(tidy(expected),expected);
  }
});

test('compact parent/child and sibling list gaps without changing ownership',()=>{
  for (const [source,expected] of [
    ['- A\n\n  - A1\n\n    1. 深层\n\n    2. 次项\n\n  - A2\n\n- B',
     '- A\n  - A1\n    1. 深层\n    2. 次项\n  - A2\n- B'],
    ['- [ ] A\n\n  - 子项\n\n- [x] B','- [ ] A\n  - 子项\n- [x] B'],
    ['- A\n\n* B','- A\n\n* B'],
    ['1. A\n\n- B','1. A\n\n- B'],
    ['- A\n\n\n段落\n\n\n- B','- A\n\n段落\n\n- B'],
  ]) {
    assert.equal(tidy(source),expected);
    assert.equal(tidy(expected),expected);
  }
});

test('item paragraphs and blocks retain necessary separators and literal blanks',()=>{
  for (const [source,expected] of [
    ['- A\n\n\n  第二段\n\n\n- B','- A\n\n  第二段\n- B'],
    ['- A\n\n  - 子项\n\n\n  子列表后的段落\n\n- B',
     '- A\n  - 子项\n\n  子列表后的段落\n- B'],
    ['- A\n\n\n  ```\n  x\n\n\n  y\n  ```\n\n- B',
     '- A\n\n  ```\n  x\n\n\n  y\n  ```\n- B'],
    ['- A\n\n      code\n\n\n      more code\n\n- B',
     '- A\n\n      code\n\n\n      more code\n- B'],
    ['> - A\n>\n> - B','> - A\n>\n> - B'],
    ['[^a]: 注释\n\n    - A\n\n    - B','[^a]: 注释\n\n    - A\n\n    - B'],
    ['```\nx\n\n\n','```\nx\n\n\n'],
  ]) {
    assert.equal(tidy(source),expected);
    assert.equal(tidy(expected),expected);
    assert.equal(markdown.parse(expected).toString(),markdown.parse(source).toString(),
      'item paragraphs, nested lists and literal blocks keep their parsed structure');
  }
});

test('properties after leading blanks are protected and the whole cleanup is stable',()=>{
  const yaml='---\ntitle: x\n\n\nnotes: |\n  a\n\n\n  b\n---';
  const source='\n \t\n'+yaml+'\n甲\n乙\n\n\n- A\n\n- B\n\n\n';
  const expected=yaml+'\n\n甲\n\n乙\n\n- A\n- B\n';
  assert.equal(tidy(source),expected);
  assert.equal(tidy(expected),expected);
});
