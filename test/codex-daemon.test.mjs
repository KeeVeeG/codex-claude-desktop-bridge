import assert from 'node:assert/strict';
import test from 'node:test';
import { DaemonUnavailableError, openDaemon, readDaemonVersions } from '../lib/codex-daemon.mjs';
import { fakeDaemon } from './codex-daemon-helpers.mjs';

test('openDaemon completes the WebSocket upgrade, initializes, and answers requests', async t => {
  const setup = await fakeDaemon(t, { threads: [{ id: 'a', originator: 'codex-tui' }] });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  const result = await connection.request('thread/list', { limit: 5 });
  assert.equal(result.data[0].id, 'a');
  assert.deepEqual(setup.requests().map(entry => entry.method), ['initialize', 'initialized', 'thread/list']);
});

test('a JSON-RPC error rejects with its code and message and is not delivery-unknown for reads', async t => {
  const setup = await fakeDaemon(t, { threads: [] });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  await assert.rejects(() => connection.request('thread/read', { threadId: 'missing' }),
    error => error.rpcCode === -32600 && /thread not found/.test(error.rpcMessage) && !error.deliveryUnknown);
});

test('an unreachable daemon is reported as unavailable and is never started', async t => {
  const setup = await fakeDaemon(t, { unreachable: true });
  await assert.rejects(() => openDaemon({ ...setup.daemon }),
    error => error instanceof DaemonUnavailableError && /not reachable/.test(error.message));
});

test('a missing Codex executable and the kill switch are reported as unavailable', async () => {
  await assert.rejects(() => openDaemon({ env: { CODEX_CLAUDE_BRIDGE_DAEMON: '', CODEX_CLAUDE_BRIDGE_CODEX_BIN: '', PATH: '' } }),
    error => error instanceof DaemonUnavailableError && /not found/.test(error.message));
  // A partial env must not lift the kill switch forced on the test process.
  await assert.rejects(() => openDaemon({ env: { PATH: process.env.PATH } }),
    error => error instanceof DaemonUnavailableError && /disabled/.test(error.message));
  await assert.rejects(() => openDaemon({ env: { CODEX_CLAUDE_BRIDGE_DAEMON: 'off' } }),
    error => error instanceof DaemonUnavailableError && /disabled/.test(error.message));
});

test('the supplied environment reaches the proxy, so an isolated CODEX_HOME selects its own daemon', async t => {
  const setup = await fakeDaemon(t, { threads: [] });
  const connection = await openDaemon({ ...setup.daemon, env: { CODEX_HOME: 'X:/isolated-codex-home' } });
  t.after(() => connection.close());
  assert.equal(setup.requests().find(entry => entry.method === 'initialize').codexHome, 'X:/isolated-codex-home');
});

test('a server-initiated request that reuses a pending id is ignored and the real answer still arrives', async t => {
  const setup = await fakeDaemon(t, { threads: [{ id: 'a', originator: 'codex-tui' }], serverRequestBefore: 'thread/list' });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  const result = await connection.request('thread/list', {});
  assert.equal(result.data[0].id, 'a');
});

test('a response with neither result nor error fails the connection and a written mutating request is delivery-unknown', async t => {
  const setup = await fakeDaemon(t, { threads: [], malformed: 'turn/start' });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  await assert.rejects(() => connection.request('turn/start', { threadId: 'x' }, { mutating: true }),
    error => error.deliveryUnknown === true && /malformed response/.test(error.message));
});

test('closing the connection settles a pending request instead of leaving it hanging', async t => {
  const setup = await fakeDaemon(t, { threads: [], silent: 'thread/read' });
  const connection = await openDaemon({ ...setup.daemon });
  const pending = connection.request('thread/read', { threadId: 'x' }, { timeoutMs: 60000 });
  await new Promise(resolve => setTimeout(resolve, 150));
  connection.close();
  await assert.rejects(() => pending, /connection was closed/);
});

test('a pre-aborted signal cancels before any process starts', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => openDaemon({ command: process.execPath, args: ['-e', 'process.exit(1)'], signal: controller.signal }),
    error => error.name === 'AbortError');
});

test('a connection lost after a mutating request was written is delivery-unknown', async t => {
  const setup = await fakeDaemon(t, { threads: [], dropAfter: 'turn/start' });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  await assert.rejects(() => connection.request('turn/start', { threadId: 'x' }, { mutating: true }),
    error => error.deliveryUnknown === true && /uncertain/.test(error.message));
});

import { isTerminalThread, listTerminalThreads, readTerminalThread, sendToTerminalThread } from '../lib/codex-daemon.mjs';

const threads = [
  { id: 'desk-1', originator: 'Codex Desktop', name: 'Desktop chat' },
  { id: 'term-1', originator: 'codex-tui', name: 'Terminal one', cwd: 'F:/repo' },
  { id: 'exec-1', originator: 'codex_exec', name: 'Exec' },
  { id: 'term-2', originator: 'codex-tui', preview: 'Preview only' },
  { id: 'busy-1', originator: 'codex-tui', name: 'Busy', status: { type: 'active' } },
  { id: 'cold-1', originator: 'codex-tui', name: 'Cold', status: { type: 'notLoaded' } },
];

