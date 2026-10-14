import test from 'node:test';
import assert from 'node:assert/strict';
import {BODY_ZOOM_LEVELS, stepBodyZoom, bodyZoomShortcut} from '../src/body-zoom.js';

test('body zoom walks the approved presets and stops at each end', () => {
  assert.deepEqual(BODY_ZOOM_LEVELS, [50, 75, 90, 100, 110, 125, 150, 200]);
  assert.equal(stepBodyZoom(100, 1), 110);
  assert.equal(stepBodyZoom(100, -1), 90);
  assert.equal(stepBodyZoom(50, -1), 50);
  assert.equal(stepBodyZoom(200, 1), 200);
});

test('zoom requires the platform modifier and Shift, leaving highlight and IME alone', () => {
  for (const [platform, mod] of [['MacIntel', {metaKey: true}], ['Win32', {ctrlKey: true}]]) {
    for (const [code, key, action] of [['Equal', '+', 'in'], ['Minus', '_', 'out'], ['Digit0', ')', 'reset']]) {
      const event = {...mod, shiftKey: true, code, key};
      assert.equal(bodyZoomShortcut(event, platform), action);
      assert.equal(bodyZoomShortcut({...event, code: ''}, platform), action);
      for (const blocked of [{shiftKey: false}, {altKey: true}, {isComposing: true}, {keyCode: 229}, {ctrlKey: true, metaKey: true}]) {
        assert.equal(bodyZoomShortcut({...event, ...blocked}, platform), null);
      }
    }
    assert.equal(bodyZoomShortcut({...mod, shiftKey: true, code: 'KeyA', key: 'A'}, platform), null);
  }
});
