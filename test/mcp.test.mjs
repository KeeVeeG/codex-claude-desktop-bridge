import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getSession, readSession } from '../lib/store.mjs';
import { nativeFixture, mockPipe, encodeFrame, messageTool } from './native-helpers.mjs';

const serverPath = fileURLToPath(new URL('../scripts/mcp.mjs', import.meta.url));
const processStart = process.platform === 'win32'
  ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc().ToString()`], { encoding: 'utf8', windowsHide: true }).stdout.trim()
  : String(Date.now());
const windowsOnly = { skip: process.platform !== 'win32' && 'Native Desktop registry uses Windows process identity.' };
const metadata = threadId => ({ 'x-codex-turn-metadata': { thread_id: threadId } });

function startMcp(t, env = {}, { parentProxy = false } = {}) {
  const childEnv = { ...process.env };
  for (const name of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_APP_TOOLS_PIPE_PATH', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']) delete childEnv[name];
  Object.assign(childEnv, env);
  const args = parentProxy
    ? ['-e', 'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,[process.argv[1]],{stdio:"inherit",windowsHide:true}); child.on("exit",code=>process.exit(code??1));', serverPath]
    : [serverPath];
  const child = spawn(process.execPath, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  let buffer = '';
  let nextId = 1;
  let stopped;
  const pending = new Map();
  const messages = [];
  const invalidLines = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { invalidLines.push(line); continue; }
      messages.push(message);
      const entry = pending.get(message.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      entry.resolve(message);
    }
  });
  function rejectPending(error) {
    stopped = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }
  child.on('error', rejectPending);
  child.on('exit', (code, signal) => rejectPending(new Error(`MCP exited (${code ?? signal}): ${stderr}`)));
  function notify(method, params = {}) {
    if (stopped) throw stopped;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  function rpc(method, params = {}) {
    if (stopped) return Promise.reject(stopped);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out: ${stderr}`));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  };
  t.after(close);
  t.after(() => assert.deepEqual(invalidLines, [], 'MCP stdout must contain protocol JSON only'));
  return { rpc, notify, close, messages, stderr: () => stderr, child };
}

async function initialize(client) {
  const response = await client.rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'desktop-bridge-test', version: '1.0.0' },
  });
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.equal(response.result.protocolVersion, '2024-11-05');
  assert.deepEqual(response.result.capabilities.tools, {});
  assert.equal(response.result.capabilities.experimental?.['claude/channel'], undefined);
  client.notify('notifications/initialized');
  return response;
}

