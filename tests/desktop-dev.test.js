import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const config = name => JSON.parse(readFileSync(new URL(`../src-tauri/${name}`, import.meta.url), 'utf8'));

test('desktop development separates application identity without enabling a bundle', () => {
  const production = config('tauri.conf.json');
  const development = config('tauri.dev.conf.json');
  assert.notEqual(development.identifier, production.identifier);
  assert.equal(development.productName, 'Leaf Dev');
  assert.equal(development.bundle.active, false);
  assert.deepEqual(development.bundle.fileAssociations, []);
  assert.equal(production.app.windows[0].dataStoreIdentifier, undefined);
  assert.equal(production.bundle.active, true);
});

test('managed development launcher rejects a configuration override before starting Tauri', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/desktop-dev.mjs', import.meta.url)), '--config', '{"identifier":"studio.leaf.editor"}'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not accept extra arguments|requires macOS 14/);
  assert.doesNotMatch(result.stdout, /Running|VITE/);
});
