import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { executeBridgeTool } from '../lib/desktop-service.mjs';
import { prepareInstallation } from '../scripts/install.mjs';
import { nativeFixture } from './native-helpers.mjs';
import { sshFixture } from './ssh-helpers.mjs';

const mac = { skip: process.platform !== 'darwin' && 'Tests the macOS route and native caller identity.' };

async function actor(t) {
  const setup = await nativeFixture(t), sessionId = randomUUID();
  const registryDir = path.join(setup.root, 'sessions'); fs.mkdirSync(registryDir);
  const socketPath = `/tmp/bridge-caller-${randomUUID()}.sock`;
  const procStart = spawnSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(registryDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid,
    sessionId, entrypoint: 'claude-desktop', procStart, pidDomain: 'darwin', messagingSocketPath: socketPath,
    cwd: setup.cwd, name: 'Verified test caller', version: '2.1.295', status: 'idle' }));
  const hash = createHash('sha256').update(socketPath).digest('hex');
  fs.writeFileSync(path.join(registryDir, `${process.pid}.${hash}.key`), JSON.stringify({ peerToken: '1'.repeat(32), procStart, pidDomain: 'darwin' }));
  return { ...setup, sessionId, context: { registryDir, stateDir: setup.stateDir, parentPid: process.pid,
    env: { CLAUDE_CODE_MESSAGING_SOCKET: socketPath, CODEX_CLAUDE_BRIDGE_SSH_HOST: 'codex-test-host' } } };
}

test('macOS MCP send uses SSH without an app-tools registry and records verified provenance', mac, async t => {
  const setup = await actor(t), fixture = sshFixture();
  const args = { thread_id: 'target-thread', message: 'Reply exactly ADAPTER_TEST_ACK', message_id: 'mac-ssh-once' };
  const context = { ...setup.context, sshSpawn: fixture.spawnImpl };
  const result = await executeBridgeTool('send_to_codex', args, context);
  assert.equal(result.message.status, 'submitted');
  assert.deepEqual(result.message.route.from, { kind: 'claude', id: setup.sessionId });
  assert.deepEqual(result.message.receipt, { transport: 'ssh-app-server', turnId: 'accepted-turn', threadId: 'target-thread' });
  const started = fixture.requests.filter(r => r.method === 'turn/start');
  assert.equal(started.length, 1);
  assert.ok(started[0].params.input[0].text.includes(setup.sessionId));
  assert.ok(started[0].params.input[0].text.includes('mac-ssh-once'));
  assert.ok(started[0].params.input[0].text.endsWith('\n\nReply exactly ADAPTER_TEST_ACK'));
  const duplicate = await executeBridgeTool('send_to_codex', args, context);
  assert.equal(duplicate.retransmitted, false);
  assert.equal(fixture.requests.filter(r => r.method === 'turn/start').length, 1);
});

test('macOS MCP SSH failures retain uncertain status and block same-id replacement', mac, async t => {
  const setup = await actor(t), fixture = sshFixture({ dropTurn: true });
  const context = { ...setup.context, sshSpawn: fixture.spawnImpl };
  const args = { thread_id: 'target-thread', message: 'One message', message_id: 'mac-ssh-uncertain' };
  await assert.rejects(executeBridgeTool('send_to_codex', args, context), e => e.deliveryUnknown);
  const status = await executeBridgeTool('bridge_status', {}, context);
  assert.equal(status.messages[0].status, 'uncertain');
  await assert.rejects(executeBridgeTool('send_to_codex', args, context), /uncertain delivery/);
  assert.equal(fixture.requests.filter(r => r.method === 'turn/start').length, 1);
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
  assert.ok(turns[0].params.input[0].text.endsWith('\n\n' + message));
  assert.ok(Buffer.byteLength(turns[0].params.input[0].text) > 65536);
});

test('SSH preserves user control characters through JSON rather than a shell command', mac, async t => {
  const setup = await actor(t), fixture = sshFixture(), message = 'Code data: \0\t\n$(not-a-command)';
  const result = await executeBridgeTool('send_to_codex', { thread_id: 'target-thread', message,
    message_id: 'json-data-only' }, { ...setup.context, sshSpawn: fixture.spawnImpl });
  assert.equal(result.message.message, message);
  const turn = fixture.requests.find(r => r.method === 'turn/start');
  assert.ok(turn.params.input[0].text.endsWith('\n\n' + message));
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
  await assert.rejects(executeBridgeTool('list_codex_chats', {}, { ...setup.context,
    env: { ...setup.context.env, CODEX_CLAUDE_BRIDGE_SSH_HOST: '-oProxyCommand=bad' }, sshSpawn: fixture.spawnImpl }), /SSH host alias/);
  assert.equal(fixture.launches.length, 0);
});

test('macOS doctor does not advertise send readiness when only active chats are loaded', mac, async t => {
  const setup = await actor(t), fixture = sshFixture({ status: 'active' });
  const result = await executeBridgeTool('bridge_doctor', {}, { ...setup.context, sshSpawn: fixture.spawnImpl });
  assert.ok(result.checks.some(c => c.name === 'codex_context' && c.status === 'warning'));
  assert.equal(result.ready, false);
  assert.ok(!fixture.requests.some(r => r.method === 'turn/start'));
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
