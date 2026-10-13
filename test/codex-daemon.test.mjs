import assert from 'node:assert/strict';
import test from 'node:test';
import { DaemonUnavailableError, TerminalNotLoadedError, openDaemon, queueToTerminalThread, readDaemonVersions } from '../lib/codex-daemon.mjs';
import { fakeDaemon, fakeQueue } from './codex-daemon-helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { nativeFixture } from './native-helpers.mjs';

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
  const lists = setup.requests().filter(entry => entry.method === 'thread/turns/list');
  assert.equal(lists.length, 1);
  assert.deepEqual(lists[0].params, { threadId: 'busy-turn', limit: 1 });
  assert.equal(setup.requests().some(entry => entry.method === 'thread/read' && entry.params?.includeTurns === true), false);
});

test('the running turn of a long busy session is found with a single bounded turn-list read', async t => {
  const turns = Array.from({ length: 60 }, (_, index) => ({ id: `turn-${index}`, status: 'completed' }));
  turns.push({ id: 'turn-last', status: 'inProgress' });
  const setup = await fakeDaemon(t, { threads: [{ id: 'long', originator: 'codex-tui', status: { type: 'active' }, turns }] });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  const result = await sendToTerminalThread(connection, { threadId: 'long', text: 'hello', messageId: 'm-long' });
  assert.deepEqual(result, { method: 'turn/steer', turnId: 'turn-last' });
  assert.equal(setup.requests().find(entry => entry.method === 'turn/steer').params.expectedTurnId, 'turn-last');
  const lists = setup.requests().filter(entry => entry.method === 'thread/turns/list');
  assert.equal(lists.length, 1);
  assert.equal(lists[0].params.limit, 1);
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

test('a codex.cmd shim is refused with a clear message instead of throwing from spawn', async t => {
  const fixture = await nativeFixture(t);
  const shim = path.join(fixture.root, 'codex.cmd');
  fs.writeFileSync(shim, '');
  const env = { CODEX_CLAUDE_BRIDGE_CODEX_BIN: shim, CODEX_CLAUDE_BRIDGE_DAEMON: '' };
  await assert.rejects(() => openDaemon({ env }),
    error => error instanceof DaemonUnavailableError && /must point to codex\.exe/.test(error.message));
  assert.equal(await readDaemonVersions({ env }), null);
});

test('an oversize running-turn read while steering is refused cleanly before any write', async t => {
  const huge = 'x'.repeat(9 * 1024 * 1024);
  const setup = await fakeDaemon(t, { threads: [{ id: 'huge', originator: 'codex-tui', status: { type: 'active' },
    turns: [{ id: 'turn-h', status: 'inProgress', items: huge }] }] });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  await assert.rejects(() => sendToTerminalThread(connection, { threadId: 'huge', text: 'x', messageId: 'm' }),
    error => /session history is too large/.test(error.message) && !error.deliveryUnknown);
  assert.equal(setup.requests().some(entry => /turn\/(start|steer)/.test(entry.method)), false);
});

test('terminal titles are collapsed to one line and capped at 200 characters', async t => {
  const preview = `${'line one with words\n'.repeat(30)}`.slice(0, 500);
  const setup = await fakeDaemon(t, { threads: [{ id: 'long', originator: 'codex-tui', preview }] });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  const [entry] = await listTerminalThreads(connection, { limit: 5 });
  assert.ok(entry.title.length > 0 && entry.title.length <= 200);
  assert.equal(/[\r\n]/.test(entry.title), false);
});

test('Windows paths in the proxy stderr are stripped from the unreachable message', async t => {
  const setup = await fakeDaemon(t, { unreachable: true, unreachableStderr: 'cannot connect to C:\\Users\\secret\\codex.sock now\n' });
  await assert.rejects(() => openDaemon({ ...setup.daemon }),
    error => error instanceof DaemonUnavailableError && error.message.includes('<path>') && !/secret/.test(error.message));
});

test('a connection lost after turn/steer was written is delivery-unknown and never falls back to turn/start', async t => {
  const setup = await fakeDaemon(t, { threads: busyThreads, dropAfter: 'turn/steer' });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  await assert.rejects(() => sendToTerminalThread(connection, { threadId: 'busy-turn', text: 'x', messageId: 'm' }),
    error => error.deliveryUnknown === true);
  assert.equal(setup.requests().some(entry => entry.method === 'turn/start'), false);
});

test('a notLoaded thread is refused with TerminalNotLoadedError before any write', async t => {
  const setup = await fakeDaemon(t, { threads });
  const connection = await openDaemon({ ...setup.daemon });
  t.after(() => connection.close());
  await assert.rejects(() => sendToTerminalThread(connection, { threadId: 'cold-1', text: 'x', messageId: 'm' }),
    error => error instanceof TerminalNotLoadedError && error.name === 'TerminalNotLoadedError' &&
      /not loaded/.test(error.message) && !error.deliveryUnknown);
});

const QUEUE_ID = '01a13000-0000-7000-8000-000000000001';

test('queueToTerminalThread passes the exact arguments and returns the queue id', async t => {
  const setup = await fakeQueue(t, { mode: 'ok' });
  const text = 'line one\nline "two" and \'three\' back\\slash "C:\\dir\\" a\\\\"b end\\' + '\nnext \u00e9\u4e2d\ud83d\ude00 100% $HOME';
  const result = await queueToTerminalThread({ threadId: 'thr-1', text, ...setup.queue });
  assert.deepEqual(result, { method: 'queue', queueId: QUEUE_ID });
  assert.deepEqual(setup.queueCalls().map(call => call.argv), [['queue', '--thread', 'thr-1', '--message', text]]);
});

test('queueToTerminalThread classifies outcomes: clean failures versus uncertain delivery', async t => {
  const clean = [['notfound', /not found in the Codex thread store/]];
  for (const [mode, pattern] of clean) {
    const setup = await fakeQueue(t, { mode });
    await assert.rejects(() => queueToTerminalThread({ threadId: 'thr-1', text: 'x', ...setup.queue }),
      error => pattern.test(error.message) && !error.deliveryUnknown, mode);
  }
  for (const mode of ['fail', 'garbage', 'wrongthread']) {
    const setup = await fakeQueue(t, { mode });
    await assert.rejects(() => queueToTerminalThread({ threadId: 'thr-1', text: 'x', ...setup.queue }),
      error => error.deliveryUnknown === true && /Delivery is uncertain/.test(error.message), mode);
  }
});

test('a hanging queue process times out as uncertain and promptly', async t => {
  const setup = await fakeQueue(t, { mode: 'hang' });
  const started = Date.now();
  await assert.rejects(() => queueToTerminalThread({ threadId: 'thr-1', text: 'x', timeoutMs: 400, ...setup.queue }),
    error => error.deliveryUnknown === true);
  assert.ok(Date.now() - started < 5000);
});

test('an abort after the queue process started is uncertain', async t => {
  const setup = await fakeQueue(t, { mode: 'hang' });
  const controller = new AbortController();
  const pending = queueToTerminalThread({ threadId: 'thr-1', text: 'x', signal: controller.signal, ...setup.queue });
  const outcome = assert.rejects(() => pending, error => error.deliveryUnknown === true);
  for (let i = 0; i < 200 && setup.queueCalls().length === 0; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(setup.queueCalls().length, 1);
  controller.abort();
  await outcome;
});

test('queue pre-spawn refusals never start a process and are not uncertain', async t => {
  const setup = await fakeQueue(t, { mode: 'ok' });
  await assert.rejects(() => queueToTerminalThread({ threadId: 'thr-1', text: 'x'.repeat(16001), ...setup.queue }),
    error => /too long/.test(error.message) && !error.deliveryUnknown);
  await assert.rejects(() => queueToTerminalThread({ threadId: 'thr-1', text: 'a\0b', ...setup.queue }),
    error => /NUL character/.test(error.message) && !error.deliveryUnknown);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => queueToTerminalThread({ threadId: 'thr-1', text: 'x', signal: controller.signal, ...setup.queue }),
    error => error.name === 'AbortError' && !error.deliveryUnknown);
  assert.equal(setup.queueCalls().length, 0);
});

test('a queue executable that cannot start is a clean failure', async t => {
  const fixture = await nativeFixture(t);
  await assert.rejects(() => queueToTerminalThread({ threadId: 'thr-1', text: 'x', command: path.join(fixture.root, 'missing.exe') }),
    error => error.message === 'The Codex executable could not be started.' && !error.deliveryUnknown);
});

test('the queue route honors the kill switch and refuses a codex.cmd shim', async t => {
  await assert.rejects(() => queueToTerminalThread({ threadId: 'x', text: 'y', env: { PATH: process.env.PATH } }),
    error => error instanceof DaemonUnavailableError && /disabled/.test(error.message));
  const fixture = await nativeFixture(t);
  const shim = path.join(fixture.root, 'codex.cmd');
  fs.writeFileSync(shim, '');
  await assert.rejects(() => queueToTerminalThread({ threadId: 'x', text: 'y',
    env: { CODEX_CLAUDE_BRIDGE_CODEX_BIN: shim, CODEX_CLAUDE_BRIDGE_DAEMON: '' } }),
    error => error instanceof DaemonUnavailableError && /must point to codex\.exe/.test(error.message));
});
