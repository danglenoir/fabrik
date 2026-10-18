import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tmp } from './helpers.ts';

const launcher = join(import.meta.dirname, '..', 'bin', 'fabrik');
const version = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version;

/** A directory whose `node` is too old: it fails the launcher's version probe. */
function oldNodeDir(): string {
  const dir = tmp('fabrik-oldnode-');
  writeFileSync(join(dir, 'node'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'node'), 0o755);
  return dir;
}

test('launcher skips an old node on PATH and uses the pinned one', () => {
  const cfg = tmp('fabrik-cfg-');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'node'), process.execPath + '\n');
  const env = { ...process.env, PATH: `${oldNodeDir()}:/usr/bin:/bin`, FABRIK_CONFIG_DIR: cfg, FABRIK_NODE: '' };
  assert.equal(execFileSync('sh', [launcher, 'version'], { env, encoding: 'utf8' }).trim(), version);
});

test('launcher honours FABRIK_NODE', () => {
  const env = { ...process.env, PATH: `${oldNodeDir()}:/usr/bin:/bin`, FABRIK_CONFIG_DIR: tmp('fabrik-cfg-'), FABRIK_NODE: process.execPath };
  assert.equal(execFileSync('sh', [launcher, 'version'], { env, encoding: 'utf8' }).trim(), version);
});
