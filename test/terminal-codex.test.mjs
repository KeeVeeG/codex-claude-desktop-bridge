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
import { publishCodexHost } from '../lib/codex-host.mjs';
import { codexPeerContent } from '../lib/codex-peer.mjs';
import { fakeDaemon, fakeQueue } from './codex-daemon-helpers.mjs';
import { encodeFrame, messageTool, mockPipe } from './native-helpers.mjs';

const terminalMeta = threadId => ({ 'x-codex-turn-metadata': JSON.stringify({ thread_id: threadId }), threadId });

async function terminalSetup(t, extra = {}) {
  const threadId = randomUUID();
  const setup = await fakeDaemon(t, { threads: [{ id: threadId, originator: 'codex-tui', name: 'My terminal' }], ...extra });
  const context = { env: { CODEX_CLAUDE_BRIDGE_STATE_DIR: setup.stateDir }, stateDir: setup.stateDir,
    daemon: setup.daemon, metadata: terminalMeta(threadId) };
  return { ...setup, threadId, context };
}

test('a terminal Codex caller without the Desktop pipe is identified from per-call metadata without probing the daemon', async t => {
  const setup = await terminalSetup(t);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.application, 'codex');
  assert.equal(status.sender_id, setup.threadId);
  assert.deepEqual(setup.requests(), []);
});

test('a Desktop-created conversation resumed in terminal and a new unknown conversation retain their per-call identities', async t => {
  const setup = await terminalSetup(t);
  const stranger = { ...setup.context, metadata: terminalMeta(randomUUID()) };
  assert.equal((await executeBridgeTool('bridge_status', {}, stranger)).sender_id, stranger.metadata.threadId);
  const desktop = await fakeDaemon(t, { threads: [{ id: 'desk', originator: 'Codex Desktop' }] });
  const resumed = await executeBridgeTool('bridge_status', {}, { ...setup.context, daemon: desktop.daemon, metadata: terminalMeta('desk') });
  assert.equal(resumed.application, 'codex');
  assert.equal(resumed.sender_id, 'desk');
  assert.deepEqual(setup.requests(), []);
  assert.deepEqual(desktop.requests(), []);
});

test('a terminal caller remains identified when the daemon is down and ignores the startup thread ID', async t => {
  const down = await fakeDaemon(t, { unreachable: true });
  const threadId = randomUUID();
  const status = await executeBridgeTool('bridge_status', {}, { env: { CODEX_CLAUDE_BRIDGE_STATE_DIR: down.stateDir, CODEX_THREAD_ID: 'stale-startup-id' },
    stateDir: down.stateDir, daemon: down.daemon, metadata: terminalMeta(threadId) });
  assert.equal(status.sender_id, threadId);
  assert.deepEqual(down.requests(), []);
});

test('UUID casing across per-call metadata fields still identifies one canonical Codex sender', async t => {
  const setup = await terminalSetup(t);
  const threadId = '01a13000-abcd-7000-8000-000000000001';
  const status = await executeBridgeTool('bridge_status', {}, { ...setup.context,
    metadata: { ...terminalMeta(threadId.toUpperCase()), threadId } });
  assert.equal(status.application, 'codex');
  assert.equal(status.sender_id, threadId);
  assert.deepEqual(setup.requests(), []);
});

test('malformed or conflicting per-call metadata is rejected before contacting any transport', async t => {
  const setup = await terminalSetup(t);
  for (const metadata of [
    { 'x-codex-turn-metadata': '{' },
    { 'x-codex-turn-metadata': null },
    { 'x-codex-turn-metadata': '[]' },
    { threadId: '' },
    { threadId: 123 },
    { ...terminalMeta('first'), threadId: 'second' },
  ]) {
    await assert.rejects(() => executeBridgeTool('bridge_status', {}, { ...setup.context, metadata }), /Invalid Codex|Conflicting Codex/);
  }
  await assert.rejects(() => executeBridgeTool('bridge_status', {}, { ...setup.context,
    env: { ...setup.context.env, CODEX_THREAD_ID: 'startup-id-only' }, metadata: { 'x-codex-turn-metadata': '{}' } }), /identity is unavailable/);
  assert.deepEqual(setup.requests(), []);
});

