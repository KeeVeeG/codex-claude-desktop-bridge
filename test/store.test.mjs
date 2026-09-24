import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  defaultStateDir, createSession, getSession, loadSession, readSession, updateSession,
  recordMessage, finishMessage, getMessages, withStateLock,
} from '../lib/store.mjs';
import { nativeFixture as fixture } from './native-helpers.mjs';

test('both Windows desktop packages use the same home-based state directory', async t => {
  const setup = await fixture(t);
  const homeDir = path.join(setup.root, 'user-home');
  const codex = defaultStateDir({ homeDir, env: { LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local', 'Packages', 'OpenAI.Codex', 'LocalCache', 'Local') } });
  const claude = defaultStateDir({ homeDir, env: { LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local', 'Packages', 'Claude', 'LocalCache', 'Local') } });
  assert.equal(codex, claude);
  assert.equal(codex, path.join(homeDir, '.local', 'share', 'codex-claude-desktop-bridge'));
  const override = path.join(setup.root, 'explicit-shared-state');
  assert.equal(defaultStateDir({ homeDir, env: { LOCALAPPDATA: 'ignored', CODEX_CLAUDE_BRIDGE_STATE_DIR: override } }), override);
});

test('default shared state location is independent of the project working directory', async t => {
  const setup = await fixture(t);
  const otherCwd = path.join(setup.root, 'another-project');
  fs.mkdirSync(otherCwd);
  const homeDir = path.join(setup.root, 'user-home');
  const moduleUrl = new URL('../lib/store.mjs', import.meta.url).href;
  const script = `import { defaultStateDir } from ${JSON.stringify(moduleUrl)}; process.stdout.write(defaultStateDir({ homeDir: process.argv[1], env: {} }));`;
  for (const cwd of [setup.cwd, otherCwd]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, homeDir], { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, defaultStateDir({ homeDir, env: {} }));
  }
});

test('fresh sessions have independent message histories in the same project', async t => {
  const setup = await fixture(t);
  const first = createSession({ ...setup, threadId: 'chat-one' });
  const second = createSession({ ...setup, threadId: 'chat-two' });
  assert.notEqual(first.key, second.key);
  assert.equal(first.cwd, second.cwd);
  assert.deepEqual(Object.keys(readSession(first)).sort(), [
    'schemaVersion', 'key', 'threadId', 'cwd', 'createdAt', 'desktop', 'messages',
  ].sort());
  assert.equal(readSession(first).desktop, null);
  const sent = recordMessage(first, { direction: 'to_claude', message: 'This is just information.' });
  assert.equal(sent.created, true);
  assert.equal(sent.message.status, 'sending');
  assert.deepEqual(getMessages(second), []);
  assert.throws(() => finishMessage(second, sent.message.id, { status: 'submitted' }), /does not belong/);
  assert.equal(getSession({ stateDir: setup.stateDir, threadId: 'chat-one' }).key, first.key);
  assert.equal(loadSession({ stateDir: setup.stateDir, sessionKey: second.key }).threadId, 'chat-two');
  assert.equal(getSession({ stateDir: setup.stateDir, threadId: 'unknown' }), null);
});

test('both directions allow multiple messages without deadlines or a required reply', async t => {
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 'asynchronous' });
  for (const [id, direction] of [['one', 'to_claude'], ['two', 'to_claude'], ['three', 'to_codex'], ['four', 'to_codex']]) {
    const result = recordMessage(session, { id, direction, message: `Informational message ${id}.` });
    assert.equal(result.created, true);
    assert.equal(result.message.direction, direction);
    assert.equal(result.message.status, 'sending');
    assert.equal('deadlineAt' in result.message, false);
    assert.equal('timeoutSeconds' in result.message, false);
    assert.equal('reply' in result.message, false);
  }
  updateSession(session, state => { state.messages.one.createdAt = 1; });
  assert.equal(getMessages(session).length, 4);
  assert.equal(getMessages(session).find(item => item.id === 'one').status, 'sending');
  assert.equal('activeRequestId' in readSession(session), false);
});

test('same message ID is idempotent after uncertain outcomes and rejects changed content or direction', async t => {
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 'idempotent' });
  const input = { id: 'stable-id', direction: 'to_claude', message: 'Update received.' };
  const first = recordMessage(session, input);
  assert.equal(first.created, true);
  assert.deepEqual(recordMessage(session, input), { ...first, created: false });
  finishMessage(session, input.id, { status: 'uncertain', error: { message: 'Connection closed.', deliveryUnknown: true } });
  const repeated = recordMessage(session, input);
  assert.equal(repeated.created, false);
  assert.equal(repeated.message.status, 'uncertain');
  for (const changed of [
    { ...input, message: 'Different body.' }, { ...input, direction: 'to_codex' },
  ]) assert.throws(() => recordMessage(session, changed), /different content or direction/);
  assert.equal(getMessages(session).length, 1);
  assert.equal(recordMessage(session, { ...input, id: 'another-id' }).created, true);
});

test('transport outcomes persist independently and do not block later messages', async t => {
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 'outcomes' });
  for (const status of ['submitted', 'failed', 'uncertain']) {
    recordMessage(session, { id: status, direction: 'to_codex', message: `${status} test.` });
    const result = finishMessage(session, status, {
      status, error: status === 'submitted' ? undefined : { message: 'Transport issue.' },
      receipt: status === 'submitted' ? { accepted: true } : undefined,
    });
    assert.equal(result.status, status);
    assert.ok(result.updatedAt >= result.createdAt);
  }
  assert.deepEqual(getMessages(session).find(message => message.id === 'submitted').receipt, { accepted: true });
  assert.deepEqual(getMessages(session).find(message => message.id === 'failed').error, { message: 'Transport issue.' });
  assert.throws(() => finishMessage(session, 'failed', { status: 'completed' }), /status must/);
  assert.throws(() => finishMessage(session, 'not-found', { status: 'submitted' }), /does not belong/);
  assert.equal(getMessages(session).length, 3);
});

