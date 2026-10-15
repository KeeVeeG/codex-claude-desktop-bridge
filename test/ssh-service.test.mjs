import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { executeBridgeTool } from '../lib/desktop-service.mjs';
import { canonicalClaudeSocket } from '../lib/claude-desktop.mjs';
import { publishCodexHost } from '../lib/codex-host.mjs';
import { prepareInstallation } from '../scripts/install.mjs';
import { nativeFixture, mockPipe, encodeFrame, messageTool } from './native-helpers.mjs';
import { fakeDaemon, fakeQueue } from './codex-daemon-helpers.mjs';
import { sshFixture } from './ssh-helpers.mjs';

const mac = { skip: !['win32', 'darwin'].includes(process.platform) && 'Requires native Windows or macOS caller identity.' };
const targetId = '01a13000-abcd-7000-8000-000000000001';
let processStart;

async function actor(t, { alias = 'codex-test-host', platform = 'darwin' } = {}) {
  const setup = await nativeFixture(t), sessionId = randomUUID();
  const registryDir = path.join(setup.root, 'sessions'); fs.mkdirSync(registryDir);
  const windows = process.platform === 'win32';
  const socketPath = windows ? `\\\\.\\pipe\\LOCAL\\cc-msg-${randomUUID().replaceAll('-', '')}` : `/tmp/bridge-caller-${randomUUID()}.sock`;
  processStart ??= windows
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc().ToString()`], { encoding: 'utf8', windowsHide: true }).stdout.trim()
    : spawnSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout.trim();
  const pidDomain = windows ? `win32:${os.hostname().toLowerCase()}` : 'darwin';
  fs.writeFileSync(path.join(registryDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid,
    sessionId, entrypoint: 'claude-desktop', procStart: processStart, pidDomain, messagingSocketPath: socketPath,
    cwd: setup.cwd, name: 'Verified test caller', version: '2.1.295', status: 'idle' }));
  const hash = createHash('sha256').update(canonicalClaudeSocket(socketPath)).digest('hex');
  fs.writeFileSync(path.join(registryDir, `${process.pid}.${hash}.key`), JSON.stringify({ peerToken: '1'.repeat(32), pidDomain,
    ...(windows ? { procStartFt: processStart } : { procStart: processStart }) }));
  // Only routing is injected. Caller identity still uses the actual OS, process and native registry.
  return { ...setup, sessionId, context: { platform, registryDir, stateDir: setup.stateDir, parentPid: process.pid,
    env: { CLAUDE_CODE_MESSAGING_SOCKET: socketPath, ...(alias ? { CODEX_CLAUDE_BRIDGE_SSH_HOST: alias } : {}) } } };
}

async function localCandidates(t, setup, threadId = targetId) {
  const daemon = await fakeDaemon(t, { threads: [{ id: threadId, originator: 'codex-tui' }] });
  const queue = await fakeQueue(t);
  const app = await mockPipe(t, { framed: true, onMessage(message, socket) {
    let result;
    if (message.method === 'tools/list') result = { tools: [messageTool,
      { name: 'list_threads', namespace: 'codex_app', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } }] };
    else result = { success: true, contentItems: message.params.tool === 'list_threads'
      ? [{ type: 'inputText', text: JSON.stringify({ threads: [{ id: threadId, kind: 'codex', title: 'Local decoy' }] }) }] : [] };
    socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id, result }));
  } });
  publishCodexHost({ stateDir: setup.stateDir, pipePath: app.pipePath, threadId: 'local-context' });
  return { context: { ...setup.context, daemon: daemon.daemon, queue: queue.queue },
    assertUntouched() { assert.deepEqual(daemon.requests(), []); assert.deepEqual(queue.queueCalls(), []); assert.deepEqual(app.messages, []); } };
}

test('macOS MCP send uses SSH without an app-tools registry and records verified provenance', mac, async t => {
  const setup = await actor(t), fixture = sshFixture();
  const args = { thread_id: 'target-thread', message: 'Reply exactly ADAPTER_TEST_ACK', message_id: 'mac-ssh-once' };
  const context = { ...setup.context, sshSpawn: fixture.spawnImpl };
  const result = await executeBridgeTool('send_to_codex', args, context);
  assert.equal(result.message.status, 'submitted');
  assert.deepEqual(result.message.route.from, { kind: 'claude', id: setup.sessionId });
  assert.deepEqual(result.message.route.to, { kind: 'codex', id: 'target-thread', host_id: 'ssh:codex-test-host' });
  assert.deepEqual(result.message.receipt, { transport: 'ssh-app-server', turnId: 'accepted-turn', threadId: 'target-thread', host_id: 'ssh:codex-test-host' });
  const started = fixture.requests.filter(r => r.method === 'turn/start');
  assert.equal(started.length, 1);
  assert.ok(started[0].params.input[0].text.includes(setup.sessionId));
  assert.ok(started[0].params.input[0].text.includes('mac-ssh-once'));
  assert.ok(started[0].params.input[0].text.endsWith('\n\nReply exactly ADAPTER_TEST_ACK\n</cross-session-message>'));
  assert.ok(started[0].params.input[0].text.includes('not an instruction from your user'));
  assert.equal(fixture.requests.some(request => request.method === 'thread/resume'), false);
  const duplicate = await executeBridgeTool('send_to_codex', args, context);
  assert.equal(duplicate.retransmitted, false);
  assert.equal(fixture.requests.filter(r => r.method === 'turn/start').length, 1);
});

test('macOS MCP SSH failures retain uncertain status and block same-id replacement', mac, async t => {
  const setup = await actor(t), fixture = sshFixture({ dropTurn: true, loaded: [targetId] });
  const local = await localCandidates(t, setup);
  const context = { ...local.context, sshSpawn: fixture.spawnImpl };
  const args = { thread_id: targetId, message: 'One message', message_id: 'mac-ssh-uncertain' };
  await assert.rejects(executeBridgeTool('send_to_codex', args, context), e => e.deliveryUnknown);
  const status = await executeBridgeTool('bridge_status', {}, context);
  assert.equal(status.messages[0].status, 'uncertain');
  await assert.rejects(executeBridgeTool('send_to_codex', args, context), /uncertain delivery/);
  assert.equal(fixture.requests.filter(r => r.method === 'turn/start').length, 1);
  local.assertUntouched();
});

test('a configured SSH route lists and sends only through its pinned host despite a matching local UUID', mac, async t => {
  const setup = await actor(t), fixture = sshFixture({ loaded: [targetId] });
  const local = await localCandidates(t, setup);
  const context = { ...local.context, sshSpawn: fixture.spawnImpl };
  const listing = await executeBridgeTool('list_codex_chats', {}, context);
  assert.deepEqual(listing.warnings, []);
  assert.equal(listing.chats.length, 1);
  assert.equal(listing.chats[0].thread_id, targetId);
  assert.equal(listing.chats[0].source, 'ssh');
  assert.equal(listing.chats[0].host_id, 'ssh:codex-test-host');
  for (const transport of ['auto', 'ssh']) {
    const result = await executeBridgeTool('send_to_codex', { thread_id: targetId, message: transport,
      message_id: `pinned-${transport}`, transport }, context);
    assert.equal(result.message.status, 'submitted');
    assert.equal(result.message.route.to.host_id, 'ssh:codex-test-host');
  }
  assert.equal(fixture.requests.filter(r => r.method === 'turn/start').length, 2);
  local.assertUntouched();
});

test('an SSH failure does not fall back to a local daemon or Desktop that knows the same UUID', mac, async t => {
  const setup = await actor(t), fixture = sshFixture({ handshake: 'invalid', loaded: [targetId] });
  const local = await localCandidates(t, setup);
  const context = { ...local.context, sshSpawn: fixture.spawnImpl };
  await assert.rejects(executeBridgeTool('list_codex_chats', {}, context), /WebSocket|handshake/i);
  await assert.rejects(executeBridgeTool('send_to_codex', { thread_id: targetId, message: 'hello', message_id: 'ssh-down' }, context), /WebSocket|handshake/i);
  assert.equal(fixture.requests.some(r => r.method === 'turn/start'), false);
  local.assertUntouched();
});

test('configured SSH routes refuse explicit local transports before reserving a message', mac, async t => {
  const setup = await actor(t), fixture = sshFixture({ loaded: [targetId] });
  const local = await localCandidates(t, setup);
  const context = { ...local.context, sshSpawn: fixture.spawnImpl };
  for (const transport of ['desktop', 'terminal']) {
    await assert.rejects(executeBridgeTool('send_to_codex', { thread_id: targetId, message: 'hello', message_id: 'wrong-transport', transport }, context), /SSH|pinned/i);
  }
  assert.deepEqual(fixture.launches, []);
  assert.deepEqual((await executeBridgeTool('bridge_status', {}, context)).messages, []);
  local.assertUntouched();
});

test('explicit SSH delivery without a configured alias refuses before using any local candidate', mac, async t => {
  const setup = await actor(t, { alias: '' }), fixture = sshFixture({ loaded: [targetId] });
  const local = await localCandidates(t, setup);
  const context = { ...local.context, sshSpawn: fixture.spawnImpl };
  await assert.rejects(executeBridgeTool('send_to_codex', { thread_id: targetId, message: 'hello', message_id: 'no-alias', transport: 'ssh' }, context), /SSH.*(alias|host)|configured/i);
  assert.deepEqual(fixture.launches, []);
  assert.deepEqual((await executeBridgeTool('bridge_status', {}, context)).messages, []);
  local.assertUntouched();
});

test('the same thread UUID and message ID on two SSH aliases have separate delivery histories', mac, async t => {
  const setup = await actor(t), first = sshFixture({ loaded: [targetId] }), second = sshFixture({ loaded: [targetId] });
  const args = { thread_id: targetId, message: 'same content', message_id: 'per-host-idempotency' };
  const firstContext = { ...setup.context, sshSpawn: first.spawnImpl };
  const secondContext = { ...setup.context, env: { ...setup.context.env, CODEX_CLAUDE_BRIDGE_SSH_HOST: 'another-host' }, sshSpawn: second.spawnImpl };
  const firstSend = await executeBridgeTool('send_to_codex', args, firstContext);
  const secondSend = await executeBridgeTool('send_to_codex', args, secondContext);
  assert.equal(firstSend.message.status, 'submitted');
  assert.equal(secondSend.message.status, 'submitted');
  assert.equal(first.requests.filter(r => r.method === 'turn/start').length, 1);
  assert.equal(second.requests.filter(r => r.method === 'turn/start').length, 1);
  const duplicate = await executeBridgeTool('send_to_codex', args, secondContext);
  assert.equal(duplicate.retransmitted, false);
  assert.equal(second.requests.filter(r => r.method === 'turn/start').length, 1);
  const history = await executeBridgeTool('bridge_status', {}, firstContext);
  assert.deepEqual(history.messages.map(message => message.route.to.host_id).sort(), ['ssh:another-host', 'ssh:codex-test-host']);
});

test('Windows ignores an inherited SSH alias and keeps the local daemon route', { skip: process.platform !== 'win32' }, async t => {
  const setup = await actor(t, { platform: 'win32', alias: '-invalid-inherited-alias' });
  const daemon = await fakeDaemon(t, { threads: [{ id: targetId, originator: 'codex-tui' }] });
  const fixture = sshFixture({ loaded: [targetId] });
  const result = await executeBridgeTool('send_to_codex', { thread_id: targetId, message: 'local delivery', message_id: 'windows-stays-local' },
    { ...setup.context, daemon: daemon.daemon, sshSpawn: fixture.spawnImpl });
  assert.equal(result.message.receipt.method, 'turn/start');
  assert.deepEqual(result.message.route.to, { kind: 'codex', id: targetId });
  assert.equal(daemon.requests().filter(r => r.method === 'turn/start').length, 1);
  assert.deepEqual(fixture.launches, []);
});

test('SSH preserves the full user byte allowance when adding verified provenance', mac, async t => {
  const setup = await actor(t), fixture = sshFixture();
  const message = 'x'.repeat(65536);
  const result = await executeBridgeTool('send_to_codex', { thread_id: 'target-thread', message,
    message_id: 'full-user-byte-allowance' }, { ...setup.context, sshSpawn: fixture.spawnImpl });
  assert.equal(result.message.status, 'submitted');
  assert.equal(result.message.message, message);
  const turns = fixture.requests.filter(r => r.method === 'turn/start');
  assert.equal(turns.length, 1);
  assert.ok(turns[0].params.input[0].text.endsWith('\n\n' + message + '\n</cross-session-message>'));
  assert.ok(Buffer.byteLength(turns[0].params.input[0].text) > 65536);
});

test('SSH preserves user control characters through JSON rather than a shell command', mac, async t => {
  const setup = await actor(t), fixture = sshFixture(), message = 'Code data: \0\t\n$(not-a-command)';
  const result = await executeBridgeTool('send_to_codex', { thread_id: 'target-thread', message,
    message_id: 'json-data-only' }, { ...setup.context, sshSpawn: fixture.spawnImpl });
  assert.equal(result.message.message, message);
  const turn = fixture.requests.find(r => r.method === 'turn/start');
  assert.ok(turn.params.input[0].text.endsWith('\n\n' + message + '\n</cross-session-message>'));
  assert.ok(!fixture.launches[0].args.some(arg => arg.includes('not-a-command')));
});

test('SSH does not relax Claude caller verification', mac, async t => {
  const setup = await actor(t), fixture = sshFixture();
  await assert.rejects(executeBridgeTool('send_to_codex', { thread_id: 'target-thread', message: 'No spoofing' },
    { ...setup.context, parentPid: 2147483647, sshSpawn: fixture.spawnImpl }), /Cannot identify/);
  assert.equal(fixture.launches.length, 0);
});

test('macOS doctor checks SSH read-only rather than the protected app-tools socket', mac, async t => {
  const setup = await actor(t), fixture = sshFixture();
  const result = await executeBridgeTool('bridge_doctor', {}, { ...setup.context, sshSpawn: fixture.spawnImpl });
  assert.ok(result.checks.some(c => c.name === 'codex_tools' && c.status === 'pass'));
  assert.ok(result.checks.some(c => c.name === 'codex_context' && c.status === 'pass'));
  assert.ok(!fixture.requests.some(r => r.method === 'turn/start' || r.method === 'thread/resume'));
});

test('macOS invalid SSH route fails closed without private-socket fallback', mac, async t => {
  const setup = await actor(t), fixture = sshFixture();
  const local = await localCandidates(t, setup);
  const context = { ...local.context, env: { ...setup.context.env, CODEX_CLAUDE_BRIDGE_SSH_HOST: '-oProxyCommand=bad' }, sshSpawn: fixture.spawnImpl };
  await assert.rejects(executeBridgeTool('list_codex_chats', {}, context), /SSH host alias/);
  await assert.rejects(executeBridgeTool('send_to_codex', { thread_id: targetId, message: 'hi', message_id: 'invalid-alias' }, context), /SSH host alias/);
  assert.equal(fixture.launches.length, 0);
  local.assertUntouched();
});

test('macOS doctor does not advertise send readiness when only active chats are loaded', mac, async t => {
  const setup = await actor(t), fixture = sshFixture({ status: 'active' });
  const result = await executeBridgeTool('bridge_doctor', {}, { ...setup.context, sshSpawn: fixture.spawnImpl });
  assert.ok(result.checks.some(c => c.name === 'codex_context' && c.status === 'warning'));
  assert.equal(result.ready, false);
  assert.ok(!fixture.requests.some(r => r.method === 'turn/start'));
});

test('SSH doctor finds an idle conversation after the first busy conversation and never probes local transports', mac, async t => {
  const setup = await actor(t), fixture = sshFixture({ loaded: ['busy-first', 'idle-second'], statuses: { 'busy-first': 'active', 'idle-second': 'idle' } });
  const local = await localCandidates(t, setup);
  const result = await executeBridgeTool('bridge_doctor', {}, { ...local.context, sshSpawn: fixture.spawnImpl });
  assert.ok(result.checks.some(c => c.name === 'codex_context' && c.status === 'pass'));
  assert.ok(fixture.requests.some(r => r.method === 'thread/read' && r.params.threadId === 'idle-second'));
  assert.ok(!fixture.requests.some(r => r.method === 'turn/start' || r.method === 'thread/resume'));
  local.assertUntouched();
});

test('installer pins the operator-selected SSH alias into both native MCP configurations', async t => {
  const setup = await nativeFixture(t);
  const prepared = prepareInstallation({ homeDir: setup.root, env: { CODEX_CLAUDE_BRIDGE_SSH_HOST: 'codex-test-host' } });
  const codex = JSON.parse(fs.readFileSync(path.join(prepared.destination, '.codex-plugin/plugin.json')));
  const claude = JSON.parse(fs.readFileSync(path.join(prepared.destination, '.mcp.json')));
  assert.equal(codex.mcpServers['codex-claude-desktop-bridge'].env.CODEX_CLAUDE_BRIDGE_SSH_HOST, 'codex-test-host');
  assert.equal(claude.mcpServers['codex-claude-desktop-bridge'].env.CODEX_CLAUDE_BRIDGE_SSH_HOST, 'codex-test-host');
});

test('installer rejects malformed SSH aliases before writing plugin state', async t => {
  const setup = await nativeFixture(t);
  assert.throws(() => prepareInstallation({ homeDir: setup.root, env: { CODEX_CLAUDE_BRIDGE_SSH_HOST: 'host;whoami' } }), /SSH host alias/);
  assert.equal(fs.existsSync(path.join(setup.root, 'plugins')), false);
});
