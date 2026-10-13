import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { resolveCodexExecutable } from '../lib/codex-binary.mjs';

const VENDOR = path.join('node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64',
  'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
const filesOnly = known => candidate => known.includes(candidate);

test('an existing override wins and a missing override yields null without falling back', () => {
  const override = path.join('C:', 'tools', 'codex.exe');
  const found = resolveCodexExecutable({ env: { CODEX_CLAUDE_BRIDGE_CODEX_BIN: override, PATH: 'C:\\bin' },
    exists: filesOnly([override, path.join('C:\\bin', 'codex.exe')]) });
  assert.equal(found, override);
  assert.equal(resolveCodexExecutable({ env: { CODEX_CLAUDE_BRIDGE_CODEX_BIN: override, PATH: 'C:\\bin' },
    exists: filesOnly([path.join('C:\\bin', 'codex.exe')]) }), null);
});

test('a native codex.exe on PATH is used directly', () => {
  const direct = path.join('C:\\bin', 'codex.exe');
  assert.equal(resolveCodexExecutable({ env: { PATH: 'C:\\other;C:\\bin' }, exists: filesOnly([direct]) }), direct);
});

test('an npm codex.cmd shim resolves to the vendored native executable beside it', () => {
  const dir = 'C:\\npm';
  const vendored = path.join(dir, VENDOR);
  assert.equal(resolveCodexExecutable({ env: { PATH: dir }, exists: filesOnly([path.join(dir, 'codex.cmd'), vendored]) }), vendored);
  assert.equal(resolveCodexExecutable({ env: { PATH: dir }, exists: filesOnly([path.join(dir, 'codex.cmd')]) }), null);
});

test('nothing on PATH yields null and the Path spelling is honored', () => {
  assert.equal(resolveCodexExecutable({ env: { PATH: '' }, exists: () => false }), null);
  const direct = path.join('C:\\bin', 'codex.exe');
  assert.equal(resolveCodexExecutable({ env: { Path: 'C:\\bin' }, exists: filesOnly([direct]) }), direct);
});
