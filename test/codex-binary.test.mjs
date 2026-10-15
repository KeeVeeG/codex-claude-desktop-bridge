import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

// Shim shapes from the generators: npm's cmd-shim (%dp0%), pnpm's @zkochan/cmd-shim (%~dp0 or an absolute target), Volta's `volta run`.
const npmShim = target => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "${target}" %*\r\n`;
const pnpmShim = target => `@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "${target}" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "${target}" %*\r\n)\r\n`;
const voltaShim = '@echo off\r\nvolta run %~n0 %*\r\n';
const X64 = ['codex-win32-x64', 'x86_64-pc-windows-msvc'];
const ARM64 = ['codex-win32-arm64', 'aarch64-pc-windows-msvc'];
const vendoredIn = (directory, [name, triple]) => path.join(directory, 'node_modules', '@openai', name, 'vendor', triple, 'bin', 'codex.exe');
const shimOnly = (directory, text, ...files) => ({ env: { PATH: directory }, exists: filesOnly([path.join(directory, 'codex.cmd'), ...files]),
  read: file => { assert.equal(file, path.join(directory, 'codex.cmd')); return text; } });

test('an npm shim resolves the Windows ARM64 platform package, preferring the running architecture', () => {
  const dir = 'C:\\npm';
  const nested = path.join(dir, 'node_modules', '@openai', 'codex');
  const text = npmShim('%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js');
  const arm64 = vendoredIn(nested, ARM64);
  assert.equal(resolveCodexExecutable({ ...shimOnly(dir, text, arm64), arch: 'arm64' }), arm64);
  // npm on an ARM64 machine with an emulated x64 Node installs the x64 package, and an x64 process may see only arm64.
  assert.equal(resolveCodexExecutable({ ...shimOnly(dir, text, arm64), arch: 'x64' }), arm64);
  const x64 = vendoredIn(nested, X64);
  assert.equal(resolveCodexExecutable({ ...shimOnly(dir, text, arm64, x64), arch: 'arm64' }), arm64);
  assert.equal(resolveCodexExecutable({ ...shimOnly(dir, text, arm64, x64), arch: 'x64' }), x64);
  const hoisted = vendoredIn(dir, ARM64);
  assert.equal(resolveCodexExecutable({ ...shimOnly(dir, text, hoisted), arch: 'arm64' }), hoisted, 'a hoisted platform package is found like Node would');
  assert.equal(resolveCodexExecutable({ ...shimOnly(dir, text), arch: 'arm64' }), null);
});

test('a pnpm shim is followed through its junction to the platform package beside the real package', () => {
  const dir = 'C:\\pnpm';
  const linked = path.join(dir, 'global', '5', 'node_modules', '@openai', 'codex');
  const store = path.join(dir, 'global', '5', '.pnpm', '@openai+codex@0.162.1', 'node_modules', '@openai');
  const exe = path.join(store, 'codex-win32-x64', 'vendor', X64[1], 'bin', 'codex.exe');
  const realpath = file => file === linked ? path.join(store, 'codex') : file;
  const relative = pnpmShim('%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js');
  assert.equal(resolveCodexExecutable({ ...shimOnly(dir, relative, exe), realpath, arch: 'x64' }), exe);
  assert.equal(resolveCodexExecutable({ ...shimOnly(dir, relative, exe), realpath: file => file, arch: 'x64' }), null,
    'without resolving the link the platform package is not beside the package');
  const absolute = pnpmShim(`${linked}\\bin\\codex.js`);
  assert.equal(resolveCodexExecutable({ ...shimOnly(dir, absolute, exe), realpath, arch: 'x64' }), exe);
  const upward = pnpmShim('%~dp0\\..\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js');
  assert.equal(resolveCodexExecutable({ ...shimOnly(path.join(dir, 'bin'), upward, exe), realpath, arch: 'x64' }), exe);
});

test('a Volta shim resolves the package image under its home, and only from a bin directory', () => {
  const home = 'C:\\Volta';
  const image = path.join(home, 'tools', 'image', 'packages', '@openai', 'codex');
  const exe = vendoredIn(path.join(image, 'node_modules', '@openai', 'codex'), X64);
  assert.equal(resolveCodexExecutable({ ...shimOnly(path.join(home, 'bin'), voltaShim, exe), arch: 'x64' }), exe);
  const pnpmImage = vendoredIn(path.join(image, '5', 'node_modules', '@openai', 'codex'), ARM64);
  assert.equal(resolveCodexExecutable({ ...shimOnly(path.join(home, 'bin'), voltaShim, pnpmImage), arch: 'arm64' }), pnpmImage);
  assert.equal(resolveCodexExecutable({ ...shimOnly(path.join(home, 'scripts'), voltaShim, exe), arch: 'x64' }), null);
});

test('a shim that names no codex launcher, or a package without a platform package, resolves to null', () => {
  const dir = 'C:\\tools';
  assert.equal(resolveCodexExecutable(shimOnly(dir, '@echo off\r\n"%~dp0\\other.exe" %*\r\n')), null);
  assert.equal(resolveCodexExecutable(shimOnly(dir, npmShim('%dp0%\\node_modules\\other\\bin\\other.js'))), null);
  assert.equal(resolveCodexExecutable({ env: { PATH: dir }, exists: filesOnly([path.join(dir, 'codex.cmd')]),
    read: () => { throw new Error('unreadable'); } }), null);
});

test('a pnpm-style layout on disk resolves through real junctions with the default file access', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-binary-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shims = path.join(root, 'pnpm');
  const virtual = path.join(shims, 'global', '5', '.pnpm');
  const store = path.join(virtual, '@openai+codex@1.0.0', 'node_modules', '@openai');
  const platformStore = path.join(virtual, '@openai+codex@1.0.0-win32-x64', 'node_modules', '@openai', 'codex');
  fs.mkdirSync(path.join(store, 'codex', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(store, 'codex', 'bin', 'codex.js'), '');
  fs.mkdirSync(path.join(platformStore, 'vendor', X64[1], 'bin'), { recursive: true });
  fs.writeFileSync(path.join(platformStore, 'vendor', X64[1], 'bin', 'codex.exe'), '');
  fs.symlinkSync(platformStore, path.join(store, 'codex-win32-x64'), 'junction');
  fs.mkdirSync(path.join(shims, 'global', '5', 'node_modules', '@openai'), { recursive: true });
  fs.symlinkSync(path.join(store, 'codex'), path.join(shims, 'global', '5', 'node_modules', '@openai', 'codex'), 'junction');
  fs.writeFileSync(path.join(shims, 'codex.cmd'), pnpmShim('%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js'));
  const exe = path.join(store, 'codex-win32-x64', 'vendor', X64[1], 'bin', 'codex.exe');
  assert.equal(resolveCodexExecutable({ env: { PATH: shims }, arch: 'x64' }), exe);
  assert.equal(resolveCodexExecutable({ env: { PATH: shims }, arch: 'arm64' }), exe);
});
