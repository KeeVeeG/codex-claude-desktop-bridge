import assert from 'node:assert/strict';
import test from 'node:test';
import { DaemonUnavailableError, openDaemon } from '../lib/codex-daemon.mjs';
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