test('the conversation panel and manual send are refused for terminal callers before any mutation', async t => {
  const setup = await terminalSetup(t);
  for (const name of ['bridge_panel', 'bridge_ui_history', 'bridge_ui_send', 'bridge_ui_retry_notice']) {
    await assert.rejects(() => executeBridgeTool(name, { session_id: 'x', message: 'x', message_id: 'm' }, setup.context),
      /available only from a Codex Desktop chat/, name);
  }
});

const nativeIdentitySupported = ['win32', 'darwin'].includes(process.platform);
const claudeTest = (name, run) => test(name,
  { skip: !nativeIdentitySupported && 'Verified native Claude process identity supports Windows and macOS.' }, run);
const processDomain = process.platform === 'win32' ? `win32:${os.hostname().toLowerCase()}` : 'darwin';
const keyStartField = process.platform === 'win32' ? 'procStartFt' : 'procStart';
function readProcessStart() {
  if (!nativeIdentitySupported) return 'unsupported-fixture-process';
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc().ToString()`], { encoding: 'utf8', windowsHide: true })
    : spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  assert.equal(result.status, 0, `Cannot read fixture process creation time: ${result.error ?? result.stderr}`);
  assert.ok(result.stdout.trim());
  return result.stdout.trim();
}
const processStart = readProcessStart();

async function claudeCallerSetup(t, scenario) {
  const daemon = await fakeDaemon(t, scenario);
  const registryDir = path.join(daemon.root, 'claude-registry');
  fs.mkdirSync(registryDir);
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\LOCAL\\cc-msg-${randomUUID().replaceAll('-', '')}`
    : `/tmp/cc-msg-${randomUUID()}.sock`;
  const record = { pid: process.pid, sessionId: randomUUID(), entrypoint: 'cli', procStart: processStart,
    pidDomain: processDomain, messagingSocketPath: socketPath, cwd: daemon.cwd, name: 'Terminal Claude', version: '2.1.280', status: 'idle' };
  fs.writeFileSync(path.join(registryDir, `${record.pid}.json`), JSON.stringify(record));
  const hash = createHash('sha256').update(canonicalClaudeSocket(socketPath)).digest('hex');
  fs.writeFileSync(path.join(registryDir, `${record.pid}.${hash}.key`),
    JSON.stringify({ peerToken: '1'.repeat(32), [keyStartField]: processStart, pidDomain: record.pidDomain }));
  const context = { env: { CODEX_CLAUDE_BRIDGE_STATE_DIR: daemon.stateDir, CODEX_CLAUDE_BRIDGE_REGISTRY_DIR: registryDir },
    stateDir: daemon.stateDir, registryDir, parentPid: process.pid, daemon: daemon.daemon };
  return { ...daemon, registryDir, record, context };
}

claudeTest('Claude sends to a terminal Codex session with the peer envelope, with no Desktop registered at all', async t => {
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

claudeTest('an exact ID the daemon does not claim still goes to the Desktop path as before', async t => {
  const setup = await claudeCallerSetup(t, { threads: [{ id: 'other', originator: 'codex-tui' }] });
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: 'older-desktop-task', message: 'hi', message_id: 'm-2' }, setup.context),
    /Codex Desktop has not registered its bridge endpoint/);
  assert.equal(setup.requests().some(entry => entry.method === 'turn/start'), false);
  assert.ok(setup.requests().some(entry => entry.method === 'thread/read' && entry.params.threadId === 'older-desktop-task'),
    'the daemon was consulted for the ID before the Desktop path was taken');
});

claudeTest('with the daemon down an ID takes the Desktop path and terminal support never starts anything', async t => {
  const setup = await claudeCallerSetup(t, { unreachable: true });
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: 'any', message: 'hi', message_id: 'm-3' }, setup.context),
    /Codex Desktop has not registered its bridge endpoint/);
});

