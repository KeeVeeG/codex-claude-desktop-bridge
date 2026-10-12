import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { canonicalClaudeSocket, resolveClaudeCaller } from '../lib/claude-desktop.mjs';
import { getCodexHost, getCodexHosts, publishCodexHost } from '../lib/codex-host.mjs';
import { nativeFixture } from './native-helpers.mjs';

const windowsOnly = { skip: process.platform !== 'win32' && 'Native Claude Desktop process metadata is Windows-specific.' };
const processStart = process.platform === 'win32'
  ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc().ToString()`], { encoding: 'utf8', windowsHide: true }).stdout.trim()
  : String(Date.now());

async function callerFixture(t) {
  const fixture = await nativeFixture(t);
  const registryDir = path.join(fixture.root, 'claude-registry');
  fs.mkdirSync(registryDir);
  const socketPath = `\\\\.\\pipe\\LOCAL\\cc-msg-${randomUUID().replaceAll('-', '')}`;
  const record = { pid: process.pid, sessionId: randomUUID(), entrypoint: 'claude-desktop',
    procStart: processStart, pidDomain: `win32:${os.hostname().toLowerCase()}`, messagingSocketPath: socketPath,
    cwd: fixture.cwd, name: 'Exact caller', version: '2.1.280', status: 'idle' };
  fs.writeFileSync(path.join(registryDir, `${record.pid}.json`), JSON.stringify(record));
  const hash = createHash('sha256').update(canonicalClaudeSocket(socketPath)).digest('hex');
  const keyPath = path.join(registryDir, `${record.pid}.${hash}.key`);
  const key = { peerToken: '1'.repeat(32), procStartFt: processStart, pidDomain: record.pidDomain };
  fs.writeFileSync(keyPath, JSON.stringify(key));
  return { ...fixture, registryDir, record, socketPath, keyPath, key };
}

test('Claude caller matches the exact direct parent and validates its current process identity', windowsOnly, async t => {
  const setup = await callerFixture(t);
  const caller = resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: process.pid });
  assert.equal(caller.sessionId, setup.record.sessionId);
  assert.equal(caller.pid, process.pid);
  assert.equal(caller.socketPath, canonicalClaudeSocket(setup.socketPath));
  assert.equal(caller.token, setup.key.peerToken);
  assert.throws(() => resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: 2_147_483_647 }), /Cannot identify/);
  setup.key.procStartFt = '1';
  fs.writeFileSync(setup.keyPath, JSON.stringify(setup.key));
  assert.throws(() => resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: process.pid }), /key does not match/);
});

test('Claude own socket must match its direct parent and cannot spoof another caller', windowsOnly, async t => {
  const setup = await callerFixture(t);
  const caller = resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: process.pid,
    socketPath: setup.socketPath.toLowerCase() });
  assert.equal(caller.sessionId, setup.record.sessionId);
  assert.throws(() => resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: 2_147_483_647,
    socketPath: setup.socketPath }), /Cannot identify/);
  assert.throws(() => resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: process.pid,
    socketPath: '\\\\.\\pipe\\not-this-session' }), /Cannot identify/);
  assert.throws(() => resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: process.pid,
    socketPath: 'https://example.invalid' }), /invalid messaging socket/);
});

test('a different process claiming the same socket cannot change the direct parent identity', windowsOnly, async t => {
  const setup = await callerFixture(t);
  fs.writeFileSync(path.join(setup.registryDir, `${process.ppid}.json`), JSON.stringify({
    ...setup.record, pid: process.ppid, sessionId: randomUUID(), procStart: '1',
  }));
  const caller = resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: process.pid, socketPath: setup.socketPath });
  assert.equal(caller.sessionId, setup.record.sessionId);
  assert.equal(caller.pid, process.pid);
  assert.throws(() => resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: process.ppid,
    socketPath: setup.socketPath }), /process identity changed|invalid creation metadata|key/);
});

test('Codex host publication is atomic and survives publisher exit without an arbitrary expiry', async t => {
  const setup = await nativeFixture(t);
  assert.equal(getCodexHost({ stateDir: setup.stateDir }), null);
  const first = publishCodexHost({ stateDir: setup.stateDir, pipePath: '\\\\.\\pipe\\codex-host-test', threadId: 'known-context' });
  assert.deepEqual(getCodexHost({ stateDir: setup.stateDir }), first);
  const file = path.join(setup.stateDir, 'codex-host.json');
  const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
  previous.pid = 2_147_483_647;
  previous.publishedAt = 1;
  fs.writeFileSync(file, JSON.stringify(previous));
  assert.equal(getCodexHost({ stateDir: setup.stateDir }).threadId, 'known-context');
  const second = publishCodexHost({ stateDir: setup.stateDir, pipePath: '\\\\.\\pipe\\codex-host-test-2', threadId: 'new-context' });
  assert.deepEqual(getCodexHost({ stateDir: setup.stateDir }), second);
  assert.deepEqual(getCodexHosts({ stateDir: setup.stateDir }), [second, { ...first, pid: 2_147_483_647, publishedAt: 1 }]);
  assert.deepEqual(fs.readdirSync(setup.stateDir), ['codex-host.json']);
});

test('Codex host publication retries Windows sharing contention', windowsOnly, async t => {
  const setup = await nativeFixture(t);
  const rename = fs.renameSync;
  let attempts = 0;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === path.join(setup.stateDir, 'codex-host.json') && attempts++ < 2) {
      throw Object.assign(new Error('Transient sharing violation'), { code: 'EPERM' });
    }
    return rename(source, destination);
  });
  const record = publishCodexHost({ stateDir: setup.stateDir, pipePath: '\\\\.\\pipe\\codex-host-test', threadId: 'known-context' });
  assert.equal(attempts, 3);
  assert.deepEqual(getCodexHost({ stateDir: setup.stateDir }), record);
});

test('Codex host reader retries a replacement between stat and open', async t => {
  const setup = await nativeFixture(t);
  const record = publishCodexHost({ stateDir: setup.stateDir, pipePath: '\\\\.\\pipe\\codex-host-test', threadId: 'known-context' });
  const registryFile = path.join(setup.stateDir, 'codex-host.json');
  const open = fs.openSync;
  let raced = false;
  t.mock.method(fs, 'openSync', (file, flags, mode) => {
    if (file === registryFile && !raced) {
      raced = true;
      throw Object.assign(new Error('Registry replaced'), { code: 'ENOENT' });
    }
    return open(file, flags, mode);
  });
  assert.deepEqual(getCodexHost({ stateDir: setup.stateDir }), record);
  assert.equal(raced, true);
});

test('Codex host rejects remote endpoints, invalid context, and malformed registry contents', async t => {
  const setup = await nativeFixture(t);
  const rejected = ['https://example.invalid', '\\\\remote\\pipe\\app', '\\\\.\\pipe\\trailing.'];
  if (process.platform === 'win32') rejected.push('/tmp/socket');
  for (const pipePath of rejected) {
    assert.throws(() => publishCodexHost({ stateDir: setup.stateDir, pipePath, threadId: 'known' }), /named pipe/);
  }
  assert.throws(() => publishCodexHost({ stateDir: setup.stateDir, pipePath: '\\\\.\\pipe\\app', threadId: '' }), /context task ID/);
  const valid = publishCodexHost({ stateDir: setup.stateDir, pipePath: '\\\\.\\pipe\\app', threadId: 'known' });
  const file = path.join(setup.stateDir, 'codex-host.json');
  fs.writeFileSync(file, JSON.stringify({ ...valid, pipePath: '\\\\remote\\pipe\\app' }));
  assert.throws(() => getCodexHost({ stateDir: setup.stateDir }), /named pipe/);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => getCodexHost({ stateDir: setup.stateDir }), /Invalid Codex host registry JSON/);
  fs.writeFileSync(file, 'x'.repeat(20_000));
  assert.throws(() => getCodexHost({ stateDir: setup.stateDir }), /bounded regular file/);
});

test('Codex host returns only defined registry metadata', async t => {
  const setup = await nativeFixture(t);
  const valid = publishCodexHost({ stateDir: setup.stateDir, pipePath: '\\\\.\\pipe\\app', threadId: 'known' });
  fs.writeFileSync(path.join(setup.stateDir, 'codex-host.json'), JSON.stringify({ ...valid, unrelated: 'ignore' }));
  assert.deepEqual(getCodexHost({ stateDir: setup.stateDir }), valid);
});

test('Claude socket canonicalization accepts normalized absolute Unix paths off Windows', { skip: process.platform === 'win32' }, () => {
  assert.equal(canonicalClaudeSocket('/tmp/cc-socks/123.sock'), '/tmp/cc-socks/123.sock');
  assert.equal(canonicalClaudeSocket('/tmp/cc-socks/../123.sock'), null);
  assert.equal(canonicalClaudeSocket('/tmp/cc-socks/'), null);
  assert.equal(canonicalClaudeSocket('relative/123.sock'), null);
  assert.equal(canonicalClaudeSocket(`/tmp/${'a'.repeat(120)}.sock`), null);
  assert.equal(canonicalClaudeSocket('/tmp/x\n.sock'), null);
});

test('Claude inbox key may name its process-start field procStart (macOS) or procStartFt (Windows)', { skip: process.platform === 'win32' }, async t => {
  const setup = await callerFixture(t);
  const { resolveClaudeSession } = await import('../lib/claude-desktop.mjs');
  const record = { ...setup.record, entrypoint: 'claude-desktop', pidDomain: 'darwin', pid: process.pid };
  fs.writeFileSync(path.join(setup.registryDir, `${record.pid}.json`), JSON.stringify(record));
  const hash = createHash('sha256').update(canonicalClaudeSocket(record.messagingSocketPath)).digest('hex');
  const keyPath = path.join(setup.registryDir, `${record.pid}.${hash}.key`);
  fs.writeFileSync(keyPath, JSON.stringify({ peerToken: '2'.repeat(32), procStart: record.procStart, pidDomain: 'darwin' }));
  assert.equal(resolveClaudeSession(record.sessionId, { registryDir: setup.registryDir }).token, '2'.repeat(32));
  fs.writeFileSync(keyPath, JSON.stringify({ peerToken: '2'.repeat(32), procStart: 'other', pidDomain: 'darwin' }));
  assert.throws(() => resolveClaudeSession(record.sessionId, { registryDir: setup.registryDir }), /key does not match/);
});

test('Codex host registry accepts an absolute Unix socket endpoint off Windows', { skip: process.platform === 'win32' }, async t => {
  const fixture = await nativeFixture(t);
  const stateDir = path.join(fixture.root, 'state');
  publishCodexHost({ stateDir, pipePath: '/tmp/codex-browser-use/abc.sock', threadId: 'thread-1' });
  assert.equal(getCodexHost({ stateDir }).pipePath, '/tmp/codex-browser-use/abc.sock');
  assert.throws(() => publishCodexHost({ stateDir, pipePath: '/tmp/../x.sock', threadId: 'thread-1' }), /named pipe or absolute Unix socket/);
  assert.throws(() => publishCodexHost({ stateDir, pipePath: 'relative.sock', threadId: 'thread-1' }), /named pipe or absolute Unix socket/);
});
