import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createSession, getSession, readSession, updateSession, recordMessage } from '../lib/store.mjs';
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

test('MCP advertises direct, addressed messages without pair-management tools or routing tokens', async t => {
  const fixture = await nativeFixture(t);
  const client = startMcp(t, { CODEX_CLAUDE_BRIDGE_STATE_DIR: fixture.stateDir });
  await initialize(client);
  const listed = await client.rpc('tools/list');
  assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(), [
    'bridge_status', 'list_claude_sessions', 'list_codex_chats', 'send_to_claude', 'send_to_codex',
  ]);
  const listSchema = listed.result.tools.find(tool => tool.name === 'list_codex_chats').inputSchema;
  assert.equal(listSchema.properties.limit.maximum, 50);
  assert.equal(listed.result.tools.find(tool => tool.name === 'bridge_status').inputSchema.properties.limit.maximum, 100);
  const oversizedList = await callTool(client, 'list_codex_chats', { limit: 51 });
  assert.ok(isToolFailure(oversizedList));
  assert.match(JSON.stringify(oversizedList), /limit must be an integer from 1 to 50/);
  for (const toolName of ['send_to_claude', 'send_to_codex']) {
    const schema = listed.result.tools.find(tool => tool.name === toolName).inputSchema;
    const targetField = toolName === 'send_to_claude' ? 'session_id' : 'thread_id';
    assert.deepEqual(Object.keys(schema.properties).sort(), ['message', 'message_id', targetField].sort());
    assert.deepEqual(schema.required.sort(), ['message', targetField].sort());
    assert.ok(isToolFailure(await callTool(client, toolName, { message: 'Missing destination.' })));
    for (const field of ['files', 'connection', 'connection_token', 'request_id', 'timeout_seconds']) {
      const response = await callTool(client, toolName, { message: 'Plain text only.', [targetField]: 'chosen-target',
        [field]: field === 'files' ? [] : 'retired' });
      assert.ok(isToolFailure(response));
      assert.match(JSON.stringify(response), new RegExp(`Unknown argument: ${field}`));
    }
  }
  assert.ok(isToolFailure(await callTool(client, 'ack_codex_request')));
  assert.ok(isToolFailure(await callTool(client, 'connect_claude', { session_id: 'unused' })));
  assert.ok(isToolFailure(await callTool(client, 'disconnect_bridge')));
  assert.deepEqual((await client.rpc('ping')).result, {});
});