claudeTest('a dropped connection after turn/start is recorded uncertain and the same message_id is never sent twice', async t => {
  const termId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: termId, originator: 'codex-tui' }], dropAfter: 'turn/start' });
  const desktop = await desktopApp(t, setup, [{ id: termId, title: 'Also listed in Desktop' }]);
  const queue = await fakeQueue(t);
  setup.context.queue = queue.queue;
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: termId, message: 'x', message_id: 'm-4' }, setup.context),
    error => error.deliveryUnknown === true);
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: termId, message: 'x', message_id: 'm-4' }, setup.context),
    /uncertain delivery/);
  assert.equal(setup.requests().filter(entry => entry.method === 'turn/start').length, 1);
  assert.deepEqual(desktop.sent(), []);
  assert.deepEqual(queue.queueCalls(), []);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.find(message => message.id === 'm-4').status, 'uncertain');
});

claudeTest('a busy terminal session is refused before any write and recorded failed', async t => {
  const termId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: termId, originator: 'codex-tui', status: { type: 'active' } }] });
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: termId, message: 'x', message_id: 'm-5' }, setup.context), /busy/);
  assert.equal(setup.requests().some(entry => entry.method === 'turn/start'), false);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.find(message => message.id === 'm-5').status, 'failed');
});

claudeTest('repeating a submitted message_id sends nothing new, and the same ID to another recipient is a separate message', async t => {
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

claudeTest('a pre-aborted send contacts no daemon and records no message', async t => {
  const termId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: termId, originator: 'codex-tui' }] });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: termId, message: 'x', message_id: 'm-abort' },
    { ...setup.context, signal: controller.signal }), error => error.name === 'AbortError');
  assert.deepEqual(setup.requests(), []);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.some(message => message.id === 'm-abort'), false);
});

/** A registered Codex Desktop app that lists `threads` and accepts sends. */
async function desktopApp(t, setup, threads, { dropSend = false } = {}) {
  const listTool = { name: 'list_threads', namespace: 'codex_app', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } };
  const sent = [];
  const answer = (socket, id, result) => socket.write(encodeFrame({ jsonrpc: '2.0', id, result }));
  const app = await mockPipe(t, { framed: true, onMessage(message, socket) {
    if (message.method === 'tools/list') return answer(socket, message.id, { tools: [messageTool, listTool] });
    if (message.params.tool === 'list_threads') {
      const listing = { threads: threads.map(thread => ({ kind: 'codex', ...thread })) };
      return answer(socket, message.id, { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(listing) }] });
    }
    sent.push(message.params);
    if (dropSend) return socket.destroy();
    answer(socket, message.id, { success: true, contentItems: [] });
  } });
  publishCodexHost({ stateDir: setup.stateDir, pipePath: app.pipePath, threadId: 'desktop-context' });
  return { sent: () => sent };
}

claudeTest('a loaded Desktop-created conversation is sent through its daemon transport regardless of originator', async t => {
  const setup = await claudeCallerSetup(t, { threads: [{ id: 'desk-a', originator: 'Codex Desktop' }, { id: 'term-a', originator: 'codex-tui' }] });
  const desktop = await desktopApp(t, setup, [{ id: 'desk-a', title: 'Desktop A' }]);
  const result = await executeBridgeTool('send_to_codex', { thread_id: 'desk-a', message: 'hi', message_id: 'm-desk' }, setup.context);
  assert.equal(result.message.status, 'submitted');
  assert.deepEqual(desktop.sent(), []);
  assert.ok(setup.requests().some(entry => entry.method === 'thread/read' && entry.params.threadId === 'desk-a'));
  assert.equal(setup.requests().filter(entry => entry.method === 'turn/start').length, 1);
});

claudeTest('explicit Desktop delivery skips daemon routing and accepts a long message to a CLI-created conversation', async t => {
  const setup = await claudeCallerSetup(t, { threads: [{ id: 'cli-created', originator: 'codex-tui', status: { type: 'notLoaded' } }] });
  const desktop = await desktopApp(t, setup, [{ id: 'cli-created', title: 'Now open in Desktop' }]);
  const queue = await fakeQueue(t);
  const result = await executeBridgeTool('send_to_codex', { thread_id: 'cli-created', transport: 'desktop', message: 'x'.repeat(17000), message_id: 'desktop-long' },
    { ...setup.context, queue: queue.queue });
  assert.equal(result.message.status, 'submitted');
  assert.deepEqual(desktop.sent().map(params => params.arguments.threadId), ['cli-created']);
  assert.ok(desktop.sent()[0].arguments.prompt.includes('x'.repeat(17000)));
  assert.deepEqual(setup.requests(), []);
  assert.deepEqual(queue.queueCalls(), []);
});