function callTool(client, name, args = {}, meta) {
  return client.rpc('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
}

function toolValue(response) {
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.notEqual(response.result.isError, true, JSON.stringify(response.result));
  return JSON.parse(response.result.content[0].text);
}

function isToolFailure(response) {
  return Boolean(response.error || response.result?.isError);
}

async function setupMcp(t, { envThreadId, holdFirstNotification = false } = {}) {
  const fixture = await nativeFixture(t);
  const claude = await mockPipe(t);
  const notifications = [];
  let releaseHeldNotification;
  let resolveFirstNotification;
  const firstNotification = new Promise(resolve => { resolveFirstNotification = resolve; });
  const catalogCalls = [];
  const codexChats = [
    { id: 'codex-target-a', title: 'Target Codex A', status: 'idle', kind: 'codex', hostId: 'local' },
    { id: 'codex-target-b', title: 'Target Codex B', status: 'idle', kind: 'codex', hostId: 'local' },
  ];
  const listThreadsTool = { name: 'list_threads', namespace: 'codex_app', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } } };
  const codex = await mockPipe(t, {
    framed: true,
    onMessage(message, socket) {
      if (message.method === 'tools/list') {
        socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id, result: { tools: [messageTool, listThreadsTool] } }));
      } else if (message.params.tool === 'list_threads') {
        catalogCalls.push(message.params);
        const limit = message.params.arguments.limit;
        const result = !Number.isInteger(limit) || limit < 1 || limit > 50
          ? { success: false, contentItems: [{ type: 'inputText', text: 'Invalid list_threads arguments: limit must be an integer between 1 and 50.' }] }
          : { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ threads: codexChats.slice(0, limit), pinnedThreads: [] }) }] };
        socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id, result }));
      } else {
        assert.equal(message.method, 'tools/call');
        assert.equal(message.params.tool, 'send_message_to_thread');
        notifications.push(message.params);
        const acknowledge = () => socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id, result: { success: true, contentItems: [] } }));
        if (holdFirstNotification && notifications.length === 1) releaseHeldNotification = acknowledge;
        else acknowledge();
        if (notifications.length === 1) resolveFirstNotification(message.params);
      }
    },
  });
  const registryDir = path.join(fixture.root, 'registry');
  fs.mkdirSync(registryDir);
  const sessionId = randomUUID();
  const token = randomUUID().replaceAll('-', '');
  const pidDomain = `win32:${os.hostname().toLowerCase()}`;
  const record = { pid: process.pid, sessionId, name: 'Claude MCP test', cwd: fixture.cwd, entrypoint: 'claude-desktop', procStart: processStart, pidDomain, messagingSocketPath: claude.pipePath };
  fs.writeFileSync(path.join(registryDir, `${process.pid}.json`), JSON.stringify(record));
  const keyHash = createHash('sha256').update(claude.pipePath.toLowerCase()).digest('hex');
  fs.writeFileSync(path.join(registryDir, `${process.pid}.${keyHash}.key`), JSON.stringify({ peerToken: token, procStartFt: processStart, pidDomain }));
  const { publishCodexHost } = await import('../lib/codex-host.mjs');
  publishCodexHost({ stateDir: fixture.stateDir, pipePath: codex.pipePath, threadId: 'known-host-context', pid: process.pid });
  const env = {
    CODEX_CLAUDE_BRIDGE_STATE_DIR: fixture.stateDir,
    CODEX_CLAUDE_BRIDGE_REGISTRY_DIR: registryDir,
    CODEX_APP_TOOLS_PIPE_PATH: codex.pipePath,
    ...(envThreadId ? { CODEX_THREAD_ID: envThreadId } : {}),
  };
  const client = startMcp(t, env);
  await initialize(client);
  return { ...fixture, registryDir, sessionId, token, claude, codex, notifications, catalogCalls, codexChats, env, client,
    firstNotification, releaseFirstNotification() { releaseHeldNotification?.(); releaseHeldNotification = undefined; } };
}

function claudeEnv(setup) {
  return { CODEX_CLAUDE_BRIDGE_STATE_DIR: setup.stateDir, CODEX_CLAUDE_BRIDGE_REGISTRY_DIR: setup.registryDir };
}