test('Codex and Claude can initiate independent addressed messages without a connection or reply', windowsOnly, async t => {
  const setup = await setupMcp(t, { envThreadId: 'environment-fallback' });
  const meta = metadata('origin-mcp-chat');
  const listed = toolValue(await callTool(setup.client, 'list_claude_sessions'));
  assert.match(JSON.stringify(listed), new RegExp(setup.sessionId));
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(setup.token));
  const plainMessage = 'Для информации: первая часть готова. Ответ не нужен.\n{"branch":"feature/unicode","custom":{"revision":7}}';
  toolValue(await callTool(setup.client, 'send_to_claude', { session_id: setup.sessionId, message: plainMessage, message_id: 'info-one' }, meta));
  toolValue(await callTool(setup.client, 'send_to_claude', { session_id: setup.sessionId, message: 'Ещё информация без ожидания ответа.', message_id: 'info-two' }, meta));
  const deliveries = setup.claude.messages.filter(entry => entry.message.type === 'user');
  assert.equal(deliveries.length, 2);
  assert.ok(deliveries[0].message.message.content.includes(plainMessage));
  assert.match(JSON.stringify(deliveries[0].message), /Codex task origin-mcp-chat/);
  assert.doesNotMatch(deliveries[0].message.message.content, /connection_token|reply_token|ack_codex_request|PowerShell syntax|Deadline:/);
  const peer = startMcp(t, claudeEnv(setup));
  await initialize(peer);
  const independent = 'Независимое замечание Claude.\n{"kind":"observation","custom":["α","β"]}';
  toolValue(await callTool(peer, 'send_to_codex', { thread_id: 'origin-mcp-chat', message: independent, message_id: 'claude-info-one' }));
  toolValue(await callTool(peer, 'send_to_codex', { thread_id: 'origin-mcp-chat', message: 'Another independent update.', message_id: 'claude-info-two' }));
  assert.equal(setup.notifications.length, 2);
  assert.ok(setup.notifications[0].arguments.prompt.includes(independent));
  assert.match(setup.notifications[0].arguments.prompt, new RegExp(setup.sessionId));
  for (const call of setup.notifications) assert.equal(call.arguments.threadId, 'origin-mcp-chat');
  const codexStatus = toolValue(await callTool(setup.client, 'bridge_status', { limit: 10 }, meta));
  const claudeStatus = toolValue(await callTool(peer, 'bridge_status', { limit: 10 }));
  assert.match(JSON.stringify(codexStatus), /первая часть готова/);
  assert.doesNotMatch(JSON.stringify(codexStatus), /Независимое замечание/);
  assert.match(JSON.stringify(claudeStatus), /Независимое замечание/);
  assert.doesNotMatch(JSON.stringify(claudeStatus), /первая часть готова/);
  assert.ok(codexStatus.messages.every(message => message.route.from.kind === 'codex' && message.route.from.id === 'origin-mcp-chat'));
  assert.ok(claudeStatus.messages.every(message => message.route.from.kind === 'claude' && message.route.from.id === setup.sessionId));
  assert.equal(getSession({ stateDir: setup.stateDir, threadId: 'environment-fallback' }), null);
  const visible = JSON.stringify([...setup.client.messages, ...peer.messages]) + setup.client.stderr() + peer.stderr();
  assert.doesNotMatch(visible, new RegExp(setup.token));
});

test('Claude can discover and address a Codex chat before receiving any bridge message', windowsOnly, async t => {
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
  toolValue(await callTool(peer, 'send_to_codex', { thread_id: 'codex-target-b', message: 'Claude started this conversation.', message_id: 'claude-first' }));
  assert.equal(setup.notifications.length, 1);
  assert.equal(setup.notifications[0].arguments.threadId, 'codex-target-b');
  const olderThreadId = 'codex-older-than-recent-list';
  assert.ok(!chats.some(chat => chat.thread_id === olderThreadId));
  toolValue(await callTool(peer, 'send_to_codex', { thread_id: olderThreadId,
    message: 'An exact older task ID remains addressable.', message_id: 'claude-older' }));
  assert.equal(setup.notifications[1].arguments.threadId, olderThreadId);
  toolValue(await callTool(setup.client, 'send_to_claude', { session_id: setup.sessionId, message: 'Codex responds to the sender.', message_id: 'codex-second' }, metadata('codex-target-b')));
  assert.equal(setup.claude.messages.filter(entry => entry.message.type === 'user').length, 1);
  const otherStatus = await callTool(setup.client, 'bridge_status', {}, metadata('codex-target-a'));
  assert.doesNotMatch(JSON.stringify(otherStatus), /Claude started this conversation/);
  assert.ok(setup.catalogCalls.every(call => call.arguments.limit >= 1 && call.arguments.limit <= 50));
});