claudeTest('an uncertain Desktop send is never resent through terminal transport with the same message ID', async t => {
  const threadId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: threadId, originator: 'codex-tui' }] });
  const desktop = await desktopApp(t, setup, [{ id: threadId, title: 'Shared target' }], { dropSend: true });
  const queue = await fakeQueue(t);
  const context = { ...setup.context, queue: queue.queue };
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: threadId, transport: 'desktop', message: 'hello', message_id: 'desktop-uncertain' }, context),
    error => error.deliveryUnknown === true);
  assert.deepEqual(setup.requests(), [], 'Desktop delivery must not probe or send through the daemon');
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: threadId, transport: 'terminal', message: 'hello', message_id: 'desktop-uncertain' }, context),
    /uncertain delivery/);
  assert.equal(desktop.sent().length, 1);
  assert.deepEqual(queue.queueCalls(), []);
  assert.equal(setup.requests().some(entry => entry.method === 'turn/start' || entry.method === 'turn/steer'), false);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.find(message => message.id === 'desktop-uncertain').status, 'uncertain');
});

claudeTest('a terminal Claude sender is named as a terminal session in a Desktop Codex notice', async t => {
  const setup = await claudeCallerSetup(t, { threads: [] });
  const desktop = await desktopApp(t, setup, [{ id: 'desk-a', title: 'Desktop A' }]);
  await executeBridgeTool('send_to_codex', { thread_id: 'desk-a', message: 'hi', message_id: 'm-label' }, setup.context);
  assert.match(desktop.sent()[0].arguments.prompt, /^\[From Claude Code CLI session "[0-9a-f-]+"; bridge message "m-label"\]/);
});

claudeTest('listing preserves Desktop entries on overlap and includes daemon-only conversations of either origin', async t => {
  const setup = await claudeCallerSetup(t, { threads: [{ id: 'shared', originator: 'codex-tui', name: 'Shared' },
    { id: 'desk-a', originator: 'Codex Desktop' }, { id: 'term-b', originator: 'codex-tui', name: 'Terminal B' },
    { id: 'resumed-desktop', originator: 'Codex Desktop', name: 'Resumed from Desktop' }] });
  await desktopApp(t, setup, [{ id: 'desk-a', title: 'Desktop A' }, { id: 'shared', title: 'Shared in Desktop' }]);
  const result = await executeBridgeTool('list_codex_chats', {}, setup.context);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.chats.map(chat => [chat.thread_id, chat.source]), [['desk-a', 'desktop'], ['shared', 'desktop'], ['term-b', 'terminal'], ['resumed-desktop', 'terminal']]);
  assert.equal(result.chats.find(chat => chat.thread_id === 'shared').title, 'Shared in Desktop');
});

claudeTest('a running daemon that does not answer the routing check refuses the send instead of guessing Desktop', async t => {
  const setup = await claudeCallerSetup(t, { threads: [{ id: 'term-a', originator: 'codex-tui' }], silent: 'thread/read' });
  const desktop = await desktopApp(t, setup, [{ id: 'desk-a', title: 'Desktop A' }]);
  const context = { ...setup.context, daemon: { ...setup.daemon, timeoutMs: 1500 } };
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: 'term-a', message: 'hi', message_id: 'm-wedged' }, context),
    /did not answer|timed out/i);
  assert.deepEqual(desktop.sent(), []);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.some(message => message.id === 'm-wedged'), false);
});

