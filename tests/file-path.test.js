import test from 'node:test';
import assert from 'node:assert/strict';
import { fileNameFromPath } from '../src/file-path.js';

test('native document titles handle Windows, UNC and POSIX paths', () => {
  for (const path of ['C:\\Users\\Author\\中文.md', '\\\\server\\share\\中文.md', '/Users/author/中文.md', 'C:/Users/Author/中文.md']) {
    assert.equal(fileNameFromPath(path), '中文.md');
  }
});