test('message IDs deduplicate concurrent submissions from separate MCP processes in either direction', windowsOnly, async t => {
  const setup = await setupMcp(t);
  const meta = metadata('codex-target-a');
  const twin = startMcp(t, setup.env);
  await initialize(twin);
  const outbound = { session_id: setup.sessionId, message: 'Send this only once.', message_id: 'same-outbound-id' };
  for (const response of await Promise.all([
    callTool(setup.client, 'send_to_claude', outbound, meta),
    callTool(twin, 'send_to_claude', outbound, meta),
  ])) toolValue(response);
  assert.equal(setup.claude.messages.filter(entry => entry.message.type === 'user').length, 1);
  assert.ok(isToolFailure(await callTool(setup.client, 'send_to_claude', { ...outbound, message: 'Changed payload.' }, meta)));
  const peer = startMcp(t, claudeEnv(setup));
  const peerTwin = startMcp(t, claudeEnv(setup));
  await Promise.all([initialize(peer), initialize(peerTwin)]);
  const inbound = { thread_id: 'codex-target-a', message: 'One independent observation.', message_id: 'same-inbound-id' };
  for (const response of await Promise.all([
    callTool(peer, 'send_to_codex', inbound), callTool(peerTwin, 'send_to_codex', inbound),
  ])) toolValue(response);
  assert.equal(setup.notifications.length, 1);
  assert.ok(isToolFailure(await callTool(peer, 'send_to_codex', { ...inbound, message: 'Changed observation.' })));
});

test('shared-server Codex metadata isolates sibling tasks and rejects malformed identities', windowsOnly, async t => {
  const setup = await setupMcp(t, { envThreadId: 'owner-chat' });
  const meta = metadata('owner-chat');
  toolValue(await callTool(setup.client, 'send_to_claude', { session_id: setup.sessionId, message: 'Private owner information.', message_id: 'owner-private' }, meta));
  const otherMeta = { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'other-chat' }) };
  toolValue(await callTool(setup.client, 'send_to_claude', { session_id: setup.sessionId, message: 'Independent sibling message.', message_id: 'sibling' }, otherMeta));
  assert.doesNotMatch(JSON.stringify(await callTool(setup.client, 'bridge_status', {}, otherMeta)), /Private owner information/);
  assert.doesNotMatch(JSON.stringify(await callTool(setup.client, 'bridge_status', {}, meta)), /Independent sibling message/);
  // The startup task ID cannot identify a call from a shared MCP server.
  const missingIdentityStatus = await callTool(setup.client, 'bridge_status');
  assert.ok(isToolFailure(missingIdentityStatus));
  assert.doesNotMatch(JSON.stringify(missingIdentityStatus), /Private owner information/);
  assert.ok(isToolFailure(await callTool(setup.client, 'send_to_claude', {
    session_id: setup.sessionId, message: 'Do not attribute this call to the startup task.',
  })));
  for (const invalid of [
    { ...meta, 'openai/threadId': 'other-chat' },
    { 'x-codex-turn-metadata': { thread_id: 123 } },
    { 'x-codex-turn-metadata': { thread_id: '' } },
    { 'x-codex-turn-metadata': 'not-json' },
  ]) assert.ok(isToolFailure(await callTool(setup.client, 'bridge_status', {}, invalid)));
  assert.equal(setup.claude.messages.filter(entry => entry.message.type === 'user').length, 2);
});

test('a v0.1.0 pairing record cannot constrain direct sends or leak into new status', windowsOnly, async t => {
  const setup = await setupMcp(t);
  const threadId = 'legacy-codex-chat';
  const ledger = createSession({ stateDir: setup.stateDir, threadId, cwd: setup.cwd });
  const legacyDesktop = { threadId, pairId: 'legacy-pair', claudeSessionId: 'legacy-claude-session' };
  updateSession(ledger, state => { state.desktop = legacyDesktop; });
  recordMessage(ledger, { id: 'old-message', pairId: 'legacy-pair', direction: 'to_claude', message: 'Old private delivery.' });

  toolValue(await callTool(setup.client, 'send_to_claude', {
    session_id: setup.sessionId, message: 'New direct delivery.', message_id: 'new-message',
  }, metadata(threadId)));
  const status = toolValue(await callTool(setup.client, 'bridge_status', {}, metadata(threadId)));
  assert.equal(status.messages.length, 1);
  assert.equal(status.messages[0].route.to.id, setup.sessionId);
  assert.doesNotMatch(JSON.stringify(status), /Old private delivery|legacy-claude-session/);
  assert.deepEqual(readSession(ledger).desktop, legacyDesktop);
  assert.equal(setup.claude.messages.filter(entry => entry.message.type === 'user').length, 1);
});

