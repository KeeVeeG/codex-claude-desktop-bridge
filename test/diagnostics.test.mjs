import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { executeBridgeTool } from '../lib/desktop-service.mjs';
import { canonicalClaudeSocket, sendToClaude, probeClaudeInbox } from '../lib/claude-desktop.mjs';
import { listCodexTools, sendToCodex } from '../lib/codex-desktop.mjs';
import { getMessages, getSession } from '../lib/store.mjs';
import { publishCodexHost } from '../lib/codex-host.mjs';
import { encodeFrame, mockPipe, nativeFixture, messageTool } from './native-helpers.mjs';

const windowsOnly = { skip: process.platform !== 'win32' && 'Desktop registry fixtures require Windows named pipes.' };
const processStart = process.platform === 'win32'
  ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc().ToString()`],
  { encoding: 'utf8', windowsHide: true }).stdout.trim() : String(Date.now());
const listTool = { name: 'list_threads', namespace: 'codex_app',
  inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } };

function answer(socket, id, result) {
  socket.write(encodeFrame({ jsonrpc: '2.0', id, result }));
}

async function claudeFixture(t, onMessage) {
  const fixture = await nativeFixture(t);
  const inbox = await mockPipe(t, { onMessage });
  const registryDir = path.join(fixture.root, 'claude-registry');
  fs.mkdirSync(registryDir);
  const record = { pid: process.pid, sessionId: randomUUID(), entrypoint: 'claude-desktop',
    procStart: processStart, pidDomain: `win32:${os.hostname().toLowerCase()}`,
    messagingSocketPath: inbox.pipePath, cwd: fixture.cwd, name: 'Fixture Code session' };
  const token = '1234567890abcdef'.repeat(2);
  fs.writeFileSync(path.join(registryDir, `${record.pid}.json`), JSON.stringify(record));
  const keyHash = createHash('sha256').update(canonicalClaudeSocket(inbox.pipePath)).digest('hex');
  fs.writeFileSync(path.join(registryDir, `${record.pid}.${keyHash}.key`), JSON.stringify({
    peerToken: token, procStartFt: processStart, pidDomain: record.pidDomain,
  }));
  return { ...fixture, inbox, registryDir, record, token };
}

test('doctor reports missing configuration without registering a host or creating state', async t => {
  const fixture = await nativeFixture(t);
  const result = await executeBridgeTool('bridge_doctor', {}, { env: {}, stateDir: fixture.stateDir,
    registryDir: path.join(fixture.root, 'absent-registry'), parentPid: 2_147_483_647 });
  assert.equal(result.application, 'unknown');
  assert.equal(result.ready, false);
  assert.equal(result.checks.find(check => check.name === 'caller').status, 'fail');
  assert.equal(result.checks.find(check => check.name === 'state_directory').status, 'warning');
  assert.equal(fs.existsSync(fixture.stateDir), false);
  assert.doesNotMatch(JSON.stringify(result), /state_directory"\s*:\s*"|pipePath|socketPath|peerToken|procStart|pidDomain/);
  assert.ok(result.checks.every(check => Object.keys(check).sort().join(',') === 'detail,name,status'));
});

test('doctor validates compatible local endpoints without sending model messages or persisting state', windowsOnly, async t => {
  const fixture = await claudeFixture(t);
  const codex = await mockPipe(t, { framed: true, onMessage(message, socket) {
    if (message.method === 'tools/list') answer(socket, message.id, { tools: [messageTool, listTool] });
    else {
      assert.equal(message.params.tool, 'list_threads');
      answer(socket, message.id, { success: true, contentItems: [{ type: 'inputText',
        text: JSON.stringify({ threads: [] }) }] });
    }
  } });
  const context = { env: { CODEX_APP_TOOLS_PIPE_PATH: codex.pipePath },
    metadata: { 'openai/threadId': 'doctor-context' }, stateDir: fixture.stateDir, registryDir: fixture.registryDir };
  const result = await executeBridgeTool('bridge_doctor', {}, context);
  assert.equal(result.application, 'codex');
  assert.equal(result.ready, true);
  assert.equal(result.checks.find(check => check.name === 'claude_inbox').status, 'pass');
  assert.equal(fs.existsSync(fixture.stateDir), false, 'doctor must not publish its caller or create a ledger');
  assert.equal(fixture.inbox.messages.length, 0, 'connectivity probe sends no auth frame or user prompt');
  assert.equal(codex.messages.filter(entry => entry.message.method === 'tools/call').length, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(fixture.token));
  assert.ok(!JSON.stringify(result).includes(fixture.root));
});

test('doctor distinguishes malformed registries and unsupported native schemas safely', windowsOnly, async t => {
  const fixture = await nativeFixture(t);
  fs.mkdirSync(fixture.stateDir);
  fs.writeFileSync(path.join(fixture.stateDir, 'codex-host.json'), '{private malformed registry');
  const registryDir = path.join(fixture.root, 'registry-file');
  fs.writeFileSync(registryDir, 'private registry data');
  const codex = await mockPipe(t, { framed: true, onMessage(message, socket) {
    assert.equal(message.method, 'tools/list');
    answer(socket, message.id, { tools: [{ ...messageTool, inputSchema: { properties: { threadId: {} } } }, listTool] });
  } });
  const result = await executeBridgeTool('bridge_doctor', {}, { env: { CODEX_APP_TOOLS_PIPE_PATH: codex.pipePath },
    metadata: { 'openai/threadId': 'doctor-context' }, stateDir: fixture.stateDir, registryDir });
  for (const name of ['codex_registry', 'codex_tools', 'codex_context', 'claude_registry', 'claude_inbox']) {
    assert.equal(result.checks.find(check => check.name === name).status, 'fail', name);
  }
  assert.equal(result.ready, false);
  assert.doesNotMatch(JSON.stringify(result), /private malformed registry|private registry data/);
  assert.equal(fs.readFileSync(path.join(fixture.stateDir, 'codex-host.json'), 'utf8'), '{private malformed registry');
});

test('doctor verifies a Claude caller without writing state', windowsOnly, async t => {
  const fixture = await claudeFixture(t);
  const result = await executeBridgeTool('bridge_doctor', {}, { env: { CLAUDE_CODE_MESSAGING_SOCKET: fixture.inbox.pipePath },
    parentPid: process.pid, stateDir: fixture.stateDir, registryDir: fixture.registryDir });
  assert.equal(result.application, 'claude');
  assert.equal(result.checks.find(check => check.name === 'caller').status, 'pass');
  assert.equal(result.checks.find(check => check.name === 'claude_inbox').status, 'pass');
  assert.equal(fs.existsSync(fixture.stateDir), false);
  assert.equal(fixture.inbox.messages.length, 0);
});

test('doctor reaches an older valid context after three removed Codex chats', windowsOnly, async t => {
  const fixture = await claudeFixture(t);
  const codex = await mockPipe(t, { framed: true, onMessage(message, socket) {
    if (message.method === 'tools/list') return answer(socket, message.id, { tools: [messageTool, listTool] });
    assert.equal(message.params.tool, 'list_threads');
    if (message.params.threadId !== 'retained-live-context') {
      socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id,
        error: { code: -32603, message: 'Codex app tool request failed' } }));
      return;
    }
    answer(socket, message.id, { success: true, contentItems: [{ type: 'inputText', text: '{"threads":[]}' }] });
  } });
  for (const threadId of ['retained-live-context', 'removed-a', 'removed-b', 'removed-c']) {
    publishCodexHost({ stateDir: fixture.stateDir, pipePath: codex.pipePath, threadId });
  }
  const saved = fs.readFileSync(path.join(fixture.stateDir, 'codex-host.json'));
  const result = await executeBridgeTool('bridge_doctor', {}, { stateDir: fixture.stateDir,
    registryDir: fixture.registryDir, parentPid: process.pid,
    env: { CLAUDE_CODE_MESSAGING_SOCKET: fixture.inbox.pipePath } });
  assert.equal(result.ready, true);
  assert.equal(result.checks.find(check => check.name === 'codex_context').status, 'pass');
  assert.deepEqual(fs.readFileSync(path.join(fixture.stateDir, 'codex-host.json')), saved);
  assert.equal(fixture.inbox.messages.length, 0);
});

test('doctor cancellation stops a stalled catalog probe without state writes', async t => {
  const fixture = await nativeFixture(t);
  const controller = new AbortController();
  const codex = await mockPipe(t, { framed: true, onMessage() { controller.abort('private cancellation reason'); } });
  await assert.rejects(executeBridgeTool('bridge_doctor', {}, { env: { CODEX_APP_TOOLS_PIPE_PATH: codex.pipePath },
    metadata: { 'openai/threadId': 'doctor-context' }, stateDir: fixture.stateDir,
    registryDir: path.join(fixture.root, 'absent'), signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError');
    assert.doesNotMatch(error.message, /private cancellation reason/);
    return true;
  });
  assert.equal(fs.existsSync(fixture.stateDir), false);
  assert.equal(codex.messages.length, 1);
});

test('pre-cancelled transports never connect or write', async t => {
  const pipe = await mockPipe(t);
  const controller = new AbortController();
  controller.abort('private reason');
  for (const operation of [
    sendToClaude({ socketPath: pipe.pipePath, token: 'secret', message: 'no send', signal: controller.signal }),
    sendToCodex({ pipePath: pipe.pipePath, contextThreadId: 'context', threadId: 'destination', message: 'no send', signal: controller.signal }),
    probeClaudeInbox({ socketPath: pipe.pipePath, signal: controller.signal }),
  ]) {
    await assert.rejects(operation, error => {
      assert.equal(error.name, 'AbortError');
      assert.notEqual(error.deliveryUnknown, true);
      assert.doesNotMatch(error.message, /private reason/);
      return true;
    });
  }
  assert.equal(pipe.connections.length, 0);
});

test('Codex cancellation during catalog discovery sends no mutating request', async t => {
  const controller = new AbortController();
  const pipe = await mockPipe(t, { framed: true, onMessage(message) {
    assert.equal(message.method, 'tools/list');
    controller.abort();
  } });
  await assert.rejects(sendToCodex({ pipePath: pipe.pipePath, contextThreadId: 'context', threadId: 'destination',
    message: 'no send', signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError');
    assert.notEqual(error.deliveryUnknown, true);
    return true;
  });
  assert.equal(pipe.messages.length, 1);
});

test('Codex cancellation after a mutating transport write reports uncertain delivery and never retries', async t => {
  const controller = new AbortController();
  const pipe = await mockPipe(t, { framed: true, onMessage(message, socket) {
    if (message.method === 'tools/list') answer(socket, message.id, { tools: [messageTool] });
    else controller.abort();
  } });
  await assert.rejects(sendToCodex({ pipePath: pipe.pipePath, contextThreadId: 'context', threadId: 'destination',
    message: 'may already be delivered', signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.deliveryUnknown, true);
    assert.match(error.message, /uncertain/);
    return true;
  });
  assert.equal(pipe.messages.filter(entry => entry.message.method === 'tools/call').length, 1);
});

test('Claude cancellation after its user frame reports uncertain delivery without exposing credentials', async t => {
  const controller = new AbortController();
  const pipe = await mockPipe(t, { onMessage(message) {
    if (message.type === 'user') controller.abort('do not disclose');
  } });
  await assert.rejects(sendToClaude({ socketPath: pipe.pipePath, token: 'fixture secret', message: 'may already be delivered',
    signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.deliveryUnknown, true);
    assert.doesNotMatch(error.message, /fixture secret|do not disclose/);
    return true;
  });
  assert.equal(pipe.messages.filter(entry => entry.message.type === 'user').length, 1);
});

test('cancelled bridge sends retain an uncertain ledger and reject same-ID retry', windowsOnly, async t => {
  const controller = new AbortController();
  const fixture = await claudeFixture(t, message => {
    if (message.type === 'user') controller.abort();
  });
  const context = { env: { CODEX_APP_TOOLS_PIPE_PATH: '\\\\.\\pipe\\fixture-unused-codex' },
    metadata: { 'openai/threadId': 'sender-task' }, stateDir: fixture.stateDir, registryDir: fixture.registryDir,
    signal: controller.signal };
  const args = { session_id: fixture.record.sessionId, message: 'possible delivery', message_id: 'cancelled-send' };
  await assert.rejects(executeBridgeTool('send_to_claude', args, context), { name: 'AbortError', deliveryUnknown: true });
  const ledger = getSession({ stateDir: fixture.stateDir, threadId: 'sender-task' });
  assert.equal(getMessages(ledger)[0].status, 'uncertain');
  await assert.rejects(executeBridgeTool('send_to_claude', args, { ...context, signal: undefined }), /uncertain delivery/);
  assert.equal(fixture.inbox.messages.filter(entry => entry.message.type === 'user').length, 1);
});

test('pre-cancelled bridge execution does not reserve a message or register its sender', async t => {
  const fixture = await nativeFixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executeBridgeTool('send_to_claude', { session_id: 'unused', message: 'no send' }, {
    env: { CODEX_APP_TOOLS_PIPE_PATH: '\\\\.\\pipe\\fixture-unused-codex' }, metadata: { 'openai/threadId': 'sender-task' },
    stateDir: fixture.stateDir, registryDir: path.join(fixture.root, 'absent'), signal: controller.signal,
  }), { name: 'AbortError' });
  assert.equal(fs.existsSync(fixture.stateDir), false);
});

test('catalog cancellation never reports message delivery uncertainty', async t => {
  const controller = new AbortController();
  const pipe = await mockPipe(t, { framed: true, onMessage() { controller.abort(); } });
  await assert.rejects(listCodexTools(pipe.pipePath, { signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError');
    assert.notEqual(error.deliveryUnknown, true);
    return true;
  });
});
