import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

test('desktop CSP permits only the fixed official Tunnel release metadata request', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const directives = new Map(config.app.security.csp.split(';').map(part => {
    const [name, ...sources] = part.trim().split(/\s+/);
    return [name, sources];
  }));
  assert.deepEqual(directives.get('connect-src'), [
    'ipc:', 'http://ipc.localhost', 'https://api.github.com/repos/openai/tunnel-client/releases/latest',
  ]);
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /fetch\('https:\/\/api\.github\.com\/repos\/openai\/tunnel-client\/releases\/latest', \{credentials:'omit',referrerPolicy:'no-referrer',redirect:'error'/);
});

test('broker supports independently revocable client profiles', () => {
  const source = readFileSync(new URL('../src-tauri/src/mcp.rs', import.meta.url), 'utf8');
  assert.equal(/pub async fn revoke_client\(/.test(source), true, 'broker must serialize independent client revocation');
  const result = spawnSync('cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', 'ai_credentials::tests', '--', '--test-threads=1'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${homedir()}/.cargo/bin:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /[1-9]\d* passed/, 'credential behavior suite must run');
});
