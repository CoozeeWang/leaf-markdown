import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Leaf carries its version in four places and every one of them is read by
// something: Tauri bakes tauri.conf.json into the bundle (and into the Windows
// installer metadata), Cargo stamps the binary, and the lockfiles record the
// resolved package. A bump that misses one of them produces a build whose
// number disagrees with itself, which is exactly what this file prevents.
test('the version is declared identically everywhere it is read from', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/, 'package.json holds a version');
  assert.equal(JSON.parse(read('src-tauri/tauri.conf.json')).version, pkg.version);
  assert.equal(/^version = "(.+)"$/m.exec(read('src-tauri/Cargo.toml'))[1], pkg.version);
  assert.equal(/^name = "leaf"\nversion = "(.+)"/m.exec(read('src-tauri/Cargo.lock'))[1], pkg.version);
  const npmLock = JSON.parse(read('package-lock.json'));
  assert.equal(npmLock.version, pkg.version);
  assert.equal(npmLock.packages[''].version, pkg.version);
});

// The frontend must not carry its own copy: it reads the injected constants so
// the number shown in 设置 is the same one the bundle was built with.
test('the frontend reads the version instead of hardcoding it', () => {
  const pkg = JSON.parse(read('package.json'));
  const config = read('vite.config.js');
  assert.ok(config.includes('__LEAF_VERSION__'), 'vite.config.js injects the version');
  assert.ok(config.includes('__LEAF_BUILD__'), 'vite.config.js injects the build stamp');
  assert.ok(config.includes("readFileSync(new URL('./package.json'"), 'the version comes from package.json');
  for (const file of ['src/main.js', 'src/entry.js']) {
    assert.ok(!read(file).includes(pkg.version), `${file} does not hardcode ${pkg.version}`);
  }
});