claudeTest('a terminal Codex caller can send to a Claude session and the notice names its source', async t => {
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

claudeTest('listing returns terminal chats with a warning when Desktop is not registered', async t => {
  const setup = await claudeCallerSetup(t, { threads: [{ id: 'term-a', originator: 'codex-tui', name: 'Terminal A' }, { id: 'desk-a', originator: 'Codex Desktop' }] });
  const result = await executeBridgeTool('list_codex_chats', {}, setup.context);
  assert.deepEqual(result.chats.map(chat => [chat.thread_id, chat.source]), [['term-a', 'terminal'], ['desk-a', 'terminal']]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Codex Desktop unavailable/);
});

claudeTest('listing fails with both reasons when neither source is available', async t => {
  const setup = await claudeCallerSetup(t, { unreachable: true });
  await assert.rejects(() => executeBridgeTool('list_codex_chats', {}, setup.context),
    /Codex Desktop unavailable.*Codex terminal sessions unavailable/s);
});

claudeTest('bridge_doctor reports daemon reachability as optional and never fails a Desktop-only setup', async t => {
  const up = await claudeCallerSetup(t, { threads: [{ id: randomUUID(), originator: 'codex-tui' }] });
  const upReport = await executeBridgeTool('bridge_doctor', {}, up.context);
  const daemonCheck = upReport.checks.find(check => check.name === 'codex_daemon');
  assert.equal(daemonCheck.status, 'pass');
  assert.match(daemonCheck.detail, /lists stored Codex sessions/);
  assert.notEqual(upReport.checks.find(check => check.name === 'codex_tools').status, 'fail');
  const down = await claudeCallerSetup(t, { unreachable: true });
  const downReport = await executeBridgeTool('bridge_doctor', {}, down.context);
  const check = downReport.checks.find(item => item.name === 'codex_daemon');
  assert.equal(check.status, 'warning');
  assert.match(check.detail, /not reachable|not found|disabled/);
  assert.equal(downReport.ready, false);
});

claudeTest('bridge_doctor says so when the daemon is reachable but no terminal session is registered, and never reports it ready on that alone', async t => {
  const empty = await claudeCallerSetup(t, { threads: [] });
  const report = await executeBridgeTool('bridge_doctor', {}, empty.context);
  assert.match(report.checks.find(check => check.name === 'codex_daemon').detail, /no stored Codex session is available/);
  assert.equal(report.ready, false);
});

claudeTest('bridge_doctor warns when the Codex CLI and daemon versions differ and stays quiet when they match', async t => {
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

claudeTest('bridge_doctor is ready for a terminal-only setup: daemon reachable, a session registered, live inbox', async t => {
  const setup = await claudeCallerSetup(t, { threads: [{ id: randomUUID(), originator: 'codex-tui' }] });
  await listenInbox(t, setup);
  const report = await executeBridgeTool('bridge_doctor', {}, setup.context);
  assert.equal(report.checks.find(check => check.name === 'claude_inbox').status, 'pass');
  assert.equal(report.checks.find(check => check.name === 'codex_daemon').status, 'pass');
  assert.equal(report.ready, true, JSON.stringify(report.checks.filter(check => check.status === 'fail')));
});

claudeTest('bridge_doctor is not ready with a live inbox when the daemon has no terminal session or is unreachable', async t => {
  const empty = await claudeCallerSetup(t, { threads: [] });
  await listenInbox(t, empty);
  const emptyReport = await executeBridgeTool('bridge_doctor', {}, empty.context);
  assert.equal(emptyReport.checks.find(check => check.name === 'claude_inbox').status, 'pass');
  assert.match(emptyReport.checks.find(check => check.name === 'codex_daemon').detail, /no stored Codex session is available/);
  assert.equal(emptyReport.ready, false);
  const down = await claudeCallerSetup(t, { unreachable: true });
  await listenInbox(t, down);
  const downReport = await executeBridgeTool('bridge_doctor', {}, down.context);
  assert.equal(downReport.checks.find(check => check.name === 'claude_inbox').status, 'pass');
  assert.equal(downReport.checks.find(check => check.name === 'codex_daemon').status, 'warning');
  assert.equal(downReport.ready, false);
});

claudeTest('a Claude caller is never verified as a terminal Codex caller, even with terminal Codex metadata', async t => {
  const threadId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: threadId, originator: 'codex-tui' }] });
  const status = await executeBridgeTool('bridge_status', {}, { ...setup.context,
    env: { ...setup.context.env, CLAUDE_CODE_MESSAGING_SOCKET: setup.record.messagingSocketPath }, metadata: terminalMeta(threadId) });
  assert.equal(status.application, 'claude');
  assert.deepEqual(setup.requests(), []);
});

