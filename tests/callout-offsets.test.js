import {test} from 'node:test';
import assert from 'node:assert/strict';
import {titleSlotInSource, bodyToSource} from '../src/callout.js';

// A callout's text areas hold the source with the "> " taken off every line, so a
// marker typed into a box has to be translated back onto the character the caret
// is on. Getting this wrong does not throw: the marker is written one line along,
// or inside the quote marker, where nobody would think to look for it.
//
// The mapping has to agree with the shape the widget writes, so the tests build
// their source the same way it does.
const laidOut = body => `> [!note] 标题\n${body.split('\n').map(line => `> ${line}`).join('\n')}`;
const shown = (raw, offsets) => offsets.map(offset => raw[bodyToSource(raw, offset)]);

test('the title begins after the "[!type]" and the space that follows it', () => {
  assert.deepEqual(titleSlotInSource('> [!note] 标题\n> 内容'), {at: 10, spaced: true});
  assert.deepEqual(titleSlotInSource('> [!todo]- 折叠\n> 内容'), {at: 11, spaced: true});
  assert.deepEqual(titleSlotInSource('  > [!note] 缩进\n> 内容'), {at: 12, spaced: true});
  // A block the toolbar has just made: no title, and no space written yet.
  assert.deepEqual(titleSlotInSource('> [!note]\n> 内容'), {at: 9, spaced: false});
});

test('an offset in the body points at the character the box shows', () => {
  // "第一行\n第二行": the source joins the lines with a newline and the two
  // characters of the next quote marker, which is exactly the drift being checked.
  const raw = laidOut('第一行\n第二行');
  assert.deepEqual(shown(raw, [0, 1, 2, 3, 4, 5, 6]), ['第', '一', '行', '\n', '第', '二', '行']);
  assert.equal(bodyToSource(raw, 7), raw.length, '行尾之后落在块的末尾');
  assert.equal(bodyToSource(raw, 99), raw.length, '超出行尾也落在块的末尾');
});

test('a CRLF file keeps its offsets, and a line may carry just a ">"', () => {
  const crlf = '> [!note]\r\n> 甲';
  assert.equal(crlf[bodyToSource(crlf, 0)], '甲');
  const tight = '> [!note] t\n>甲\n> 乙';
  assert.equal(tight[bodyToSource(tight, 0)], '甲');
  assert.equal(tight[bodyToSource(tight, 1)], '\n');
  assert.equal(tight[bodyToSource(tight, 2)], '乙');
});

// An empty line inside the body is a blank line in the file, and the caret can sit
// on it: the marker belongs on that line, not on the one after it.
test('a blank body line keeps the caret on its own line', () => {
  const middle = '> [!note] t\n>\n> 甲';
  assert.equal(middle[bodyToSource(middle, 0)], '\n');
  assert.equal(middle[bodyToSource(middle, 1)], '甲');
  // A body ending on a newline ends on that empty line, which in the source is the
  // position just after the "> " of the last line.
  const tail = '> [!note] t\n> 甲\n> ';
  assert.equal(bodyToSource(tail, 2), tail.length);
  assert.equal(tail.slice(-1), ' ');
});

// What the widget and the file agree on: no offset ever lands inside the "> " of a
// line, whatever the box holds.
test('no offset lands inside a quote marker', () => {
  for (const body of ['甲', '甲\n乙', '甲\n\n乙', '']) {
    const raw = laidOut(body);
    for (let offset = 0; offset <= body.length; offset++) {
      const at = bodyToSource(raw, offset);
      assert.equal(raw.slice(at - 1, at + 1).includes('> '), false, `offset ${offset} 落在引用符号里`);
    }
  }
});
