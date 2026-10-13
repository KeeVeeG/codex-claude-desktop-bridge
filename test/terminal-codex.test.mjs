import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { canonicalClaudeSocket } from '../lib/claude-desktop.mjs';
import { executeBridgeTool } from '../lib/desktop-service.mjs';
import { fakeDaemon } from './codex-daemon-helpers.mjs';

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