test('old schema 1 task history is retained but never controls new messaging', async t => {
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 'legacy' });
  const legacy = readSession(session);
  delete legacy.messages;
  delete legacy.desktop;
  legacy.activeRequestId = 'unfinished';
  legacy.requests = { unfinished: { id: 'unfinished', status: 'working', deadlineAt: 1 } };
  fs.writeFileSync(session.stateFile, JSON.stringify(legacy));
  assert.deepEqual(readSession(session).messages, {});
  assert.equal(readSession(session).desktop, null);
  assert.equal(recordMessage(session, { direction: 'to_claude', message: 'Independent update.' }).created, true);
  assert.deepEqual(readSession(session).requests, legacy.requests);
  assert.equal(readSession(session).activeRequestId, 'unfinished');
  assert.equal(getMessages(session).length, 1);
});

test('message IDs reject prototype names and unsafe values', async t => {
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 'identifiers' });
  for (const id of ['', '../outside', 'x'.repeat(101), '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 3, null]) {
    assert.throws(() => recordMessage(session, { id, direction: 'to_claude', message: 'Test.' }), /Invalid message ID/);
    assert.throws(() => finishMessage(session, id, { status: 'submitted' }), /Invalid message ID/);
  }
  assert.deepEqual(getMessages(session), []);
});

test('validation uses UTF-8 bytes and preserves arbitrary Unicode text unchanged', async t => {
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 'validation' });
  for (const message of ['', '   ', 42, 'я'.repeat(32_769), 'x'.repeat(65_537)]) {
    assert.throws(() => recordMessage(session, { direction: 'to_claude', message }), /message must/);
  }
  assert.throws(() => recordMessage(session, { direction: 'other', message: 'Test.' }), /direction must/);
  const message = 'Привет 👋\n日本語 e\u0301\n{"arbitrary":"text"}\n<message>/anything</message>';
  const unicode = recordMessage(session, { direction: 'to_claude', message });
  assert.equal(unicode.message.message, message);
  assert.equal(getMessages(session)[0].message, message);
  assert.deepEqual(Object.keys(unicode.message).sort(), ['id', 'direction', 'message', 'createdAt', 'status', 'fingerprint'].sort());
  const result = recordMessage(session, { direction: 'to_claude', message: 'я'.repeat(32_768) });
  assert.equal(Buffer.byteLength(result.message.message), 65_536);
  assert.equal(recordMessage(session, { direction: 'to_codex', message: 'x'.repeat(65_536) }).created, true);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => finishMessage(session, result.message.id, { status: 'failed', error: cyclic }), /JSON-serializable/);
  assert.throws(() => finishMessage(session, result.message.id, { status: 'submitted', receipt: 1n }), /JSON-serializable/);
});