claudeTest('bridge_doctor reports a codex.cmd shim as a warning instead of throwing', async t => {
  const setup = await claudeCallerSetup(t, { threads: [] });
  const shim = path.join(setup.root, 'codex.cmd');
  fs.writeFileSync(shim, '');
  const report = await executeBridgeTool('bridge_doctor', {}, { ...setup.context, daemon: undefined,
    env: { ...setup.context.env, CODEX_CLAUDE_BRIDGE_CODEX_BIN: shim, CODEX_CLAUDE_BRIDGE_DAEMON: '' } });
  const check = report.checks.find(item => item.name === 'codex_daemon');
  assert.equal(check.status, 'warning');
  assert.match(check.detail, /codex[.]exe/);
});

claudeTest('bridge_doctor does not hang on a daemon that never answers the thread list', async t => {
  const setup = await claudeCallerSetup(t, { threads: [{ id: randomUUID(), originator: 'codex-tui' }], silent: 'thread/list' });
  const started = Date.now();
  const report = await executeBridgeTool('bridge_doctor', {}, setup.context);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  assert.equal(report.checks.find(check => check.name === 'codex_daemon').status, 'warning');
});

claudeTest('an abort after the turn/start write is recorded uncertain', async t => {
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

claudeTest('explicit terminal delivery reaches a notLoaded session through codex queue with the peer envelope', async t => {
  const setup = await queueSetup(t, 'ok');
  const result = await executeBridgeTool('send_to_codex', { thread_id: setup.termId, transport: 'terminal', message: 'Review please.', message_id: 'q-1' }, setup.context);
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

claudeTest('a queue failure with uncertain outcome is recorded uncertain and never sent twice', async t => {
  const setup = await queueSetup(t, 'fail');
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: setup.termId, transport: 'terminal', message: 'x', message_id: 'q-2' }, setup.context),
    error => error.deliveryUnknown === true);
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: setup.termId, transport: 'terminal', message: 'x', message_id: 'q-2' }, setup.context),
    /uncertain delivery/);
  assert.equal(setup.queueCalls().length, 1);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.find(message => message.id === 'q-2').status, 'uncertain');
});

claudeTest('an aborted queue send is recorded uncertain and never sent twice', async t => {
  const setup = await queueSetup(t, 'hang');
  const controller = new AbortController();
  const context = { ...setup.context, signal: controller.signal };
  const outcome = assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: setup.termId, transport: 'terminal', message: 'x', message_id: 'q-3' }, context),
    error => error.deliveryUnknown === true);
  for (let i = 0; i < 200 && setup.queueCalls().length === 0; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(setup.queueCalls().length, 1);
  controller.abort();
  await outcome;
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: setup.termId, transport: 'terminal', message: 'x', message_id: 'q-3' }, setup.context),
    /uncertain delivery/);
  assert.equal(setup.queueCalls().length, 1);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.find(message => message.id === 'q-3').status, 'uncertain');
});

claudeTest('a queue send Codex rejects as unknown is recorded failed', async t => {
  const setup = await queueSetup(t, 'notfound');
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: setup.termId, transport: 'terminal', message: 'x', message_id: 'q-4' }, setup.context),
    error => !error.deliveryUnknown && /thread store/.test(error.message));
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.find(message => message.id === 'q-4').status, 'failed');
});

claudeTest('a message the queue route cannot carry is refused before its message_id is reserved', async t => {
  const setup = await queueSetup(t, 'ok');
  const send = (message, message_id) => executeBridgeTool('send_to_codex', { thread_id: setup.termId, transport: 'terminal', message, message_id }, setup.context);
  const overhead = codexPeerContent({ fromKind: 'claude', fromId: setup.record.sessionId, bridgeMessageId: 'q-edge', body: '' }).length;
  await assert.rejects(() => send('x'.repeat(16000 - overhead + 1), 'q-edge'), error => /too long/.test(error.message) && !error.deliveryUnknown);
  await assert.rejects(() => send('a\0b', 'q-nul'), error => /NUL character/.test(error.message) && !error.deliveryUnknown);
  assert.equal(setup.queueCalls().length, 0);
  assert.deepEqual((await executeBridgeTool('bridge_status', {}, setup.context)).messages, [], 'nothing was reserved, not even as failed');
  // The refused ID is still free, even for different text, and the wrapped text that exactly fits is accepted.
  const fits = await send('x'.repeat(16000 - overhead), 'q-edge');
  assert.equal(fits.message.status, 'submitted');
  assert.equal(setup.queueCalls()[0].argv[setup.queueCalls()[0].argv.indexOf('--message') + 1].length, 16000);
  // Without a message_id the refusal is just as clean.
  await assert.rejects(() => send('x'.repeat(20000)), /too long/);
  assert.deepEqual((await executeBridgeTool('bridge_status', {}, setup.context)).messages.map(message => message.id), ['q-edge']);
});

