import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shortcutText} from '../src/platform-shortcuts.js';
test('shortcut labels follow host platform',()=>{
 const text='切换模式 ⌘E；标题 ⌥1；导出 ⇧⌘E；整理 ⌘⌥\\';
 assert.equal(shortcutText(text,'MacIntel'),'切换模式 ⌘E；标题 ⌥1；导出 ⇧⌘E；整理 ⌥⌘\\');
 assert.equal(shortcutText(text,'Win32'),'切换模式 Ctrl+E；标题 Alt+1；导出 Ctrl+Shift+E；整理 Ctrl+Alt+\\');
});
