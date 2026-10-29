import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]
  ));
}

// SD-09: the package is ESM-only. Where the runtime can require() an ES module
// (Node 20.19+, 22.12+) a CommonJS caller must be able to load it; elsewhere
// Node's own ERR_REQUIRE_ESM names the fix, so there is nothing to assert.
test('a CommonJS caller can require() the package where the runtime supports requiring ES modules', {
  skip: process.features.require_module === true ? false : 'this runtime cannot require() an ES module',
}, () => {
  const script = `
    const sdk = require('@pingroom/sdk');
    process.stdout.write(JSON.stringify({
      client: typeof sdk.PingRoom,
      verify: typeof sdk.verifyWebhookSignature,
      commons: sdk.COMMON_ERROR_CODES,
    }));
  `;
  // Self-reference by package name goes through "exports", exactly as a consumer would.
  const result = spawnSync(process.execPath, ['--no-warnings', '-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    client: 'function',
    verify: 'function',
    commons: ['rate_limited', 'feature_disabled'],
  });
});

test('every export condition points at a built file', () => {
  const root = pkg.exports['.'];
  assert.equal(root.import, root.default, 'import and default must load the same ES module');
  for (const target of Object.values(root)) assert.equal(existsSync(join(ROOT, target)), true, target);
  assert.equal(pkg.type, 'module');
});

// Source maps are published so a debugger or bundler can map back to the
// TypeScript; a `sources` entry that does not ship is a dead link.
test('every shipped source map resolves to a source file that ships too', () => {
  assert.ok(pkg.files.includes('src'), 'the published files must include src for the maps to resolve');
  const maps = walk(join(ROOT, 'dist')).filter((file) => file.endsWith('.map'));
  assert.ok(maps.length > 0);
  for (const file of maps) {
    const { sources } = JSON.parse(readFileSync(file, 'utf8'));
    for (const source of sources) {
      const target = resolve(dirname(file), source);
      assert.equal(existsSync(target), true, `${file} -> ${source}`);
      assert.equal(target.startsWith(join(ROOT, 'src')), true, `${source} must point into src/`);
    }
  }
});
