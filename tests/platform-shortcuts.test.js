import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shortcutText, tooltipShortcutText} from '../src/platform-shortcuts.js';
test('shortcut labels follow host platform',()=>{
 const text='切换模式 ⌘E；标题 ⌥1；导出 ⇧⌘E；整理 ⌘⌥\\';
 assert.equal(shortcutText(text,'MacIntel'),'切换模式 ⌘E；标题 ⌥1；导出 ⇧⌘E；整理 ⌥⌘\\');
 assert.equal(shortcutText(text,'Win32'),'切换模式 Ctrl+E；标题 Alt+1；导出 Ctrl+Shift+E；整理 Ctrl+Alt+\\');
});

test('tooltips bracket shortcuts on both platforms without nesting parentheses',()=>{
 assert.equal(tooltipShortcutText('Save  ⌘S'), 'Save  (⌘S)');
 assert.equal(tooltipShortcutText('Heading ⌥1–6 · Body ⌥0'), 'Heading (⌥1–6) · Body (⌥0)');
 assert.equal(tooltipShortcutText('Save Ctrl+S; Close Esc'), 'Save (Ctrl+S); Close (Esc)');
 assert.equal(tooltipShortcutText('Save (⌘S); Hold Ctrl to drag'), 'Save (⌘S); Hold (Ctrl) to drag');
});

test('Windows new-document fallback ignores IME, repeats and other modifier chords', async () => {
  const {isWindowsNewShortcut} = await import('../src/platform-shortcuts.js');
  const event = {key:'n',code:'KeyN',ctrlKey:true};
  assert.equal(isWindowsNewShortcut(event,'Win32'),true);
  assert.equal(isWindowsNewShortcut(event,'MacIntel'),false);
  for (const flag of ['isComposing','repeat','altKey','shiftKey','metaKey']) assert.equal(isWindowsNewShortcut({...event,[flag]:true},'Win32'),false);
  assert.equal(isWindowsNewShortcut({...event,ctrlKey:false},'Win32'),false);
});