test('listTerminalThreads keeps only terminal sessions, follows pagination, and honors the limit', async t => {
  const setup = await fakeDaemon(t, { threads, pageSize: 2 });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  const all = await listTerminalThreads(connection, { limit: 30 });
  assert.deepEqual(all.map(chat => chat.thread_id), ['term-1', 'term-2', 'busy-1', 'cold-1']);
  assert.deepEqual(all[0], { thread_id: 'term-1', title: 'Terminal one', status: 'idle', cwd: 'F:/repo', host_id: 'local', source: 'terminal' });
  assert.equal(all[1].title, 'Preview only');
  assert.deepEqual((await listTerminalThreads(connection, { limit: 2 })).map(chat => chat.thread_id), ['term-1', 'term-2']);
});

test('readTerminalThread returns null for an unknown thread and isTerminalThread checks the originator', async t => {
  const setup = await fakeDaemon(t, { threads });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  assert.equal(await readTerminalThread(connection, 'nope'), null);
  assert.equal(isTerminalThread(await readTerminalThread(connection, 'term-1')), true);
  assert.equal(isTerminalThread(await readTerminalThread(connection, 'desk-1')), false);
  assert.equal(isTerminalThread(null), false);
});

test('sendToTerminalThread starts a turn on an idle thread with exactly the allowed parameters', async t => {
  const setup = await fakeDaemon(t, { threads });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  const result = await sendToTerminalThread(connection, { threadId: 'term-1', text: 'hello', messageId: 'msg-1' });
  assert.deepEqual(result, { method: 'turn/start', turnId: 'turn-started' });
  const sent = setup.requests().filter(entry => entry.method === 'turn/start');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].params, { threadId: 'term-1', input: [{ type: 'text', text: 'hello' }], clientUserMessageId: 'msg-1' });
  assert.equal(setup.requests().some(entry => /resume|inject_items/.test(entry.method)), false);
});

test('a send that cannot start is refused before any write and is not delivery-unknown', async t => {
  const setup = await fakeDaemon(t, { threads });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  for (const [threadId, pattern] of [['desk-1', /not a terminal session/], ['missing', /not a terminal session/], ['cold-1', /not loaded/]]) {
    await assert.rejects(() => sendToTerminalThread(connection, { threadId, text: 'x', messageId: 'm' }),
      error => pattern.test(error.message) && !error.deliveryUnknown, threadId);
  }
  assert.equal(setup.requests().some(entry => entry.method === 'turn/start'), false);
});

test('a pre-acceptance message with the wrong code, and pre-write transport failures, are classified correctly', async t => {
  const wrongCode = await fakeDaemon(t, { threads, errors: { 'turn/start': { code: -32603, message: 'thread not found: term-1' } } });
  let connection = await openDaemon({ ...wrongCode.daemon });
  await assert.rejects(() => sendToTerminalThread(connection, { threadId: 'term-1', text: 'x', messageId: 'm' }),
    error => error.deliveryUnknown === true);
  connection.close();
  const aborted = await fakeDaemon(t, { threads });
  connection = await openDaemon({ ...aborted.daemon });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => sendToTerminalThread(connection, { threadId: 'term-1', text: 'x', messageId: 'm', signal: controller.signal }),
    error => error.name === 'AbortError' && !error.deliveryUnknown);
  assert.equal(aborted.requests().some(entry => entry.method === 'turn/start'), false);
  connection.close();
});

test('error classification: proven pre-acceptance rejections fail cleanly, everything else is delivery-unknown', async t => {
  const clean = await fakeDaemon(t, { threads, errors: { 'turn/start': { code: -32600, message: 'thread not found: term-1' } } });
  let connection = await openDaemon({ ...clean.daemon });
  await assert.rejects(() => sendToTerminalThread(connection, { threadId: 'term-1', text: 'x', messageId: 'm' }),
    error => !error.deliveryUnknown);
  connection.close();
  const unknown = await fakeDaemon(t, { threads, errors: { 'turn/start': { code: -32603, message: 'internal error' } } });
  connection = await openDaemon({ ...unknown.daemon });
  await assert.rejects(() => sendToTerminalThread(connection, { threadId: 'term-1', text: 'x', messageId: 'm' }),
    error => error.deliveryUnknown === true && /uncertain/.test(error.message));
  connection.close();
  const dropped = await fakeDaemon(t, { threads, dropAfter: 'turn/start' });
  connection = await openDaemon({ ...dropped.daemon });
  await assert.rejects(() => sendToTerminalThread(connection, { threadId: 'term-1', text: 'x', messageId: 'm' }),
    error => error.deliveryUnknown === true);
  connection.close();
});

