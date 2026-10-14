import assert from 'node:assert/strict';
import test from 'node:test';
import { indexFootnotes } from '../src/footnotes.js';
import { footnoteInlineNodes } from '../src/footnote-inline.js';

test('footnote inline spans follow Markdown parsing, including nested and literal markup', () => {
  const source = 'Text[^note].\n\n[^note]: **bold *nested***, `**literal**`, ==highlight==, \\*escaped\\* and **unclosed';
  const def = indexFootnotes(source).notes[0].def;
  const nodes = footnoteInlineNodes(source, def);
  assert.deepEqual(nodes.filter(n => n.name === 'StrongEmphasis').map(n => n.text), ['**bold *nested***']);
  assert.deepEqual(nodes.filter(n => n.name === 'Emphasis').map(n => n.text), ['*nested*']);
  assert.deepEqual(nodes.filter(n => n.name === 'InlineCode').map(n => n.text), ['`**literal**`']);
  assert.equal(nodes.find(n => n.name === 'LeafHighlight').text, '==highlight==');
  for (const n of nodes) assert.equal(n.ranges.map(r => source.slice(r.from, r.to)).join(''), n.text);
  assert.equal(footnoteInlineNodes(source, def), nodes, 'selection-only updates reuse the parsed body');
});

test('multiline spans map through indentation, paragraphs, tabs and CRLF without styling structural bytes', () => {
  const source = 'Text[^note].\r\n\r\n[^note]: **first\r\n    second**  \r\n\r\n\t==last==';
  const def = indexFootnotes(source).notes[0].def;
  const nodes = footnoteInlineNodes(source, def);
  const strong = nodes.find(n => n.name === 'StrongEmphasis');
  assert.deepEqual(strong.ranges.map(r => source.slice(r.from, r.to)), ['**first', 'second**']);
  const highlight = nodes.find(n => n.name === 'LeafHighlight');
  assert.deepEqual(highlight.ranges.map(r => source.slice(r.from, r.to)), ['==last==']);
});

test('formatted link labels are parsed but fenced and indented code in notes stay literal', () => {
  const source = 'Text[^note].\n\n[^note]: [**label**](https://example.com)\n\n    ```text\n    **literal** ==literal==\n    ```\n\n        *also literal*';
  const def = indexFootnotes(source).notes[0].def;
  const nodes = footnoteInlineNodes(source, def);
  assert.deepEqual(nodes.filter(n => n.name === 'StrongEmphasis').map(n => n.text), ['**label**']);
  assert.equal(nodes.some(n => n.name === 'LeafHighlight' || n.name === 'Emphasis'), false);
  assert.equal(nodes.find(n => n.name === 'Link').text, '[**label**](https://example.com)');
});