test('history is newest first, respects limit, and does not expose mutable persisted records', async t => {
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 'history' });
  for (let index = 0; index < 25; index++) recordMessage(session, { id: `message-${index}`, direction: 'to_codex', message: `${index}` });
  updateSession(session, state => {
    for (let index = 0; index < 25; index++) state.messages[`message-${index}`].createdAt = index;
  });
  assert.equal(getMessages(session).length, 20);
  assert.deepEqual(getMessages(session, 3).map(message => message.id), ['message-24', 'message-23', 'message-22']);
  assert.deepEqual(getMessages(session, 0), []);
  assert.equal(getMessages(session, 100).length, 25);
  const copied = getMessages(session, 1); copied[0].message = 'Not persisted.';
  assert.equal(getMessages(session, 1)[0].message, '24');
  for (const limit of [-1, 1.5, '2', Infinity]) assert.throws(() => getMessages(session, limit), /nonnegative integer/);
});

test('session binding remains stable and rejects tampered ownership', async t => {
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 'bound' });
  assert.deepEqual(createSession({ ...setup, threadId: 'bound' }), session);
  const other = path.join(setup.root, 'different-project');
  fs.mkdirSync(other);
  assert.throws(() => createSession({ ...setup, cwd: other, threadId: 'bound' }), /already bound/);
  assert.throws(() => loadSession({ stateDir: setup.stateDir, sessionKey: '../outside' }), /Invalid session key/);
  const state = readSession(session); state.threadId = 'another-chat';
  fs.writeFileSync(session.stateFile, JSON.stringify(state));
  assert.throws(() => readSession(session), /Invalid bridge state/);
});

test('connection updates and generic locks persist and release on callback errors', async t => {
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 'connection' });
  updateSession(session, state => { state.desktop = { claudeSessionId: 'selected' }; });
  assert.deepEqual(readSession(session).desktop, { claudeSessionId: 'selected' });
  const lockDir = path.join(setup.root, 'binding-lock');
  assert.throws(() => withStateLock(lockDir, () => { throw new Error('callback failed'); }), /callback failed/);
  assert.equal(withStateLock(lockDir, () => 'available'), 'available');
  assert.equal(fs.existsSync(path.join(lockDir, 'state.lock')), false);
});

test('new pair history excludes previous pairs and unscoped legacy messages without deleting them', async t => {
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 're-paired-history' });
  recordMessage(session, { id: 'legacy', direction: 'to_claude', message: 'Legacy conversation.' });
  recordMessage(session, { id: 'a', pairId: 'pair-a', direction: 'to_claude', message: 'Private to Claude A.' });
  recordMessage(session, { id: 'b', pairId: 'pair-b', direction: 'to_codex', message: 'From Claude B.' });
  assert.deepEqual(getMessages(session, 20, 'pair-a').map(record => record.message), ['Private to Claude A.']);
  assert.deepEqual(getMessages(session, 20, 'pair-b').map(record => record.message), ['From Claude B.']);
  assert.deepEqual(getMessages(session, 20, 'pair-c'), []);
  assert.equal(getMessages(session).length, 3);
  assert.deepEqual(Object.keys(readSession(session).messages), ['legacy', 'pair-a:a', 'pair-b:b']);
});

test('the same external message ID belongs independently to each pair', async t => {
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 're-paired-ids' });
  const input = { id: 'same-id', direction: 'to_claude', message: 'Same text is independent.' };
  const oldMessage = recordMessage(session, { ...input, pairId: 'pair-a' });
  const newMessage = recordMessage(session, { ...input, pairId: 'pair-b' });
  assert.equal(oldMessage.created, true);
  assert.equal(newMessage.created, true);
  assert.equal(recordMessage(session, { ...input, pairId: 'pair-a' }).created, false);
  assert.equal(recordMessage(session, { ...input, pairId: 'pair-b' }).created, false);
  assert.throws(() => recordMessage(session, { ...input, pairId: 'pair-b', message: 'Changed body.' }), /different content/);
  assert.equal(recordMessage(session, { ...input, pairId: 'pair-c', message: 'Changed body.' }).created, true);
  assert.throws(() => finishMessage(session, input.id, { status: 'submitted' }), /does not belong/);
});

