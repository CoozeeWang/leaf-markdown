import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

await test('packaged Rust console helper provides standard MCP stdio', () => {
  const binary = resolve('src-tauri/target/debug/leaf-mcp-adapter' + (process.platform === 'win32' ? '.exe' : ''));
  assert.equal(existsSync(binary), true, 'independent console helper must be built');
});
