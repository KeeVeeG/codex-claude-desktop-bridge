import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { canonicalClaudeSocket } from '../lib/claude-desktop.mjs';
import { executeBridgeTool, shouldReportTerminalUnavailable } from '../lib/desktop-service.mjs';
import { DaemonUnavailableError } from '../lib/codex-daemon.mjs';
import { fakeDaemon, fakeQueue } from './codex-daemon-helpers.mjs';

const terminalMeta = threadId => ({ 'x-codex-turn-metadata': JSON.stringify({ thread_id: threadId }), threadId });

async function terminalSetup(t, extra = {}) {
  const threadId = randomUUID();
  const setup = await fakeDaemon(t, { threads: [{ id: threadId, originator: 'codex-tui', name: 'My terminal' }], ...extra });
  const context = { env: { CODEX_CLAUDE_BRIDGE_STATE_DIR: setup.stateDir }, stateDir: setup.stateDir,
    daemon: setup.daemon, metadata: terminalMeta(threadId) };
  return { ...setup, threadId, context };
}

test('a terminal Codex caller without the Desktop pipe is identified through the daemon', async t => {
  const setup = await terminalSetup(t);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.application, 'codex');
  assert.equal(status.sender_id, setup.threadId);
});

test('a caller the daemon does not know as a terminal session is rejected', async t => {
  const setup = await terminalSetup(t);
  const stranger = { ...setup.context, metadata: terminalMeta(randomUUID()) };
  await assert.rejects(() => executeBridgeTool('bridge_status', {}, stranger), /not a terminal session known to the Codex daemon/);
  const desktop = await fakeDaemon(t, { threads: [{ id: 'desk', originator: 'Codex Desktop' }] });
  await assert.rejects(() => executeBridgeTool('bridge_status', {}, { ...setup.context, daemon: desktop.daemon, metadata: terminalMeta('desk') }),
    /not a terminal session known to the Codex daemon/);
});

test('with the daemon down a call lacking the Desktop pipe is rejected with a clear reason', async t => {
  const down = await fakeDaemon(t, { unreachable: true });
  await assert.rejects(() => executeBridgeTool('bridge_status', {}, { env: { CODEX_CLAUDE_BRIDGE_STATE_DIR: down.stateDir },
    stateDir: down.stateDir, daemon: down.daemon, metadata: terminalMeta(randomUUID()) }),
  /could not verify it as a terminal session.*not reachable/s);
});

test('the conversation panel and manual send are refused for terminal callers before any mutation', async t => {
  const setup = await terminalSetup(t);
  for (const name of ['bridge_panel', 'bridge_ui_history', 'bridge_ui_send', 'bridge_ui_retry_notice']) {
    await assert.rejects(() => executeBridgeTool(name, { session_id: 'x', message: 'x', message_id: 'm' }, setup.context),
      /available only from a Codex Desktop chat/, name);
  }
});