claudeTest('auto routing refuses an unloaded conversation before reserving a message or writing to either transport', async t => {
  const setup = await queueSetup(t, 'ok');
  const desktop = await desktopApp(t, setup, [{ id: setup.termId, title: 'Listed in Desktop too' }]);
  for (const transport of [undefined, 'auto']) {
    await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: setup.termId, transport, message: 'hi', message_id: 'ambiguous' }, setup.context),
      /desktop.*terminal|terminal.*desktop/i);
  }
  assert.deepEqual(desktop.sent(), []);
  assert.deepEqual(setup.queueCalls(), []);
  assert.equal(setup.requests().some(entry => entry.method === 'turn/start' || entry.method === 'turn/steer'), false);
  assert.deepEqual((await executeBridgeTool('bridge_status', {}, setup.context)).messages, []);
  const sent = await executeBridgeTool('send_to_codex', { thread_id: setup.termId, transport: 'terminal', message: 'changed text', message_id: 'ambiguous' }, setup.context);
  assert.equal(sent.message.status, 'submitted', 'the refused message ID must remain reusable');
});

claudeTest('explicit terminal delivery queues a Desktop-created conversation by exact ID', async t => {
  const threadId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: threadId, originator: 'Codex Desktop', status: { type: 'notLoaded' } }] });
  const desktop = await desktopApp(t, setup, [{ id: threadId, title: 'Historical Desktop entry' }]);
  const queue = await fakeQueue(t);
  const result = await executeBridgeTool('send_to_codex', { thread_id: threadId, transport: 'terminal', message: 'hello', message_id: 'resumed-queue' },
    { ...setup.context, queue: queue.queue });
  assert.equal(result.message.receipt.method, 'queue');
  assert.equal(queue.queueCalls().length, 1);
  assert.ok(queue.queueCalls()[0].argv.includes(threadId));
  assert.deepEqual(desktop.sent(), []);
});

claudeTest('auto routing never switches to queue when a loaded session unloads between routing and sending', async t => {
  const threadId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: threadId, originator: 'Codex Desktop',
    statusByRead: [{ type: 'idle' }, { type: 'notLoaded' }] }] });
  const desktop = await desktopApp(t, setup, [{ id: threadId, title: 'Desktop candidate' }]);
  const queue = await fakeQueue(t);
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: threadId, message: 'hello', message_id: 'unloaded-race' },
    { ...setup.context, queue: queue.queue }), /left the daemon/);
  assert.equal(setup.requests().filter(entry => entry.method === 'thread/read').length, 2);
  assert.equal(setup.requests().some(entry => entry.method === 'turn/start' || entry.method === 'turn/steer'), false);
  assert.deepEqual(queue.queueCalls(), []);
  assert.deepEqual(desktop.sent(), []);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.find(message => message.id === 'unloaded-race').status, 'failed');
});

claudeTest('explicit terminal delivery uses queue when the daemon is unavailable without falling back to Desktop', async t => {
  const threadId = randomUUID();
  const setup = await claudeCallerSetup(t, { unreachable: true });
  const desktop = await desktopApp(t, setup, [{ id: threadId, title: 'Desktop candidate' }]);
  const queue = await fakeQueue(t);
  const result = await executeBridgeTool('send_to_codex', { thread_id: threadId, transport: 'terminal', message: 'hello', message_id: 'offline-queue' },
    { ...setup.context, queue: queue.queue });
  assert.equal(result.message.receipt.method, 'queue');
  assert.equal(queue.queueCalls().length, 1);
  assert.ok(queue.queueCalls()[0].argv.includes(threadId));
  assert.deepEqual(desktop.sent(), []);
});