test('direct messages with one ID are independent for each sender and recipient', async t => {
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 'direct-routes' });
  const codex = { kind: 'codex', id: 'codex-chat' };
  const claudeA = { kind: 'claude', id: 'claude-a' };
  const claudeB = { kind: 'claude', id: 'claude-b' };
  const toA = { from: codex, to: claudeA };
  const toB = { from: codex, to: claudeB };
  const fromA = { from: claudeA, to: codex };
  const input = { id: 'shared-id', direction: 'to_claude', message: 'Hello.', route: toA };

  assert.equal(recordMessage(session, input).created, true);
  assert.equal(recordMessage(session, { ...input, route: toB }).created, true);
  assert.equal(recordMessage(session, { ...input, direction: 'to_codex', route: fromA }).created, true);
  assert.equal(recordMessage(session, input).created, false);
  assert.throws(() => recordMessage(session, { ...input, message: 'Changed text.' }), /different content/);
  assert.throws(() => recordMessage(session, { ...input, direction: 'to_codex' }), /direction does not match/);
  assert.throws(() => finishMessage(session, 'shared-id', { status: 'submitted' }), /does not belong/);

  const submitted = finishMessage(session, 'shared-id', { route: toA, status: 'submitted', receipt: { accepted: true } });
  assert.deepEqual(submitted.route, toA);
  assert.equal(getMessages(session).find(record => record.route?.to.id === 'claude-a').status, 'submitted');
  assert.equal(getMessages(session).find(record => record.route?.to.id === 'claude-b').status, 'sending');
  assert.equal(getMessages(session).find(record => record.route?.from.kind === 'claude').status, 'sending');
  assert.equal(Object.keys(readSession(session).messages).filter(key => key.startsWith('route:')).length, 3);

  recordMessage(session, { id: 'legacy', direction: 'to_claude', message: 'Old history.' });
  recordMessage(session, { id: 'paired', pairId: 'old-pair', direction: 'to_claude', message: 'Old pair.' });
  assert.equal(getMessages(session).length, 5);
  assert.equal(getMessages(session, 1, undefined, codex).length, 1);
  assert.equal(getMessages(session, 20, undefined, codex).length, 2);
  assert.equal(getMessages(session, 20, undefined, claudeA).length, 1);
  assert.deepEqual(getMessages(session, 20, undefined, claudeB), []);
  assert.equal(getMessages(session, 20, 'old-pair').length, 1);
});

test('direct message routes reject malformed endpoints and cannot mix with legacy pairs', async t => {
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 'invalid-direct-routes' });
  const codex = { kind: 'codex', id: 'codex-chat' };
  const claude = { kind: 'claude', id: 'claude-chat' };
  const route = { from: codex, to: claude };
  const input = { id: 'one', direction: 'to_claude', message: 'Text.' };
  for (const invalidRoute of [null, {}, { from: codex }, { from: codex, to: codex },
    { from: codex, to: { ...claude, id: '' } }, { from: { ...codex, kind: 'other' }, to: claude },
    { from: codex, to: { ...claude, extra: true } }, { ...route, extra: true }]) {
    assert.throws(() => recordMessage(session, { ...input, route: invalidRoute }), /Invalid message route|must be nonempty/);
    assert.throws(() => finishMessage(session, input.id, { status: 'submitted', route: invalidRoute }), /Invalid message route|must be nonempty/);
  }
  assert.throws(() => recordMessage(session, { ...input, route, pairId: 'old-pair' }), /cannot be combined/);
  assert.throws(() => finishMessage(session, input.id, { route, pairId: 'old-pair', status: 'submitted' }), /cannot be combined/);
  assert.throws(() => getMessages(session, 20, 'old-pair', codex), /cannot be combined/);
  assert.throws(() => getMessages(session, 20, undefined, { ...codex, id: '' }), /must be nonempty/);
});

test('an in-flight outcome from a disconnected pair updates only its own partition', async t => {
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 're-paired-inflight' });
  updateSession(session, state => { state.desktop = { pairId: 'pair-old' }; });
  recordMessage(session, { id: 'inflight', pairId: 'pair-old', direction: 'to_codex', message: 'Old operation.' });
  updateSession(session, state => { state.desktop = { pairId: 'pair-new' }; });
  recordMessage(session, { id: 'inflight', pairId: 'pair-new', direction: 'to_codex', message: 'New operation.' });
  finishMessage(session, 'inflight', { pairId: 'pair-old', status: 'submitted', receipt: { accepted: true } });
  assert.equal(getMessages(session, 20, 'pair-old')[0].status, 'submitted');
  assert.equal(getMessages(session, 20, 'pair-new')[0].status, 'sending');
  assert.equal(getMessages(session, 20, 'pair-new')[0].receipt, undefined);
  finishMessage(session, 'inflight', { pairId: 'pair-new', status: 'uncertain', error: 'New transport closed.' });
  assert.equal(getMessages(session, 20, 'pair-old')[0].status, 'submitted');
  assert.equal(getMessages(session, 20, 'pair-new')[0].status, 'uncertain');
});

