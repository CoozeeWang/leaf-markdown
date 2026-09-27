import test from 'node:test';
import assert from 'node:assert/strict';
import {attachmentInsertion} from '../src/attachment-insertion.js';

const image = '![photo](assets/photo.png)';
for (const [name, source, from, to, expected, tail] of [
  ['empty document', '', 0, 0, image+'\n\n', ''],
  ['document end', 'Before', 6, 6, 'Before\n\n'+image+'\n\n', ''],
  ['before body', 'After', 0, 0, image+'\n\n\n\nAfter', '\n\nAfter'],
  ['one existing newline', 'Before\nAfter', 6, 6, 'Before\n\n'+image+'\n\n\n\nAfter', '\n\nAfter'],
  ['two existing newlines', 'Before\n\nAfter', 6, 6, 'Before\n\n'+image+'\n\n\n\nAfter', '\n\nAfter'],
  ['replace selected text only', 'Before OLD After', 7, 10, 'Before \n\n'+image+'\n\n\n\n After', '\n\n After'],
  ['preserve extra empty lines', 'Before\n\n\nAfter', 6, 6, 'Before\n\n'+image+'\n\n\n\n\nAfter', '\n\n\nAfter'],
]) {
  test(`attachment insertion: ${name}`, () => {
    const result = attachmentInsertion(source, {from, to}, [image]);
    const next = source.slice(0, from) + result.text + source.slice(to);
    assert.equal(next, expected);
    assert.ok(next.slice(0, result.anchor).endsWith(image+'\n\n'));
    assert.equal(next.slice(result.anchor), tail);
  });
}
test('multiple attachments leave one continuation paragraph after the last link', () => {
  const result = attachmentInsertion('', {from:0, to:0}, [image, '[note](assets/note.pdf)']);
  assert.equal(result.text, image+'\n\n[note](assets/note.pdf)\n\n');
  assert.equal(result.anchor, result.text.length);
});
