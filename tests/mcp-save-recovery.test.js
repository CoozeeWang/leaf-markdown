import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

test('native registration preserves active session and close retires it', () => {
  const run=spawnSync(join(homedir(),'.cargo/bin/cargo'),['test','--locked','--bin','leaf','repeated_registration_preserves_live_session_and_task'],{cwd:new URL('../src-tauri/',import.meta.url),encoding:'utf8'});
  assert.equal(run.status,0,run.stdout + run.stderr);
});
