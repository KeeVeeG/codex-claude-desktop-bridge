import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalLocalSocket } from '../lib/local-socket.mjs';
import { assertClaudeProcessIdentity } from '../lib/claude-process.mjs';

test('Unix endpoint byte boundaries preserve exact addresses on each supported OS', () => {
  for (const [platform, maxBytes] of [['darwin', 103], ['linux', 107]]) {
    const exact = `/tmp/${'ж'.repeat((maxBytes - 5) / 2)}`;
    assert.equal(Buffer.byteLength(exact), maxBytes);
    assert.equal(canonicalLocalSocket(exact, platform), exact);
    assert.equal(canonicalLocalSocket(exact + 'a', platform), null);
    assert.equal(canonicalLocalSocket(`/tmp/${'ж'.repeat(50)}.sock`, platform), null);
  }
});

test('Unix endpoints reject foreign pipe syntax, aliases and malformed paths', () => {
  for (const platform of ['darwin', 'linux']) {
    for (const value of ['\\\\.\\pipe\\app', '//./pipe/app', '/tmp/../x.sock', '/tmp/./x.sock',
      '/tmp//x.sock', '/tmp/', '/', 'relative.sock', '/tmp/a\n.sock', '/tmp/a\0.sock', '', null]) {
      assert.equal(canonicalLocalSocket(value, platform), null, `${platform}: ${JSON.stringify(value)}`);
    }
    assert.equal(canonicalLocalSocket('/tmp/cc-socks/123.sock', platform), '/tmp/cc-socks/123.sock');
  }
  assert.equal(canonicalLocalSocket('/tmp/a.sock', 'freebsd'), null);
});

test('Windows pipe canonicalization remains case-insensitive and rejects Unix and remote endpoints', () => {
  assert.equal(canonicalLocalSocket('\\\\.\\pipe\\LOCAL\\Case', 'win32'), '\\\\.\\pipe\\local\\case');
  assert.equal(canonicalLocalSocket('//./pipe/Case', 'win32'), '\\\\.\\pipe\\case');
  for (const value of ['/tmp/a.sock', '\\\\remote\\pipe\\app', '\\\\.\\pipe\\trailing.', '\\\\.\\pipe\\..']) {
    assert.equal(canonicalLocalSocket(value, 'win32'), null);
  }
});

const darwinRecord = { pid: 123, pidDomain: 'darwin', procStart: 'Thu Oct 15 02:03:04 2026' };

test('Darwin process identity checks use the exact PID with UTC and C locale', () => {
  let calls = 0;
  assertClaudeProcessIdentity(darwinRecord, { platform: 'darwin', spawn(command, args, options) {
    calls++;
    assert.equal(command, '/bin/ps');
    assert.deepEqual(args, ['-o', 'lstart=', '-p', '123']);
    assert.equal(options.env.TZ, 'UTC');
    assert.equal(options.env.LC_ALL, 'C');
    assert.equal(options.timeout, 1000);
    assert.equal(options.shell, undefined);
    return { status: 0, stdout: ` ${darwinRecord.procStart}\n` };
  } });
  assert.equal(calls, 1);
});

test('Darwin identity refuses stale PIDs, foreign domains and failed process probes', () => {
  for (const record of [{ ...darwinRecord, pidDomain: 'linux' }, { ...darwinRecord, pid: '123;bad' },
    { ...darwinRecord, pid: -1 }, { ...darwinRecord, procStart: '' }]) {
    assert.throws(() => assertClaudeProcessIdentity(record, { platform: 'darwin', spawn() {
      assert.fail('Invalid identity must fail before spawning');
    } }), /invalid creation metadata/);
  }
  for (const result of [{ status: 0, stdout: 'other-start' }, { status: 1, stdout: darwinRecord.procStart },
    { status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }, { status: 0, stdout: null }]) {
    assert.throws(() => assertClaudeProcessIdentity(darwinRecord, { platform: 'darwin', spawn: () => result }), /process identity changed/);
  }
});

test('unverified Linux and other process identity contracts fail before probing', () => {
  for (const platform of ['linux', 'freebsd']) {
    assert.throws(() => assertClaudeProcessIdentity({ ...darwinRecord, pidDomain: platform }, { platform,
      spawn() { assert.fail('Unsupported process identity must not fall back to PID liveness'); } }), /only on Windows and macOS/);
  }
});

test('Windows process identity keeps its hostname and FILETIME validation', () => {
  const record = { pid: 123, pidDomain: 'win32:fixture', procStart: '133700000000000000' };
  assertClaudeProcessIdentity(record, { platform: 'win32', hostName: 'FIXTURE', spawn(command, args, options) {
    assert.equal(command, 'powershell.exe');
    assert.match(args.at(-1), /Get-Process -Id 123 .*ToFileTimeUtc/);
    assert.equal(options.windowsHide, true);
    return { status: 0, stdout: record.procStart };
  } });
  assert.throws(() => assertClaudeProcessIdentity({ ...record, pidDomain: 'win32:other' }, {
    platform: 'win32', hostName: 'fixture', spawn() { assert.fail('Foreign host must not be probed'); },
  }), /different process namespace/);
});
