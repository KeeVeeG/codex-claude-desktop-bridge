import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { canonicalClaudeSocket, discoverClaudeSessions, resolveClaudeCaller, resolveClaudeSession, sendToClaude } from '../lib/claude-desktop.mjs';
import { mockPipe, nativeFixture } from './native-helpers.mjs';

const windowsOnly = { skip: process.platform !== 'win32' && 'Native Claude process metadata and named pipes are Windows-specific.' };
const processStart = process.platform === 'win32'
  ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc().ToString()`], { encoding: 'utf8', windowsHide: true }).stdout.trim()
  : String(Date.now());

async function fixture(t, { entrypoint = 'cli', socketPath } = {}) {
  const setup = await nativeFixture(t);
  const registryDir = path.join(setup.root, 'claude-registry');
  fs.mkdirSync(registryDir);
  socketPath ??= `\\\\.\\pipe\\LOCAL\\cc-msg-${randomUUID().replaceAll('-', '')}`;
  const record = { pid: process.pid, sessionId: randomUUID(), entrypoint,
    procStart: processStart, pidDomain: `win32:${os.hostname().toLowerCase()}`,
    messagingSocketPath: socketPath, cwd: setup.cwd, name: 'CLI fixture', status: 'idle', version: '2.1.299' };
  const recordPath = path.join(registryDir, `${record.pid}.json`);
  const keyPath = path.join(registryDir,
    `${record.pid}.${createHash('sha256').update(canonicalClaudeSocket(socketPath)).digest('hex')}.key`);
  const key = { peerToken: '1'.repeat(32), procStartFt: processStart, pidDomain: record.pidDomain };
  fs.writeFileSync(recordPath, JSON.stringify(record));
  fs.writeFileSync(keyPath, JSON.stringify(key));
  const rewrite = values => {
    Object.assign(record, values);
    fs.writeFileSync(recordPath, JSON.stringify(record));
  };
  return { ...setup, registryDir, record, recordPath, socketPath, keyPath, key, rewrite };
}

function onOpen(t, callback) {
  const open = fs.openSync;
  const mock = t.mock.method(fs, 'openSync', (...args) => {
    callback(args[0]);
    return open(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}

test('Claude discovery includes CLI and SDK CLI alongside Desktop and exposes only session metadata', async t => {
  const setup = await fixture(t);
  const desktop = { ...setup.record, pid: process.ppid, sessionId: randomUUID(), entrypoint: 'claude-desktop' };
  fs.writeFileSync(path.join(setup.registryDir, `${desktop.pid}.json`), JSON.stringify(desktop));
  for (const entrypoint of ['cli', 'sdk-cli']) {
    setup.rewrite({ entrypoint });
    const sessions = discoverClaudeSessions({ registryDir: setup.registryDir });
    assert.equal(sessions.length, 2);
    assert.deepEqual(new Set(sessions.map(session => session.entrypoint)), new Set([entrypoint, 'claude-desktop']));
    assert.equal(sessions.find(session => session.sessionId === setup.record.sessionId).cwd, setup.cwd);
    assert.doesNotMatch(JSON.stringify(sessions), /peerToken|messagingSocketPath|socketPath|resolvedClaudeSession/);
    assert.ok(sessions.every(session => Object.getOwnPropertySymbols(session).length === 0));
  }
});

test('Claude discovery rejects unknown entrypoints even with a live parent and valid key', async t => {
  const setup = await fixture(t);
  for (const entrypoint of ['sdk', 'CLI', 'claude-desktop-other', '', null]) {
    setup.rewrite({ entrypoint });
    assert.deepEqual(discoverClaudeSessions({ registryDir: setup.registryDir }), []);
    assert.throws(() => resolveClaudeSession(setup.record.sessionId, { registryDir: setup.registryDir }), /unavailable/);
    assert.throws(() => resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: process.pid }), /Cannot identify/);
  }
});

test('Claude CLI and SDK CLI callers require their exact direct parent and matching exported inbox', windowsOnly, async t => {
  for (const entrypoint of ['cli', 'sdk-cli']) {
    await t.test(entrypoint, async sub => {
      const setup = await fixture(sub, { entrypoint });
      const caller = resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: process.pid, socketPath: setup.socketPath });
      assert.equal(caller.entrypoint, entrypoint);
      assert.equal(caller.sessionId, setup.record.sessionId);
      assert.equal(caller.token, setup.key.peerToken);
      assert.throws(() => resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: process.ppid,
        socketPath: setup.socketPath }), /Cannot identify/);
      assert.throws(() => resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: process.pid,
        socketPath: '\\\\.\\pipe\\another-session' }), /Cannot identify/);
      setup.key.procStartFt = '1';
      fs.writeFileSync(setup.keyPath, JSON.stringify(setup.key));
      assert.throws(() => resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: process.pid }), /key does not match/);
    });
  }
});

test('CLI clear and resume follow the current exact session ID without retaining an old destination', windowsOnly, async t => {
  const setup = await fixture(t);
  const originalId = setup.record.sessionId;
  assert.equal(resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: process.pid }).sessionId, originalId);
  const nextId = randomUUID();
  setup.rewrite({ sessionId: nextId });
  assert.throws(() => resolveClaudeSession(originalId, { registryDir: setup.registryDir }), /unavailable/);
  assert.equal(resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: process.pid }).sessionId, nextId);
  setup.rewrite({ sessionId: originalId });
  assert.throws(() => resolveClaudeSession(nextId, { registryDir: setup.registryDir }), /unavailable/);
  assert.equal(resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: process.pid }).sessionId, originalId);
});

test('duplicate Claude session IDs across Desktop and CLI remain ambiguous', async t => {
  const setup = await fixture(t);
  fs.writeFileSync(path.join(setup.registryDir, `${process.ppid}.json`), JSON.stringify({
    ...setup.record, pid: process.ppid, entrypoint: 'claude-desktop',
  }));
  assert.throws(() => resolveClaudeSession(setup.record.sessionId, { registryDir: setup.registryDir }), /More than one process/);
  assert.throws(() => resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: process.pid }), /More than one process/);
});

test('resolving a CLI inbox revalidates entrypoint and session changes during the key read', windowsOnly, async t => {
  for (const replacement of [{ entrypoint: 'sdk' }, { entrypoint: 'claude-desktop' }, { sessionId: randomUUID() }]) {
    await t.test(JSON.stringify(replacement), async sub => {
      const setup = await fixture(sub);
      const selectedId = setup.record.sessionId;
      let changed = false;
      onOpen(sub, file => {
        if (file === setup.keyPath && !changed) {
          changed = true;
          setup.rewrite(replacement);
        }
      });
      assert.throws(() => resolveClaudeSession(selectedId, { registryDir: setup.registryDir }), /session changed/);
      assert.equal(changed, true);
    });
  }
});

test('caller rejects an entrypoint replacement between matching the parent and resolving its inbox', windowsOnly, async t => {
  const setup = await fixture(t);
  let reads = 0;
  onOpen(t, file => {
    if (file === setup.recordPath && ++reads === 2) setup.rewrite({ entrypoint: 'claude-desktop' });
  });
  assert.throws(() => resolveClaudeCaller({ registryDir: setup.registryDir, parentPid: process.pid }), /caller changed/);
});

test('resolved Desktop and CLI endpoints preserve issue #1 and send only while the selected identity is current', windowsOnly, async t => {
  for (const entrypoint of ['claude-desktop', 'cli', 'sdk-cli']) {
    await t.test(entrypoint, async sub => {
      const pipe = await mockPipe(sub);
      const setup = await fixture(sub, { entrypoint, socketPath: pipe.pipePath });
      const endpoint = resolveClaudeSession(setup.record.sessionId, { registryDir: setup.registryDir });
      const receipt = await sendToClaude({ ...endpoint, message: 'CLI transport fixture' });
      assert.equal(receipt.status, 'written');
      assert.equal(receipt.acknowledged, false);
      assert.equal(pipe.messages[1].message.session_id, setup.record.sessionId);
      assert.match(pipe.messages[1].message.message.content, /^<cross-session-message\b[^>]* from-mode="bypass">/);
      assert.equal(Object.hasOwn(pipe.messages[1].message, 'from-mode'), false, 'the classification belongs in the peer envelope, not the JSON frame');
      setup.rewrite({ sessionId: randomUUID() });
      await assert.rejects(sendToClaude({ ...endpoint, message: 'Do not send to the replacement' }), error => {
        assert.equal(error.deliveryUnknown, false);
        return true;
      });
      assert.equal(pipe.messages.length, 2, 'the stale send must not write another auth or user frame');
    });
  }
});

test('CLI destination changes after resolution fail before writing credentials or message bytes', windowsOnly, async t => {
  for (const change of ['session', 'entrypoint', 'process-start', 'domain', 'key-token', 'key-start', 'key-domain', 'socket', 'duplicate']) {
    await t.test(change, async sub => {
      const pipe = await mockPipe(sub);
      const setup = await fixture(sub, { socketPath: pipe.pipePath });
      const endpoint = resolveClaudeSession(setup.record.sessionId, { registryDir: setup.registryDir });
      if (change === 'session') setup.rewrite({ sessionId: randomUUID() });
      else if (change === 'entrypoint') setup.rewrite({ entrypoint: 'claude-desktop' });
      else if (change === 'process-start') setup.rewrite({ procStart: '1' });
      else if (change === 'domain') setup.rewrite({ pidDomain: 'win32:different-host' });
      else if (change === 'socket') setup.rewrite({ messagingSocketPath: '\\\\.\\pipe\\replaced-inbox' });
      else if (change === 'duplicate') fs.writeFileSync(path.join(setup.registryDir, `${process.ppid}.json`),
        JSON.stringify({ ...setup.record, pid: process.ppid, entrypoint: 'claude-desktop' }));
      else {
        if (change === 'key-token') setup.key.peerToken = '2'.repeat(32);
        if (change === 'key-start') setup.key.procStartFt = '1';
        if (change === 'key-domain') setup.key.pidDomain = 'win32:different-host';
        fs.writeFileSync(setup.keyPath, JSON.stringify(setup.key));
      }
      await assert.rejects(sendToClaude({ ...endpoint, message: 'Must not reach a replacement conversation' }), error => {
        assert.equal(error.deliveryUnknown, false);
        assert.doesNotMatch(error.message, /11111111111111111111111111111111|22222222222222222222222222222222/);
        return true;
      });
      assert.equal(pipe.messages.length, 0);
    });
  }
});

test('a session resumed in another valid process cannot replace a resolved destination', windowsOnly, async t => {
  const pipe = await mockPipe(t);
  const setup = await fixture(t, { socketPath: pipe.pipePath });
  const endpoint = resolveClaudeSession(setup.record.sessionId, { registryDir: setup.registryDir });
  const start = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${process.ppid}).StartTime.ToFileTimeUtc().ToString()`], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  assert.match(start, /^[0-9]+$/);
  const replacement = { ...setup.record, pid: process.ppid, procStart: start };
  fs.unlinkSync(setup.recordPath);
  fs.writeFileSync(path.join(setup.registryDir, `${replacement.pid}.json`), JSON.stringify(replacement));
  fs.writeFileSync(path.join(setup.registryDir,
    `${replacement.pid}.${createHash('sha256').update(endpoint.socketPath).digest('hex')}.key`),
  JSON.stringify({ ...setup.key, procStartFt: start }));
  assert.equal(resolveClaudeSession(replacement.sessionId, { registryDir: setup.registryDir }).pid, process.ppid);
  await assert.rejects(sendToClaude({ ...endpoint, message: 'Keep the original process identity' }), error => {
    assert.match(error.message, /destination changed/);
    assert.equal(error.deliveryUnknown, false);
    return true;
  });
  assert.equal(pipe.messages.length, 0);
});

test('CLI switch during socket connection is rejected before the payload write', windowsOnly, async t => {
  const pipe = await mockPipe(t);
  const setup = await fixture(t, { socketPath: pipe.pipePath });
  const endpoint = resolveClaudeSession(setup.record.sessionId, { registryDir: setup.registryDir });
  const connect = net.connect;
  let switched = false;
  const mock = t.mock.method(net, 'connect', (...args) => {
    const socket = connect(...args);
    socket.once('connect', () => {
      switched = true;
      setup.rewrite({ sessionId: randomUUID() });
    });
    return socket;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(sendToClaude({ ...endpoint, message: 'Do not cross a clear/resume boundary' }), error => {
    assert.equal(error.deliveryUnknown, false);
    return true;
  });
  assert.equal(switched, true);
  assert.equal(pipe.messages.length, 0);
});