function registerClaudeParent(setup, parentPid, socketPath) {
  const procStart = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${parentPid}).StartTime.ToFileTimeUtc().ToString()`], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  const sessionId = randomUUID();
  const pidDomain = `win32:${os.hostname().toLowerCase()}`;
  const record = { pid: parentPid, sessionId, name: 'Different Claude MCP parent', cwd: setup.cwd, entrypoint: 'claude-desktop', procStart, pidDomain, messagingSocketPath: socketPath };
  fs.writeFileSync(path.join(setup.registryDir, `${parentPid}.json`), JSON.stringify(record));
  const keyHash = createHash('sha256').update(socketPath.toLowerCase()).digest('hex');
  fs.writeFileSync(path.join(setup.registryDir, `${parentPid}.${keyHash}.key`), JSON.stringify({ peerToken: randomUUID().replaceAll('-', ''), procStartFt: procStart, pidDomain }));
  return sessionId;
}

test('MCP advertises symmetric pairing and text-only messages without routing tokens', async t => {
  const fixture = await nativeFixture(t);
  const client = startMcp(t, { CODEX_CLAUDE_BRIDGE_STATE_DIR: fixture.stateDir });
  await initialize(client);
  const listed = await client.rpc('tools/list');
  assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(), [
    'bridge_status', 'connect_claude', 'connect_codex', 'disconnect_bridge',
    'list_claude_sessions', 'list_codex_chats', 'send_to_claude', 'send_to_codex',
  ]);
  const listSchema = listed.result.tools.find(tool => tool.name === 'list_codex_chats').inputSchema;
  assert.equal(listSchema.properties.limit.maximum, 50);
  assert.equal(listed.result.tools.find(tool => tool.name === 'bridge_status').inputSchema.properties.limit.maximum, 100);
  const oversizedList = await callTool(client, 'list_codex_chats', { limit: 51 });
  assert.ok(isToolFailure(oversizedList));
  assert.match(JSON.stringify(oversizedList), /limit must be an integer from 1 to 50/);
  for (const toolName of ['send_to_claude', 'send_to_codex']) {
    const schema = listed.result.tools.find(tool => tool.name === toolName).inputSchema;
    assert.deepEqual(Object.keys(schema.properties).sort(), ['message', 'message_id']);
    for (const field of ['files', 'connection', 'connection_token', 'request_id', 'timeout_seconds']) {
      const response = await callTool(client, toolName, { message: 'Plain text only.', [field]: field === 'files' ? [] : 'retired' });
      assert.ok(isToolFailure(response));
      assert.match(JSON.stringify(response), new RegExp(`Unknown argument: ${field}`));
    }
  }
  assert.ok(isToolFailure(await callTool(client, 'ack_codex_request')));
  assert.deepEqual((await client.rpc('ping')).result, {});
});

test('Codex can initiate pairing and either peer can send independent messages without tokens', windowsOnly, async t => {
  const setup = await setupMcp(t, { envThreadId: 'environment-fallback' });
  const meta = metadata('origin-mcp-chat');
  const listed = toolValue(await callTool(setup.client, 'list_claude_sessions'));
  assert.match(JSON.stringify(listed), new RegExp(setup.sessionId));
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(setup.token));
  toolValue(await callTool(setup.client, 'connect_claude', { session_id: setup.sessionId }, meta));
  const plainMessage = 'Для информации: первая часть готова. Ответ не нужен.\n{"branch":"feature/unicode","custom":{"revision":7}}';
  toolValue(await callTool(setup.client, 'send_to_claude', { message: plainMessage, message_id: 'info-one' }, meta));
  toolValue(await callTool(setup.client, 'send_to_claude', { message: 'Ещё информация без ожидания ответа.', message_id: 'info-two' }, meta));
  const deliveries = setup.claude.messages.filter(entry => entry.message.type === 'user');
  assert.equal(deliveries.length, 2);
  assert.ok(deliveries[0].message.message.content.includes(plainMessage));
  assert.doesNotMatch(deliveries[0].message.message.content, /connection_token|reply_token|ack_codex_request|PowerShell syntax|Deadline:/);
  const peer = startMcp(t, claudeEnv(setup));
  await initialize(peer);
  const independent = 'Независимое замечание Claude.\n{"kind":"observation","custom":["α","β"]}';
  toolValue(await callTool(peer, 'send_to_codex', { message: independent, message_id: 'claude-info-one' }));
  toolValue(await callTool(peer, 'send_to_codex', { message: 'Another independent update.', message_id: 'claude-info-two' }));
  assert.equal(setup.notifications.length, 2);
  assert.ok(setup.notifications[0].arguments.prompt.includes(independent));
  for (const call of setup.notifications) assert.equal(call.arguments.threadId, 'origin-mcp-chat');
  for (const [client, callerMetadata] of [[setup.client, meta], [peer, undefined]]) {
    const status = toolValue(await callTool(client, 'bridge_status', { limit: 10 }, callerMetadata));
    assert.match(JSON.stringify(status), /первая часть готова/);
    assert.match(JSON.stringify(status), /Независимое замечание/);
  }
  const session = getSession({ stateDir: setup.stateDir, threadId: 'origin-mcp-chat' });
  assert.equal(getSession({ stateDir: setup.stateDir, threadId: 'environment-fallback' }), null);
  assert.doesNotMatch(JSON.stringify(readSession(session)), /deadlineAt|timeoutSeconds|activeRequestId|claudeConnectionToken|replyTokenHash/);
  const visible = JSON.stringify([...setup.client.messages, ...peer.messages]) + setup.client.stderr() + peer.stderr();
  assert.doesNotMatch(visible, new RegExp(setup.token));
});

test('Claude can discover and select a Codex chat before receiving any bridge message', windowsOnly, async t => {
  const setup = await setupMcp(t);
  const peer = startMcp(t, claudeEnv(setup));
  await initialize(peer);
  const chats = toolValue(await callTool(peer, 'list_codex_chats', { limit: 10 }));
  assert.match(JSON.stringify(chats), /Target Codex A/);
  assert.match(JSON.stringify(chats), /Target Codex B/);
  assert.ok(setup.catalogCalls.length > 0);
  assert.equal(setup.catalogCalls[0].threadId, 'known-host-context');
  toolValue(await callTool(peer, 'list_codex_chats', { limit: 50 }));
  assert.equal(setup.notifications.length, 0, 'listing does not send messages');
  assert.equal(setup.claude.messages.length, 0);
  assert.ok(isToolFailure(await callTool(peer, 'connect_codex', { thread_id: 'unknown-codex-chat' })));
  assert.equal(getSession({ stateDir: setup.stateDir, threadId: 'unknown-codex-chat' }), null);
  toolValue(await callTool(peer, 'connect_codex', { thread_id: 'codex-target-b' }));
  assert.ok(setup.catalogCalls.every(call => call.arguments.limit >= 1 && call.arguments.limit <= 50), 'discovery and connection must both respect native list_threads bounds');
  const session = getSession({ stateDir: setup.stateDir, threadId: 'codex-target-b' });
  assert.equal(readSession(session).desktop.claudeSessionId, setup.sessionId);
  toolValue(await callTool(peer, 'send_to_codex', { message: 'Claude started this conversation.', message_id: 'claude-first' }));
  assert.equal(setup.notifications.length, 1);
  assert.equal(setup.notifications[0].arguments.threadId, 'codex-target-b');
  toolValue(await callTool(setup.client, 'send_to_claude', { message: 'Codex responds through the same pairing.', message_id: 'codex-second' }, metadata('codex-target-b')));
  assert.equal(setup.claude.messages.filter(entry => entry.message.type === 'user').length, 1);
  const otherStatus = await callTool(setup.client, 'bridge_status', {}, metadata('codex-target-a'));
  assert.doesNotMatch(JSON.stringify(otherStatus), /Claude started this conversation/);
  toolValue(await callTool(peer, 'disconnect_bridge'));
  assert.ok(isToolFailure(await callTool(peer, 'send_to_codex', { message: 'Disconnected.' })));
  assert.ok(isToolFailure(await callTool(setup.client, 'send_to_claude', { message: 'Disconnected.' }, metadata('codex-target-b'))));
});

test('message IDs deduplicate concurrent submissions from separate MCP processes in either direction', windowsOnly, async t => {
  const setup = await setupMcp(t);
  const meta = metadata('codex-target-a');
  toolValue(await callTool(setup.client, 'connect_claude', { session_id: setup.sessionId }, meta));
  const twin = startMcp(t, setup.env);
  await initialize(twin);
  const outbound = { message: 'Send this only once.', message_id: 'same-outbound-id' };
  for (const response of await Promise.all([
    callTool(setup.client, 'send_to_claude', outbound, meta),
    callTool(twin, 'send_to_claude', outbound, meta),
  ])) toolValue(response);
  assert.equal(setup.claude.messages.filter(entry => entry.message.type === 'user').length, 1);
  assert.ok(isToolFailure(await callTool(setup.client, 'send_to_claude', { ...outbound, message: 'Changed payload.' }, meta)));
  const peer = startMcp(t, claudeEnv(setup));
  const peerTwin = startMcp(t, claudeEnv(setup));
  await Promise.all([initialize(peer), initialize(peerTwin)]);
  const inbound = { message: 'One independent observation.', message_id: 'same-inbound-id' };
  for (const response of await Promise.all([
    callTool(peer, 'send_to_codex', inbound), callTool(peerTwin, 'send_to_codex', inbound),
  ])) toolValue(response);
  assert.equal(setup.notifications.length, 1);
  assert.ok(isToolFailure(await callTool(peer, 'send_to_codex', { ...inbound, message: 'Changed observation.' })));
});

test('shared-server Codex metadata isolates sibling tasks and rejects malformed identities', windowsOnly, async t => {
  const setup = await setupMcp(t, { envThreadId: 'owner-chat' });
  const meta = metadata('owner-chat');
  toolValue(await callTool(setup.client, 'connect_claude', { session_id: setup.sessionId }, meta));
  toolValue(await callTool(setup.client, 'send_to_claude', { message: 'Private owner information.', message_id: 'owner-private' }, meta));
  const otherMeta = { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'other-chat' }) };
  assert.ok(isToolFailure(await callTool(setup.client, 'send_to_claude', { message: 'Wrong chat.' }, otherMeta)));
  assert.doesNotMatch(JSON.stringify(await callTool(setup.client, 'bridge_status', {}, otherMeta)), /Private owner information/);
  assert.ok(isToolFailure(await callTool(setup.client, 'connect_claude', { session_id: setup.sessionId }, otherMeta)));
  for (const invalid of [
    { ...meta, 'openai/threadId': 'other-chat' },
    { 'x-codex-turn-metadata': { thread_id: 123 } },
    { 'x-codex-turn-metadata': { thread_id: '' } },
    { 'x-codex-turn-metadata': 'not-json' },
  ]) assert.ok(isToolFailure(await callTool(setup.client, 'bridge_status', {}, invalid)));
  assert.equal(setup.claude.messages.filter(entry => entry.message.type === 'user').length, 1);
});

test('another registered Claude parent in the same project cannot use or hijack an existing pairing', windowsOnly, async t => {
  const setup = await setupMcp(t);
  toolValue(await callTool(setup.client, 'connect_claude', { session_id: setup.sessionId }, metadata('codex-target-a')));
  toolValue(await callTool(setup.client, 'send_to_claude', { message: 'Private conversation A.', message_id: 'private-a' }, metadata('codex-target-a')));
  const otherPipe = await mockPipe(t);
  const otherPeer = startMcp(t, claudeEnv(setup), { parentProxy: true });
  const otherSessionId = registerClaudeParent(setup, otherPeer.child.pid, otherPipe.pipePath);
  await initialize(otherPeer);
  assert.ok(isToolFailure(await callTool(otherPeer, 'send_to_codex', { message: 'Must not reach A.' })));
  assert.doesNotMatch(JSON.stringify(await callTool(otherPeer, 'bridge_status')), /Private conversation A/);
  toolValue(await callTool(otherPeer, 'disconnect_bridge'));
  assert.equal(readSession(getSession({ stateDir: setup.stateDir, threadId: 'codex-target-a' })).desktop.claudeSessionId, setup.sessionId);
  assert.ok(isToolFailure(await callTool(otherPeer, 'connect_codex', { thread_id: 'codex-target-a' })));
  assert.equal(setup.notifications.length, 0);
  toolValue(await callTool(otherPeer, 'connect_codex', { thread_id: 'codex-target-b' }));
  const otherState = readSession(getSession({ stateDir: setup.stateDir, threadId: 'codex-target-b' }));
  assert.equal(otherState.desktop.claudeSessionId, otherSessionId);
  toolValue(await callTool(otherPeer, 'send_to_codex', { message: 'Private conversation B.', message_id: 'private-b' }));
  assert.equal(setup.notifications.length, 1);
  assert.equal(setup.notifications[0].arguments.threadId, 'codex-target-b');
  const ownerStatus = toolValue(await callTool(setup.client, 'bridge_status', {}, metadata('codex-target-a')));
  assert.doesNotMatch(JSON.stringify(ownerStatus), /Private conversation B/);
});

test('an unregistered parent cannot impersonate Claude by supplying its socket path', windowsOnly, async t => {
  const setup = await setupMcp(t);
  toolValue(await callTool(setup.client, 'connect_claude', { session_id: setup.sessionId }, metadata('codex-target-a')));
  const impostor = startMcp(t, { ...claudeEnv(setup), CLAUDE_CODE_MESSAGING_SOCKET: setup.claude.pipePath }, { parentProxy: true });
  await initialize(impostor);
  assert.ok(isToolFailure(await callTool(impostor, 'send_to_codex', { message: 'Forged parent.' })));
  assert.ok(isToolFailure(await callTool(impostor, 'bridge_status')));
  assert.equal(setup.notifications.length, 0);
});

test('re-pairing isolates private history and message IDs even when the old pair finishes a send later', windowsOnly, async t => {
  const setup = await setupMcp(t, { holdFirstNotification: true });
  const meta = metadata('codex-target-a');
  toolValue(await callTool(setup.client, 'connect_claude', { session_id: setup.sessionId }, meta));
  const session = getSession({ stateDir: setup.stateDir, threadId: 'codex-target-a' });
  const oldPairId = readSession(session).desktop.pairId;
  assert.ok(oldPairId);
  const outboundA = { message: 'Private A: original Codex message.', message_id: 'reused-outbound-id' };
  toolValue(await callTool(setup.client, 'send_to_claude', outboundA, meta));
  const peerA = startMcp(t, claudeEnv(setup));
  await initialize(peerA);
  const delayed = callTool(peerA, 'send_to_codex', { message: 'Private A: delayed Claude message.', message_id: 'reused-inbound-id' });
  delayed.catch(() => {});
  await Promise.race([
    setup.firstNotification,
    delayed.then(response => assert.fail(`Old delivery should remain in flight: ${JSON.stringify(response)}`)),
  ]);
  t.after(() => setup.releaseFirstNotification());
  toolValue(await callTool(setup.client, 'disconnect_bridge', {}, meta));

  const claudeB = await mockPipe(t);
  const peerB = startMcp(t, claudeEnv(setup), { parentProxy: true });
  const sessionB = registerClaudeParent(setup, peerB.child.pid, claudeB.pipePath);
  await initialize(peerB);
  toolValue(await callTool(peerB, 'connect_codex', { thread_id: 'codex-target-a' }));
  const newBinding = readSession(session).desktop;
  assert.equal(newBinding.claudeSessionId, sessionB);
  assert.notEqual(newBinding.pairId, oldPairId);
  for (const [client, callerMetadata] of [[setup.client, meta], [peerB, undefined]]) {
    const status = toolValue(await callTool(client, 'bridge_status', { limit: 100 }, callerMetadata));
    assert.deepEqual(status.messages, []);
    assert.doesNotMatch(JSON.stringify(status), /Private A/);
  }

  const outboundB = { message: 'Private B: replacement Codex message.', message_id: outboundA.message_id };
  toolValue(await callTool(setup.client, 'send_to_claude', outboundB, meta));
  toolValue(await callTool(setup.client, 'send_to_claude', outboundB, meta));
  const inboundB = { message: 'Private B: replacement Claude message.', message_id: 'reused-inbound-id' };
  toolValue(await callTool(peerB, 'send_to_codex', inboundB));
  toolValue(await callTool(peerB, 'send_to_codex', inboundB));
  assert.equal(setup.claude.messages.filter(entry => entry.message.type === 'user').length, 1);
  const deliveriesB = claudeB.messages.filter(entry => entry.message.type === 'user');
  assert.equal(deliveriesB.length, 1);
  assert.ok(deliveriesB[0].message.message.content.includes(outboundB.message));
  assert.equal(setup.notifications.length, 2);
  assert.match(setup.notifications[0].arguments.prompt, /Private A/);
  assert.match(setup.notifications[1].arguments.prompt, /Private B/);

  setup.releaseFirstNotification();
  toolValue(await delayed);
  for (const [client, callerMetadata] of [[setup.client, meta], [peerB, undefined]]) {
    const status = toolValue(await callTool(client, 'bridge_status', { limit: 100 }, callerMetadata));
    assert.equal(status.messages.length, 2);
    assert.ok(status.messages.every(message => message.pairId === newBinding.pairId));
    assert.ok(status.messages.every(message => message.status === 'submitted'));
    assert.doesNotMatch(JSON.stringify(status), /Private A/);
  }
  const oldStatus = toolValue(await callTool(peerA, 'bridge_status'));
  assert.equal(oldStatus.connected, false);
  assert.doesNotMatch(JSON.stringify(oldStatus), /Private B/);
  assert.ok(isToolFailure(await callTool(peerA, 'send_to_codex', { message: 'Old pair must not reach replacement.' })));
});

test('an unrelated abandoned state directory does not break Claude discovery, pairing, or messages', windowsOnly, async t => {
  const setup = await setupMcp(t);
  const abandoned = path.join(setup.stateDir, 'f'.repeat(64));
  fs.mkdirSync(abandoned, { recursive: true });
  fs.writeFileSync(path.join(abandoned, 'unfinished.tmp'), 'Unrelated unfinished session initialization.');
  const peer = startMcp(t, claudeEnv(setup));
  await initialize(peer);
  assert.equal(toolValue(await callTool(peer, 'bridge_status')).connected, false);
  assert.match(JSON.stringify(toolValue(await callTool(peer, 'list_codex_chats'))), /Target Codex A/);
  toolValue(await callTool(peer, 'connect_codex', { thread_id: 'codex-target-a' }));
  toolValue(await callTool(peer, 'send_to_codex', { message: 'Claude works despite unrelated incomplete state.', message_id: 'abandoned-directory-note' }));
  assert.equal(setup.notifications.length, 1);
  assert.equal(setup.notifications[0].arguments.threadId, 'codex-target-a');
  const status = toolValue(await callTool(peer, 'bridge_status'));
  assert.match(JSON.stringify(status), /Claude works despite unrelated incomplete state/);
  toolValue(await callTool(peer, 'disconnect_bridge'));
  assert.equal(fs.readFileSync(path.join(abandoned, 'unfinished.tmp'), 'utf8'), 'Unrelated unfinished session initialization.');
});