test('pair IDs cannot escape their storage partition or masquerade as object properties', async t => {
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 'pair-identifiers' });
  for (const pairId of ['', '../other', 'a:b', 'x'.repeat(101), '__proto__', 'constructor', 'prototype', null, 7]) {
    assert.throws(() => recordMessage(session, { pairId, direction: 'to_codex', message: 'Test.' }), /Invalid pair ID/);
    assert.throws(() => finishMessage(session, 'id', { pairId, status: 'submitted' }), /Invalid pair ID/);
    assert.throws(() => getMessages(session, 20, pairId), /Invalid pair ID/);
  }
});

test('transient Windows rename failures retry the same prepared receipt without duplicate state',
  { skip: process.platform !== 'win32' && 'Windows replacement retry is platform-specific.' }, async t => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      await t.test(code, async sub => {
        const setup = await fixture(sub);
        const session = createSession({ ...setup, threadId: `rename-${code}` });
        recordMessage(session, { id: 'one-message', pairId: 'pair-a', direction: 'to_codex', message: 'Already sent once.' });
        const rename = fs.renameSync;
        const write = fs.writeFileSync;
        const attempts = [];
        let preparedWrites = 0;
        sub.mock.method(fs, 'renameSync', (source, destination) => {
          if (destination === session.stateFile) {
            attempts.push(source);
            if (attempts.length <= 2) throw Object.assign(new Error('Temporary replacement failure'), { code });
          }
          return rename(source, destination);
        });
        sub.mock.method(fs, 'writeFileSync', (target, ...args) => {
          if (typeof target === 'string' && target.startsWith(`${session.stateFile}.`) && target.endsWith('.tmp')) preparedWrites++;
          return write(target, ...args);
        });
        const result = finishMessage(session, 'one-message', { pairId: 'pair-a', status: 'submitted', receipt: { accepted: true } });
        assert.equal(result.status, 'submitted');
        assert.equal(attempts.length, 3);
        assert.equal(new Set(attempts).size, 1, 'replacement retries must reuse the same prepared document');
        assert.equal(preparedWrites, 1);
        assert.equal(getMessages(session, 20, 'pair-a').length, 1);
        assert.equal(getMessages(session, 20, 'pair-a')[0].status, 'submitted');
        assert.deepEqual(fs.readdirSync(session.dir), ['state.json']);
      });
    }
  });

test('non-transient rename errors fail once, preserve the original error, and clean up the temporary document', async t => {
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 'permanent-rename' });
  recordMessage(session, { id: 'one-message', direction: 'to_claude', message: 'Receipt still pending.' });
  const rename = fs.renameSync;
  const expected = Object.assign(new Error('Permanent disk failure'), { code: 'EIO' });
  let attempts = 0;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === session.stateFile) { attempts++; throw expected; }
    return rename(source, destination);
  });
  assert.throws(() => finishMessage(session, 'one-message', { status: 'submitted' }), error => error === expected);
  assert.equal(attempts, 1);
  assert.equal(getMessages(session)[0].status, 'sending');
  assert.deepEqual(fs.readdirSync(session.dir), ['state.json']);
});

test('persistent Windows replacement contention stops at the retry deadline and retains the previous state',
  { skip: process.platform !== 'win32' && 'Windows replacement retry is platform-specific.' }, async t => {
    const setup = await fixture(t);
    const session = createSession({ ...setup, threadId: 'bounded-rename' });
    const rename = fs.renameSync;
    const expected = Object.assign(new Error('Replacement remains busy'), { code: 'EPERM' });
    let attempts = 0;
    let now = 100_000;
    t.mock.method(Date, 'now', () => { now += 250; return now; });
    t.mock.method(fs, 'renameSync', (source, destination) => {
      if (destination === session.stateFile) { attempts++; throw expected; }
      return rename(source, destination);
    });
    let callbacks = 0;
    assert.throws(() => updateSession(session, state => { callbacks++; state.changed = true; }), error => error === expected);
    assert.equal(attempts, 4);
    assert.equal(callbacks, 1, 'retry must never invoke the state mutation twice');
    assert.equal(readSession(session).changed, undefined);
    assert.deepEqual(fs.readdirSync(session.dir), ['state.json']);
  });