test('two Codex tasks and two Claude sessions can freely send to every opposite-side conversation', windowsOnly, async t => {
  const setup = await setupMcp(t);
  const peerA = startMcp(t, claudeEnv(setup));
  await initialize(peerA);
  const claudeB = await mockPipe(t);
  const peerB = startMcp(t, claudeEnv(setup), { parentProxy: true });
  const sessionB = registerClaudeParent(setup, peerB.child.pid, claudeB.pipePath);
  await initialize(peerB);

  for (const codexId of ['codex-target-a', 'codex-target-b']) {
    for (const claudeId of [setup.sessionId, sessionB]) {
      toolValue(await callTool(setup.client, 'send_to_claude', {
        session_id: claudeId, message: `From ${codexId} to ${claudeId}.`, message_id: 'same-per-target-id',
      }, metadata(codexId)));
    }
  }
  for (const [peer, claudeId] of [[peerA, setup.sessionId], [peerB, sessionB]]) {
    for (const codexId of ['codex-target-a', 'codex-target-b']) {
      toolValue(await callTool(peer, 'send_to_codex', {
        thread_id: codexId, message: `From ${claudeId} to ${codexId}.`, message_id: 'same-per-target-id',
      }));
    }
  }

  const deliveriesA = setup.claude.messages.filter(entry => entry.message.type === 'user');
  const deliveriesB = claudeB.messages.filter(entry => entry.message.type === 'user');
  assert.equal(deliveriesA.length, 2);
  assert.equal(deliveriesB.length, 2);
  assert.equal(setup.notifications.length, 4);
  assert.deepEqual(setup.notifications.map(call => call.arguments.threadId), [
    'codex-target-a', 'codex-target-b', 'codex-target-a', 'codex-target-b',
  ]);
  for (const codexId of ['codex-target-a', 'codex-target-b']) {
    assert.ok([...deliveriesA, ...deliveriesB].some(entry => JSON.stringify(entry.message).includes(`Codex task ${codexId}`)));
    const status = toolValue(await callTool(setup.client, 'bridge_status', {}, metadata(codexId)));
    assert.equal(status.messages.length, 2);
    assert.ok(status.messages.every(message => message.route.from.kind === 'codex' && message.route.from.id === codexId));
  }
  for (const [peer, claudeId, otherId] of [[peerA, setup.sessionId, sessionB], [peerB, sessionB, setup.sessionId]]) {
    const status = toolValue(await callTool(peer, 'bridge_status'));
    assert.equal(status.messages.length, 2);
    assert.ok(status.messages.every(message => message.route.from.kind === 'claude' && message.route.from.id === claudeId));
    assert.doesNotMatch(JSON.stringify(status), new RegExp(`From ${otherId} to`));
  }
  for (const call of setup.notifications) {
    assert.ok([setup.sessionId, sessionB].some(id => call.arguments.prompt.includes(`Claude Desktop session ${JSON.stringify(id)}`)));
  }
});

test('an unregistered parent cannot impersonate Claude by supplying its socket path', windowsOnly, async t => {
  const setup = await setupMcp(t);
  const impostor = startMcp(t, { ...claudeEnv(setup), CLAUDE_CODE_MESSAGING_SOCKET: setup.claude.pipePath }, { parentProxy: true });
  await initialize(impostor);
  assert.ok(isToolFailure(await callTool(impostor, 'send_to_codex', { thread_id: 'codex-target-a', message: 'Forged parent.' })));
  assert.ok(isToolFailure(await callTool(impostor, 'bridge_status')));
  assert.equal(setup.notifications.length, 0);
});

