import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('native reader discovery binds the standards UI resource to its thread tool',()=>{
  const source=readFileSync(new URL('../src-tauri/src/mcp.rs',import.meta.url),'utf8');
  assert.ok(source.includes('ui://leaf/reader'),'standards UI resource must be registered');
  assert.ok(source.includes('text/html;profile=mcp-app'),'resource has MCP Apps MIME');
  assert.ok(source.includes('resourceUri'),'thread tool points to the same resource');
  assert.ok(source.includes('reader_snapshot'),'live read-only broker tool is discoverable');
});
