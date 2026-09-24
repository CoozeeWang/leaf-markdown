import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parser} from '@lezer/markdown';
import {leafMarkdownExtensions} from '../src/markdown-extensions.js';
import {classifyInlineTag, isVoidInlineTag, pairInlineTags, inlineTagSpans} from '../src/inline-html.js';

const inlineParser = parser.configure(leafMarkdownExtensions);
const spansOf = text => inlineTagSpans(text, inlineParser.parse(text));

// Ranges may nest but never cross, and every span must be exactly formed.
function assertWellFormed(text, spans) {
  for (const s of spans) {
    assert.equal(text.slice(s.openFrom, s.openTo).toLowerCase(), `<${s.tag}>`, 'open tag text');
    assert.equal(text.slice(s.closeFrom, s.closeTo).toLowerCase(), `</${s.tag}>`, 'close tag text');
    assert.equal(s.contentFrom, s.openTo, 'content starts after the open tag');
    assert.equal(s.contentTo, s.closeFrom, 'content ends at the close tag');
  }
  const ordered = [...spans].sort((a, b) => a.openFrom - b.openFrom);
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i], b = ordered[j];
      const disjoint = a.closeTo <= b.openFrom;
      const contains = b.closeTo <= a.closeTo;
      assert.ok(disjoint || contains, `spans cross: <${a.tag}>@${a.openFrom} <${b.tag}>@${b.openFrom}`);
    }
  }
}

test('classifyInlineTag accepts only paired sup/sub, case and space insensitive', () => {
  assert.deepEqual(classifyInlineTag('<sup>'), {name: 'sup', close: false});
  assert.deepEqual(classifyInlineTag('<SUB >'), {name: 'sub', close: false});
  assert.deepEqual(classifyInlineTag('</Sup>'), {name: 'sup', close: true});
  assert.deepEqual(classifyInlineTag('</sub >'), {name: 'sub', close: true});
});

test('classifyInlineTag rejects other tags, self-closing and spaced-out names', () => {
  for (const raw of ['<div>', '</div>', '<br>', '<sup/>', '< su p >', '< sup >', '<span>', '<strong>', 'sup>', '']) {
    assert.equal(classifyInlineTag(raw), null, raw);
  }
});

test('isVoidInlineTag covers the br spellings the parser actually emits', () => {
  // Verified against @lezer/markdown: all of these become HTMLTag nodes.
  for (const raw of ['<br>', '<BR>', '<br >', '<br/>', '<br />', '<br  />', '<br/ >', '<br / >']) {
    assert.equal(isVoidInlineTag(raw), true, raw);
  }
  for (const raw of ['<brx>', '<hr>', '<br data-x="1">', '</br>', '']) assert.equal(isVoidInlineTag(raw), false, raw);
});

test('pairInlineTags matches a simple pair', () => {
  const spans = pairInlineTags([
    {name: 'sup', close: false, from: 4, to: 9},
    {name: 'sup', close: true, from: 10, to: 16},
  ]);
  assert.deepEqual(spans, [{tag: 'sup', openFrom: 4, openTo: 9, contentFrom: 9, contentTo: 10, closeFrom: 10, closeTo: 16}]);
});

test('pairInlineTags nests without crossing', () => {
  const spans = pairInlineTags([
    {name: 'sup', close: false, from: 1, to: 6},
    {name: 'sub', close: false, from: 7, to: 12},
    {name: 'sub', close: true, from: 13, to: 19},
    {name: 'sup', close: true, from: 19, to: 25},
  ]);
  assert.deepEqual(spans.map(s => [s.tag, s.openFrom, s.closeTo]), [['sup', 1, 25], ['sub', 7, 19]]);
});

test('pairInlineTags degrades a crossed pair to a single valid span', () => {
  const spans = pairInlineTags([
    {name: 'sup', close: false, from: 0, to: 5},
    {name: 'sub', close: false, from: 5, to: 10},
    {name: 'sup', close: true, from: 11, to: 16},
    {name: 'sub', close: true, from: 16, to: 21},
  ]);
  assert.deepEqual(spans.map(s => [s.tag, s.openFrom, s.closeTo]), [['sup', 0, 16]]);
});

test('pairInlineTags ignores lone and mismatched tags', () => {
  assert.deepEqual(pairInlineTags([{name: 'sup', close: false, from: 0, to: 5}]), []);
  assert.deepEqual(pairInlineTags([{name: 'sup', close: true, from: 0, to: 6}]), []);
  assert.deepEqual(pairInlineTags([{name: 'sub', close: true, from: 0, to: 6}, {name: 'sup', close: false, from: 7, to: 12}]), []);
});

test('inlineTagSpans finds paired tags in real inline content', () => {
  const text = 'H<sub>2</sub>O 和 m<sup>2</sup>';
  const spans = spansOf(text);
  assert.deepEqual(spans.map(s => [s.tag, text.slice(s.contentFrom, s.contentTo)]), [['sub', '2'], ['sup', '2']]);
  assertWellFormed(text, spans);
});

test('inlineTagSpans lowercases tag names and keeps nested ranges', () => {
  const text = 'a<SUP>b<sup>c</sup></sup>d';
  const spans = spansOf(text);
  assert.deepEqual(spans.map(s => [s.tag, s.openFrom, s.closeTo]), [['sup', 1, 25], ['sup', 7, 19]]);
  assertWellFormed(text, spans);
});

test('inlineTagSpans leaves code spans untouched', () => {
  assert.deepEqual(spansOf('行内代码 `<sup>2</sup>` 不应渲染'), []);
  assert.deepEqual(spansOf('```\n<sup>2</sup>\n```'), []);
});

test('inlineTagSpans never pairs across block boundaries', () => {
  assert.deepEqual(spansOf('未闭合 <sup>2\n\n之后 </sup>'), []);
});

test('inlineTagSpans leaves unpaired and self-closing tags literal', () => {
  assert.deepEqual(spansOf('未闭合 <sup>2 试试'), []);
  assert.deepEqual(spansOf('自闭合 <sup/>'), []);
});

test('inlineTagSpans handles Chinese surroundings and repeated pairs', () => {
  const text = '面积 5 平方米（5m<sup>2</sup>）、水 H<sub>2</sub>O、二氧化碳 CO<sub>2</sub>';
  const spans = spansOf(text);
  assert.equal(spans.length, 3);
  assertWellFormed(text, spans);
});

test('random documents never produce crossing ranges', () => {
  const tokens = ['a', 'b', '<sup>', '</sup>', '<sub>', '</sub>', '<div>', '</div>', '<br>', ' ', '==x==', '`c`'];
  let seed = 20260910;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let n = 0; n < 2000; n++) {
    let text = '';
    for (let i = 0, len = 1 + Math.floor(random() * 12); i < len; i++) text += tokens[Math.floor(random() * tokens.length)];
    assertWellFormed(text, spansOf(text));
  }
});