test('the version check honors the kill switch from the process environment but not for an injected command', async () => {
  assert.equal(await readDaemonVersions({ env: { PATH: process.env.PATH } }), null);
  assert.deepEqual(await readDaemonVersions({ env: { PATH: process.env.PATH }, command: process.execPath,
    args: ['-e', "console.log(JSON.stringify({cliVersion:'1',appServerVersion:'2'}))"] }), { cli: '1', server: '2' });
});

const busyThreads = [
  { id: 'busy-turn', originator: 'codex-tui', status: { type: 'active' }, turns: [{ id: 'turn-a', status: 'completed' }, { id: 'turn-b', status: 'inProgress' }] },
  { id: 'busy-noturn', originator: 'codex-tui', status: { type: 'active' }, turns: [{ id: 'turn-a', status: 'completed' }] },
];

test('a busy terminal session is steered with the active turn id and no other parameters', async t => {
  const setup = await fakeDaemon(t, { threads: busyThreads });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  const result = await sendToTerminalThread(connection, { threadId: 'busy-turn', text: 'hello', messageId: 'm-steer' });
  assert.deepEqual(result, { method: 'turn/steer', turnId: 'turn-b' });
  const steer = setup.requests().find(entry => entry.method === 'turn/steer');
  assert.deepEqual(steer.params, { threadId: 'busy-turn', expectedTurnId: 'turn-b', input: [{ type: 'text', text: 'hello' }] });
  assert.equal(setup.requests().some(entry => entry.method === 'turn/start'), false);
});

test('a busy session with no identifiable active turn is refused before any write', async t => {
  const setup = await fakeDaemon(t, { threads: busyThreads });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  await assert.rejects(() => sendToTerminalThread(connection, { threadId: 'busy-noturn', text: 'x', messageId: 'm' }),
    error => /busy/.test(error.message) && !error.deliveryUnknown);
  assert.equal(setup.requests().some(entry => /turn\/(start|steer)/.test(entry.method)), false);
});

test('a stale steer falls back to exactly one turn/start only when the thread has gone idle', async t => {
  const stale = { code: -32600, message: 'no active turn to steer' };
  const idle = await fakeDaemon(t, { threads: [{ id: 'race', originator: 'codex-tui', status: { type: 'active' },
    turns: [{ id: 'turn-x', status: 'inProgress' }], becomesIdleAfterSteer: true }], errors: { 'turn/steer': stale } });
  const connection = await openDaemon({ ...idle.daemon });
  t.after(() => connection.close());
  const result = await sendToTerminalThread(connection, { threadId: 'race', text: 'x', messageId: 'm-race' });
  assert.equal(result.method, 'turn/start');
  assert.equal(idle.requests().filter(entry => entry.method === 'turn/start').length, 1);
});

test('a steer rejected for a turn-id mismatch is stale and falls back to exactly one turn/start only when the thread is now idle', async t => {
  const mismatch = { code: -32600, message: 'expected active turn id `turn-x` but found `turn-y`' };
  const idle = await fakeDaemon(t, { threads: [{ id: 'mismatch', originator: 'codex-tui', status: { type: 'active' },
    turns: [{ id: 'turn-x', status: 'inProgress' }], becomesIdleAfterSteer: true }], errors: { 'turn/steer': mismatch } });
  const connection = await openDaemon({ ...idle.daemon });
  t.after(() => connection.close());
  const result = await sendToTerminalThread(connection, { threadId: 'mismatch', text: 'x', messageId: 'm-mismatch' });
  assert.equal(result.method, 'turn/start');
  assert.equal(idle.requests().filter(entry => entry.method === 'turn/start').length, 1);
});

test('an internal error that merely mentions an expected turn is never treated as a stale steer', async t => {
  const setup = await fakeDaemon(t, { threads: [{ id: 'internal', originator: 'codex-tui', status: { type: 'active' },
    turns: [{ id: 'turn-x', status: 'inProgress' }], becomesIdleAfterSteer: true }],
  errors: { 'turn/steer': { code: -32603, message: 'internal error: expected turn state was corrupt' } } });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  await assert.rejects(() => sendToTerminalThread(connection, { threadId: 'internal', text: 'x', messageId: 'm' }),
    error => error.deliveryUnknown === true);
  assert.equal(setup.requests().some(entry => entry.method === 'turn/start'), false);
});

test('a stale steer on a thread that is still busy fails without delivery and without a fallback', async t => {
  const setup = await fakeDaemon(t, { threads: [{ id: 'still', originator: 'codex-tui', status: { type: 'active' },
    turns: [{ id: 'turn-x', status: 'inProgress' }] }], errors: { 'turn/steer': { code: -32600, message: 'no active turn to steer' } } });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  await assert.rejects(() => sendToTerminalThread(connection, { threadId: 'still', text: 'x', messageId: 'm' }),
    error => /changed turns/.test(error.message) && !error.deliveryUnknown);
  assert.equal(setup.requests().some(entry => entry.method === 'turn/start'), false);
});