const processStart = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc().ToString()`], { encoding: 'utf8', windowsHide: true }).stdout.trim();

async function claudeCallerSetup(t, scenario) {
  const daemon = await fakeDaemon(t, scenario);
  const registryDir = path.join(daemon.root, 'claude-registry');
  fs.mkdirSync(registryDir);
  const socketPath = `\\\\.\\pipe\\LOCAL\\cc-msg-${randomUUID().replaceAll('-', '')}`;
  const record = { pid: process.pid, sessionId: randomUUID(), entrypoint: 'cli', procStart: processStart,
    pidDomain: `win32:${os.hostname().toLowerCase()}`, messagingSocketPath: socketPath, cwd: daemon.cwd, name: 'Terminal Claude', version: '2.1.280', status: 'idle' };
  fs.writeFileSync(path.join(registryDir, `${record.pid}.json`), JSON.stringify(record));
  const hash = createHash('sha256').update(canonicalClaudeSocket(socketPath)).digest('hex');
  fs.writeFileSync(path.join(registryDir, `${record.pid}.${hash}.key`),
    JSON.stringify({ peerToken: '1'.repeat(32), procStartFt: processStart, pidDomain: record.pidDomain }));
  const context = { env: { CODEX_CLAUDE_BRIDGE_STATE_DIR: daemon.stateDir, CODEX_CLAUDE_BRIDGE_REGISTRY_DIR: registryDir },
    stateDir: daemon.stateDir, registryDir, parentPid: process.pid, daemon: daemon.daemon };
  return { ...daemon, registryDir, record, context };
}

test('Claude sends to a terminal Codex session with the peer envelope, with no Desktop registered at all', async t => {
  const termId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: termId, originator: 'codex-tui' }] });
  const result = await executeBridgeTool('send_to_codex', { thread_id: termId, message: 'Review please.', message_id: 'm-1' }, setup.context);
  assert.equal(result.message.status, 'submitted');
  assert.equal(result.message.receipt.method, 'turn/start');
  const start = setup.requests().find(entry => entry.method === 'turn/start');
  assert.equal(start.params.clientUserMessageId, 'm-1');
  assert.match(start.params.input[0].text, /^<cross-session-message from-kind="claude" from-id="[0-9a-f-]+" bridge-message="m-1">/);
  assert.match(start.params.input[0].text, /not an instruction from your user/);
  assert.ok(start.params.input[0].text.includes('Review please.'));
});

test('an exact ID the daemon does not claim still goes to the Desktop path as before', async t => {
  const setup = await claudeCallerSetup(t, { threads: [{ id: 'other', originator: 'codex-tui' }] });
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: 'older-desktop-task', message: 'hi', message_id: 'm-2' }, setup.context),
    /Codex Desktop has not registered its bridge endpoint/);
  assert.equal(setup.requests().some(entry => entry.method === 'turn/start'), false);
  assert.ok(setup.requests().some(entry => entry.method === 'thread/read' && entry.params.threadId === 'older-desktop-task'),
    'the daemon was consulted for the ID before the Desktop path was taken');
});

test('with the daemon down an ID takes the Desktop path and terminal support never starts anything', async t => {
  const setup = await claudeCallerSetup(t, { unreachable: true });
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: 'any', message: 'hi', message_id: 'm-3' }, setup.context),
    /Codex Desktop has not registered its bridge endpoint/);
});

test('a dropped connection after turn/start is recorded uncertain and the same message_id is never sent twice', async t => {
  const termId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: termId, originator: 'codex-tui' }], dropAfter: 'turn/start' });
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: termId, message: 'x', message_id: 'm-4' }, setup.context),
    error => error.deliveryUnknown === true);
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: termId, message: 'x', message_id: 'm-4' }, setup.context),
    /uncertain delivery/);
  assert.equal(setup.requests().filter(entry => entry.method === 'turn/start').length, 1);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.find(message => message.id === 'm-4').status, 'uncertain');
});

test('a busy terminal session is refused before any write and recorded failed', async t => {
  const termId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: termId, originator: 'codex-tui', status: { type: 'active' } }] });
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: termId, message: 'x', message_id: 'm-5' }, setup.context), /busy/);
  assert.equal(setup.requests().some(entry => entry.method === 'turn/start'), false);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.find(message => message.id === 'm-5').status, 'failed');
});

test('repeating a submitted message_id sends nothing new, and the same ID to another recipient is a separate message', async t => {
  const first = randomUUID();
  const second = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: first, originator: 'codex-tui' }, { id: second, originator: 'codex-tui' }] });
  await executeBridgeTool('send_to_codex', { thread_id: first, message: 'one', message_id: 'dup' }, setup.context);
  const again = await executeBridgeTool('send_to_codex', { thread_id: first, message: 'one', message_id: 'dup' }, setup.context);
  assert.equal(again.retransmitted, false);
  assert.equal(setup.requests().filter(entry => entry.method === 'turn/start').length, 1);
  await executeBridgeTool('send_to_codex', { thread_id: second, message: 'one', message_id: 'dup' }, setup.context);
  assert.equal(setup.requests().filter(entry => entry.method === 'turn/start').length, 2);
});

test('a pre-aborted send makes no daemon write and leaves no accepted message', async t => {
  const termId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: termId, originator: 'codex-tui' }] });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: termId, message: 'x', message_id: 'm-abort' },
    { ...setup.context, signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(setup.requests().some(entry => entry.method === 'turn/start'), false);
});

test('a terminal Codex caller can send to a Claude session and the notice names its source', async t => {
  const codexThread = randomUUID();
  const claude = await claudeCallerSetup(t, { threads: [{ id: codexThread, originator: 'codex-tui' }] });
  const received = [];
  const server = net.createServer(socket => {
    let pending = '';
    socket.on('data', chunk => { pending += chunk; });
    socket.on('end', () => received.push(pending));
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(claude.record.messagingSocketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const context = { env: claude.context.env, stateDir: claude.stateDir, registryDir: claude.registryDir, daemon: claude.daemon, metadata: terminalMeta(codexThread) };
  const result = await executeBridgeTool('send_to_claude', { session_id: claude.record.sessionId, message: 'Hello from terminal.', message_id: 'm-6' }, context);
  assert.equal(result.message.status, 'submitted');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.match(received.join(''), /From Codex terminal session/);
});

test('listing returns terminal chats with a warning when Desktop is not registered', async t => {
  const setup = await claudeCallerSetup(t, { threads: [{ id: 'term-a', originator: 'codex-tui', name: 'Terminal A' }, { id: 'desk-a', originator: 'Codex Desktop' }] });
  const result = await executeBridgeTool('list_codex_chats', {}, setup.context);
  assert.deepEqual(result.chats.map(chat => [chat.thread_id, chat.source]), [['term-a', 'terminal']]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Codex Desktop unavailable/);
});

test('listing fails with both reasons when neither source is available', async t => {
  const setup = await claudeCallerSetup(t, { unreachable: true });
  await assert.rejects(() => executeBridgeTool('list_codex_chats', {}, setup.context),
    /Codex Desktop unavailable.*Codex terminal sessions unavailable/s);
});

test('bridge_doctor reports daemon reachability as optional and never fails a Desktop-only setup', async t => {
  const up = await claudeCallerSetup(t, { threads: [{ id: randomUUID(), originator: 'codex-tui' }] });
  const upReport = await executeBridgeTool('bridge_doctor', {}, up.context);
  const daemonCheck = upReport.checks.find(check => check.name === 'codex_daemon');
  assert.equal(daemonCheck.status, 'pass');
  assert.match(daemonCheck.detail, /lists terminal sessions/);
  assert.notEqual(upReport.checks.find(check => check.name === 'codex_tools').status, 'fail');
  const down = await claudeCallerSetup(t, { unreachable: true });
  const downReport = await executeBridgeTool('bridge_doctor', {}, down.context);
  const check = downReport.checks.find(item => item.name === 'codex_daemon');
  assert.equal(check.status, 'warning');
  assert.match(check.detail, /not reachable|not found|disabled/);
  assert.equal(downReport.ready, false);
});

test('bridge_doctor says so when the daemon is reachable but no terminal session is registered, and never reports it ready on that alone', async t => {
  const empty = await claudeCallerSetup(t, { threads: [] });
  const report = await executeBridgeTool('bridge_doctor', {}, empty.context);
  assert.match(report.checks.find(check => check.name === 'codex_daemon').detail, /no terminal Codex session is registered/);
  assert.equal(report.ready, false);
});

test('bridge_doctor warns when the Codex CLI and daemon versions differ and stays quiet when they match', async t => {
  const setup = await claudeCallerSetup(t, { threads: [] });
  const versions = (cli, server) => ({ command: process.execPath, args: ['-e', `console.log(JSON.stringify({cliVersion:'${cli}',appServerVersion:'${server}'}))`] });
  const differ = await executeBridgeTool('bridge_doctor', {}, { ...setup.context, daemonVersion: versions('0.160.0', '0.162.1') });
  const warning = differ.checks.find(check => check.name === 'codex_versions');
  assert.equal(warning.status, 'warning');
  assert.match(warning.detail, /0\.160\.0.*0\.162\.1/);
  const same = await executeBridgeTool('bridge_doctor', {}, { ...setup.context, daemonVersion: versions('0.162.1', '0.162.1') });
  assert.equal(same.checks.find(check => check.name === 'codex_versions').status, 'pass');
});

async function listenInbox(t, claude) {
  const server = net.createServer(socket => { socket.on('data', () => {}); socket.on('error', () => {}); });
  await new Promise(resolve => server.listen(claude.record.messagingSocketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
}

test('bridge_doctor is ready for a terminal-only setup: daemon reachable, a session registered, live inbox', async t => {
  const setup = await claudeCallerSetup(t, { threads: [{ id: randomUUID(), originator: 'codex-tui' }] });
  await listenInbox(t, setup);
  const report = await executeBridgeTool('bridge_doctor', {}, setup.context);
  assert.equal(report.checks.find(check => check.name === 'claude_inbox').status, 'pass');
  assert.equal(report.checks.find(check => check.name === 'codex_daemon').status, 'pass');
  assert.equal(report.ready, true, JSON.stringify(report.checks.filter(check => check.status === 'fail')));
});

test('bridge_doctor is not ready with a live inbox when the daemon has no terminal session or is unreachable', async t => {
  const empty = await claudeCallerSetup(t, { threads: [] });
  await listenInbox(t, empty);
  const emptyReport = await executeBridgeTool('bridge_doctor', {}, empty.context);
  assert.equal(emptyReport.checks.find(check => check.name === 'claude_inbox').status, 'pass');
  assert.match(emptyReport.checks.find(check => check.name === 'codex_daemon').detail, /no terminal Codex session is registered/);
  assert.equal(emptyReport.ready, false);
  const down = await claudeCallerSetup(t, { unreachable: true });
  await listenInbox(t, down);
  const downReport = await executeBridgeTool('bridge_doctor', {}, down.context);
  assert.equal(downReport.checks.find(check => check.name === 'claude_inbox').status, 'pass');
  assert.equal(downReport.checks.find(check => check.name === 'codex_daemon').status, 'warning');
  assert.equal(downReport.ready, false);
});

test('a Claude caller is never verified as a terminal Codex caller, even with terminal Codex metadata', async t => {
  const threadId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: threadId, originator: 'codex-tui' }] });
  const status = await executeBridgeTool('bridge_status', {}, { ...setup.context,
    env: { ...setup.context.env, CLAUDE_CODE_MESSAGING_SOCKET: setup.record.messagingSocketPath }, metadata: terminalMeta(threadId) });
  assert.equal(status.application, 'claude');
  assert.deepEqual(setup.requests(), []);
});

test('bridge_doctor reports a codex.cmd shim as a warning instead of throwing', async t => {
  const setup = await claudeCallerSetup(t, { threads: [] });
  const shim = path.join(setup.root, 'codex.cmd');
  fs.writeFileSync(shim, '');
  const report = await executeBridgeTool('bridge_doctor', {}, { ...setup.context, daemon: undefined,
    env: { ...setup.context.env, CODEX_CLAUDE_BRIDGE_CODEX_BIN: shim, CODEX_CLAUDE_BRIDGE_DAEMON: '' } });
  const check = report.checks.find(item => item.name === 'codex_daemon');
  assert.equal(check.status, 'warning');
  assert.match(check.detail, /codex[.]exe/);
});

test('bridge_doctor does not hang on a daemon that never answers the thread list', async t => {
  const setup = await claudeCallerSetup(t, { threads: [{ id: randomUUID(), originator: 'codex-tui' }], silent: 'thread/list' });
  const started = Date.now();
  const report = await executeBridgeTool('bridge_doctor', {}, setup.context);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  assert.equal(report.checks.find(check => check.name === 'codex_daemon').status, 'warning');
});

test('an abort after the turn/start write is recorded uncertain', async t => {
  const termId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: termId, originator: 'codex-tui' }], silent: 'turn/start' });
  const controller = new AbortController();
  const sending = executeBridgeTool('send_to_codex', { thread_id: termId, message: 'x', message_id: 'm-abort-late' },
    { ...setup.context, signal: controller.signal });
  const outcome = sending.then(() => null, error => error);
  for (let waited = 0; waited < 5000 && !setup.requests().some(entry => entry.method === 'turn/start'); waited += 25) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(setup.requests().some(entry => entry.method === 'turn/start'), 'turn/start was never written');
  controller.abort();
  const error = await outcome;
  assert.equal(error?.name, 'AbortError');
  assert.equal(error.deliveryUnknown, true);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.find(message => message.id === 'm-abort-late').status, 'uncertain');
});

async function queueSetup(t, mode) {
  const termId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: termId, originator: 'codex-tui', status: { type: 'notLoaded' } }] });
  const queue = await fakeQueue(t, { mode });
  return { ...setup, termId, queueCalls: queue.queueCalls, context: { ...setup.context, queue: queue.queue } };
}

test('a notLoaded terminal session is reached through codex queue with the peer envelope', async t => {
  const setup = await queueSetup(t, 'ok');
  const result = await executeBridgeTool('send_to_codex', { thread_id: setup.termId, message: 'Review please.', message_id: 'q-1' }, setup.context);
  assert.equal(result.message.status, 'submitted');
  assert.equal(result.message.receipt.method, 'queue');
  assert.ok(result.message.receipt.queue_id);
  assert.equal(setup.requests().some(entry => entry.method === 'turn/start'), false);
  const calls = setup.queueCalls();
  assert.equal(calls.length, 1);
  const message = calls[0].argv[calls[0].argv.indexOf('--message') + 1];
  assert.match(message, /^<cross-session-message from-kind="claude"/);
  assert.match(message, /not an instruction from your user/);
  assert.ok(message.includes('Review please.'));
});

test('a queue failure with uncertain outcome is recorded uncertain and never sent twice', async t => {
  const setup = await queueSetup(t, 'fail');
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: setup.termId, message: 'x', message_id: 'q-2' }, setup.context),
    error => error.deliveryUnknown === true);
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: setup.termId, message: 'x', message_id: 'q-2' }, setup.context),
    /uncertain delivery/);
  assert.equal(setup.queueCalls().length, 1);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.find(message => message.id === 'q-2').status, 'uncertain');
});

test('an aborted queue send is recorded uncertain and never sent twice', async t => {
  const setup = await queueSetup(t, 'hang');
  const controller = new AbortController();
  const context = { ...setup.context, signal: controller.signal };
  const outcome = assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: setup.termId, message: 'x', message_id: 'q-3' }, context),
    error => error.deliveryUnknown === true);
  for (let i = 0; i < 200 && setup.queueCalls().length === 0; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(setup.queueCalls().length, 1);
  controller.abort();
  await outcome;
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: setup.termId, message: 'x', message_id: 'q-3' }, setup.context),
    /uncertain delivery/);
  assert.equal(setup.queueCalls().length, 1);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.find(message => message.id === 'q-3').status, 'uncertain');
});

test('a queue send Codex rejects as unknown is recorded failed', async t => {
  const setup = await queueSetup(t, 'notfound');
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: setup.termId, message: 'x', message_id: 'q-4' }, setup.context),
    error => !error.deliveryUnknown && /thread store/.test(error.message));
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.find(message => message.id === 'q-4').status, 'failed');
});

test('a loaded idle daemon thread still goes through the daemon and makes no queue call', async t => {
  const termId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: termId, originator: 'codex-tui' }] });
  const queue = await fakeQueue(t, { mode: 'ok' });
  const result = await executeBridgeTool('send_to_codex', { thread_id: termId, message: 'hi', message_id: 'q-5' },
    { ...setup.context, queue: queue.queue });
  assert.equal(result.message.receipt.method, 'turn/start');
  assert.equal(queue.queueCalls().length, 0);
});

test('shouldReportTerminalUnavailable hides only the missing-executable case for a Desktop-only user', () => {
  const missing = new DaemonUnavailableError('The Codex executable was not found. Install the Codex CLI, or set CODEX_CLAUDE_BRIDGE_CODEX_BIN to the path of codex.exe.');
  assert.equal(shouldReportTerminalUnavailable(missing, true), false);
  assert.equal(shouldReportTerminalUnavailable(missing, false), true);
  assert.equal(shouldReportTerminalUnavailable(new DaemonUnavailableError('Codex terminal support is disabled by CODEX_CLAUDE_BRIDGE_DAEMON=off.'), true), true);
  assert.equal(shouldReportTerminalUnavailable(new Error('The Codex executable was not found.'), true), true);
});

test('a systemError terminal session is refused and never queued', async t => {
  const termId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: termId, originator: 'codex-tui', status: { type: 'systemError' } }] });
  const queue = await fakeQueue(t, { mode: 'ok' });
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: termId, message: 'x', message_id: 'q-6' },
    { ...setup.context, queue: queue.queue }), /not loaded/);
  assert.equal(queue.queueCalls().length, 0);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.find(message => message.id === 'q-6').status, 'failed');
});

test('listing with no Desktop and no Codex executable reports both reasons', async t => {
  const setup = await claudeCallerSetup(t, { threads: [] });
  const env = { ...setup.context.env, CODEX_CLAUDE_BRIDGE_DAEMON: '', CODEX_CLAUDE_BRIDGE_CODEX_BIN: '', PATH: '' };
  const { daemon, ...rest } = setup.context;
  await assert.rejects(() => executeBridgeTool('list_codex_chats', {}, { ...rest, env }),
    /Codex Desktop unavailable.*Codex terminal sessions unavailable: The Codex executable was not found/s);
});