claudeTest('UUID casing cannot bypass message deduplication when explicit terminal delivery uses queue', async t => {
  const threadId = '01a13000-abcd-7000-8000-000000000001';
  const setup = await claudeCallerSetup(t, { unreachable: true });
  const queue = await fakeQueue(t);
  const context = { ...setup.context, queue: queue.queue };
  const send = selectedId => executeBridgeTool('send_to_codex', {
    thread_id: selectedId, transport: 'terminal', message: 'hello', message_id: 'queue-case-dedup',
  }, context);
  const first = await send(threadId.toUpperCase());
  assert.equal(first.message.status, 'submitted');
  const second = await send(threadId);
  assert.equal(second.retransmitted, false);
  assert.equal(queue.queueCalls().length, 1);
  assert.ok(queue.queueCalls()[0].argv.includes(threadId));
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.length, 1);
  assert.equal(status.messages[0].route.to.id, threadId);
});

claudeTest('explicit terminal delivery with an unavailable daemon refuses a title instead of an exact UUID before reserving or queueing', async t => {
  const setup = await claudeCallerSetup(t, { unreachable: true });
  const desktop = await desktopApp(t, setup, [{ id: 'same-name', title: 'Shared conversation name' }]);
  const queue = await fakeQueue(t);
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: 'Shared conversation name', transport: 'terminal', message: 'hello', message_id: 'queue-title' },
    { ...setup.context, queue: queue.queue }), /UUID|exact.*ID/i);
  assert.deepEqual(queue.queueCalls(), []);
  assert.deepEqual(desktop.sent(), []);
  assert.deepEqual((await executeBridgeTool('bridge_status', {}, setup.context)).messages, []);
});

claudeTest('an invalid explicit transport is rejected without reserving a message or making a routing request', async t => {
  const setup = await claudeCallerSetup(t, { threads: [] });
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: 'other', transport: 'anything', message: 'hello', message_id: 'bad-transport' }, setup.context),
    /transport/i);
  assert.deepEqual(setup.requests(), []);
  assert.deepEqual((await executeBridgeTool('bridge_status', {}, setup.context)).messages, []);
});

claudeTest('an over-long message to a session on the daemon route is delivered, since only the queue route has the limit', async t => {
  const termId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: termId, originator: 'codex-tui' }] });
  const queue = await fakeQueue(t, { mode: 'ok' });
  const result = await executeBridgeTool('send_to_codex', { thread_id: termId, message: 'x'.repeat(40000), message_id: 'q-long' },
    { ...setup.context, queue: queue.queue });
  assert.equal(result.message.status, 'submitted');
  assert.equal(result.message.receipt.method, 'turn/start');
  assert.ok(setup.requests().find(entry => entry.method === 'turn/start').params.input[0].text.length > 40000);
  assert.equal(queue.queueCalls().length, 0);
});

claudeTest('a loaded idle daemon thread still goes through the daemon and makes no queue call', async t => {
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

claudeTest('a systemError terminal session is refused and never queued', async t => {
  const termId = randomUUID();
  const setup = await claudeCallerSetup(t, { threads: [{ id: termId, originator: 'codex-tui', status: { type: 'systemError' } }] });
  const queue = await fakeQueue(t, { mode: 'ok' });
  await assert.rejects(() => executeBridgeTool('send_to_codex', { thread_id: termId, message: 'x', message_id: 'q-6' },
    { ...setup.context, queue: queue.queue }), /not loaded/);
  assert.equal(queue.queueCalls().length, 0);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.messages.find(message => message.id === 'q-6').status, 'failed');
});

claudeTest('listing with no Desktop and no Codex executable reports both reasons', async t => {
  const setup = await claudeCallerSetup(t, { threads: [] });
  const env = { ...setup.context.env, CODEX_CLAUDE_BRIDGE_DAEMON: '', CODEX_CLAUDE_BRIDGE_CODEX_BIN: '', PATH: '' };
  const { daemon, ...rest } = setup.context;
  await assert.rejects(() => executeBridgeTool('list_codex_chats', {}, { ...rest, env }),
    /Codex Desktop unavailable.*Codex terminal sessions unavailable: The Codex executable was not found/s);
});