test('an in-flight send from one Claude session does not block another session with the same message ID', windowsOnly, async t => {
  const setup = await setupMcp(t, { holdFirstNotification: true });
  const peerA = startMcp(t, claudeEnv(setup));
  const peerATwin = startMcp(t, claudeEnv(setup));
  await Promise.all([initialize(peerA), initialize(peerATwin)]);
  const claudeB = await mockPipe(t);
  const peerB = startMcp(t, claudeEnv(setup), { parentProxy: true });
  const sessionB = registerClaudeParent(setup, peerB.child.pid, claudeB.pipePath);
  await initialize(peerB);

  const delayed = callTool(peerA, 'send_to_codex', { thread_id: 'codex-target-a',
    message: 'Delayed message from Claude A.', message_id: 'shared-id' });
  delayed.catch(() => {});
  await Promise.race([
    setup.firstNotification,
    delayed.then(response => assert.fail(`First delivery should remain in flight: ${JSON.stringify(response)}`)),
  ]);
  t.after(() => setup.releaseFirstNotification());
  toolValue(await callTool(peerB, 'send_to_codex', { thread_id: 'codex-target-a',
    message: 'Independent message from Claude B.', message_id: 'shared-id' }));
  assert.equal(setup.notifications.length, 2);
  assert.match(setup.notifications[0].arguments.prompt, new RegExp(setup.sessionId));
  assert.match(setup.notifications[1].arguments.prompt, new RegExp(sessionB));

  // MCP requests are serialized per process. A second process of the same
  // verified caller can inspect the ledger while the first send is pending.
  const statusAInFlight = toolValue(await callTool(peerATwin, 'bridge_status'));
  const statusBDone = toolValue(await callTool(peerB, 'bridge_status'));
  assert.equal(statusAInFlight.messages.length, 1);
  assert.equal(statusAInFlight.messages[0].status, 'sending');
  assert.equal(statusBDone.messages.length, 1);
  assert.equal(statusBDone.messages[0].status, 'submitted');
  assert.doesNotMatch(JSON.stringify(statusAInFlight), /Independent message from Claude B/);
  assert.doesNotMatch(JSON.stringify(statusBDone), /Delayed message from Claude A/);

  setup.releaseFirstNotification();
  toolValue(await delayed);
  const statusAFinished = toolValue(await callTool(peerA, 'bridge_status'));
  assert.equal(statusAFinished.messages[0].status, 'submitted');
  assert.equal(statusAFinished.messages[0].route.from.id, setup.sessionId);
  assert.equal(statusBDone.messages[0].route.from.id, sessionB);
});

test('an unrelated abandoned state directory does not break Claude discovery or direct messages', windowsOnly, async t => {
  const setup = await setupMcp(t);
  const abandoned = path.join(setup.stateDir, 'f'.repeat(64));
  fs.mkdirSync(abandoned, { recursive: true });
  fs.writeFileSync(path.join(abandoned, 'unfinished.tmp'), 'Unrelated unfinished session initialization.');
  const peer = startMcp(t, claudeEnv(setup));
  await initialize(peer);
  assert.deepEqual(toolValue(await callTool(peer, 'bridge_status')).messages, []);
  assert.match(JSON.stringify(toolValue(await callTool(peer, 'list_codex_chats'))), /Target Codex A/);
  toolValue(await callTool(peer, 'send_to_codex', { thread_id: 'codex-target-a', message: 'Claude works despite unrelated incomplete state.', message_id: 'abandoned-directory-note' }));
  assert.equal(setup.notifications.length, 1);
  assert.equal(setup.notifications[0].arguments.threadId, 'codex-target-a');
  const status = toolValue(await callTool(peer, 'bridge_status'));
  assert.match(JSON.stringify(status), /Claude works despite unrelated incomplete state/);
  assert.equal(fs.readFileSync(path.join(abandoned, 'unfinished.tmp'), 'utf8'), 'Unrelated unfinished session initialization.');
});
