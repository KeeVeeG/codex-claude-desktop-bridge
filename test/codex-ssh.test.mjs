import test from 'node:test';
import assert from 'node:assert/strict';
import { sendToCodex, listCodexChats } from '../lib/codex-desktop.mjs';
import { sshFixture } from './ssh-helpers.mjs';

const options = fixture => ({ sshHostAlias: 'codex-test-host', threadId: 'target-thread',
  message: 'Report with unicode ✅\nand a newline', spawnImpl: fixture.spawnImpl, timeoutMs: 1000 });

test('SSH sends one turn to the loaded selected thread through the public proxy', async () => {
  const fixture = sshFixture();
  const receipt = await sendToCodex(options(fixture));
  assert.deepEqual(receipt, { transport: 'ssh-app-server', turnId: 'accepted-turn', threadId: 'target-thread' });
  assert.equal(fixture.launches[0].command, '/usr/bin/ssh');
  assert.ok(fixture.launches[0].args.includes('-oBatchMode=yes'));
  assert.ok(fixture.launches[0].args.includes('-oStrictHostKeyChecking=yes'));
  assert.ok(fixture.launches[0].args.includes('codex-test-host'));
  const turns = fixture.requests.filter(r => r.method === 'turn/start');
  assert.deepEqual(turns.map(r => r.params), [{ threadId: 'target-thread', input: [{ type: 'text', text: options(fixture).message }] }]);
  assert.equal(fixture.requests.filter(r => r.method === 'initialize').length, 1);
  assert.equal(fixture.requests.filter(r => r.method === 'initialized').length, 1);
  assert.ok(!fixture.requests.some(r => r.method === 'thread/start' || r.method === 'thread/resume' || r.method === 'tools/call'));
  assert.ok(fixture.children[0].stdin.destroyed);
});

test('SSH discovery lists only loaded chats on the configured server', async () => {
  const fixture = sshFixture();
  const chats = await listCodexChats({ ...options(fixture), limit: 1 });
  assert.deepEqual(chats, [{ thread_id: 'target-thread', title: 'Selected SSH chat', status: 'idle', cwd: '/test/project', host_id: 'ssh:codex-test-host' }]);
  assert.equal(fixture.requests.filter(r => r.method === 'thread/read').length, 1);
  assert.ok(!fixture.requests.some(r => r.method === 'turn/start' || r.method === 'thread/resume'));
});

for (const status of ['notLoaded', 'active', 'systemError']) {
  test(`SSH refuses ${status} targets before submitting a turn`, async () => {
    const fixture = sshFixture({ status });
    await assert.rejects(sendToCodex(options(fixture)), /loaded and idle/);
    assert.ok(!fixture.requests.some(r => r.method === 'turn/start'));
  });
}

test('SSH accepts fragmented JSON frames interleaved with ping frames', async () => {
  const fixture = sshFixture({ fragmented: true });
  assert.equal((await sendToCodex(options(fixture))).turnId, 'accepted-turn');
});

test('SSH ignores server requests whose IDs collide with pending client calls', async () => {
  const fixture = sshFixture({ collidingRequests: true });
  assert.equal((await sendToCodex(options(fixture))).turnId, 'accepted-turn');
  assert.equal(fixture.acceptedTurns.length, 1);
});

test('SSH sends to long conversations without reading history or resuming them', async () => {
  const fixture = sshFixture({ historyBytes: 9 * 1024 * 1024 });
  assert.equal((await sendToCodex(options(fixture))).turnId, 'accepted-turn');
  assert.ok(fixture.requests.every(r => r.method !== 'thread/resume' && !r.params?.includeTurns));
  assert.equal(fixture.acceptedTurns.length, 1);
});

test('SSH never reloads a target that unloads between its metadata read and send', async () => {
  const fixture = sshFixture({ unloadAfterRead: true });
  await assert.rejects(sendToCodex(options(fixture)), /thread not found/);
  assert.equal(fixture.acceptedTurns.length, 0);
  assert.equal(fixture.requests.filter(r => r.method === 'turn/start').length, 1);
  assert.ok(fixture.requests.every(r => r.method !== 'thread/resume' && r.method !== 'thread/start'));
});

test('SSH rejects a response for another exact thread before submitting any input', async () => {
  const fixture = sshFixture({ thread: { id: 'another-thread' } });
  await assert.rejects(sendToCodex(options(fixture)), /unsupported target thread/);
  assert.ok(fixture.requests.every(r => r.method !== 'turn/start'));
});

test('SSH normalizes UUID casing for exact lookup, response matching, and discovery', async () => {
  const id = 'a1234567-bcde-f123-abcd-123456789abc';
  const fixture = sshFixture({ thread: { id: id.toUpperCase() }, loaded: [id.toUpperCase(), id] });
  const receipt = await sendToCodex({ ...options(fixture), threadId: id.toUpperCase() });
  assert.equal(receipt.threadId, id);
  const chats = await listCodexChats(options(fixture));
  assert.deepEqual(chats.map(chat => chat.thread_id), [id]);
  assert.ok(fixture.requests.filter(r => r.method === 'thread/read' || r.method === 'turn/start')
    .every(r => r.params.threadId === id));
});

test('SSH discovery bounds and normalizes display titles while preserving valid cwd', async () => {
  const fixture = sshFixture({ thread: { name: `  Long\n title ${'x'.repeat(300)}  `, cwd: '/test/project with spaces' } });
  const [chat] = await listCodexChats(options(fixture));
  assert.equal(chat.title.length, 200);
  assert.match(chat.title, /^Long title x+/);
  assert.equal(chat.cwd, '/test/project with spaces');
});

for (const thread of [{ name: {} }, { preview: [] }, { cwd: {} }, { cwd: '/a\0b' }, { cwd: `/${'x'.repeat(4096)}` }]) {
  test(`SSH discovery rejects malformed metadata ${JSON.stringify(thread).slice(0, 80)}`, async () => {
    const fixture = sshFixture({ thread });
    await assert.rejects(listCodexChats(options(fixture)), /unsupported thread metadata/);
    assert.equal(fixture.acceptedTurns.length, 0);
  });
}

test('SSH discovery rejects malformed IDs before reading any thread', async () => {
  const fixture = sshFixture({ loaded: ['target-thread\nother'] });
  await assert.rejects(listCodexChats(options(fixture)), /control characters/);
  assert.ok(fixture.requests.every(r => r.method !== 'thread/read'));
});

test('SSH refuses an invalid WebSocket handshake before any RPC or turn', async () => {
  const fixture = sshFixture({ handshake: 'invalid' });
  await assert.rejects(sendToCodex(options(fixture)), /handshake/);
  assert.equal(fixture.requests.length, 0);
});

test('SSH rejects option-like or shell-like host aliases before launching a process', async () => {
  const fixture = sshFixture();
  for (const alias of ['-oProxyCommand=touch bad', 'host;touch bad', 'user@host', 'host\nother', '']) {
    await assert.rejects(sendToCodex({ ...options(fixture), sshHostAlias: alias }), /SSH host alias/);
  }
  assert.equal(fixture.launches.length, 0);
});

for (const config of [{ dropTurn: true }, { rpcError: true }, { malformedTurn: true }]) {
  test(`SSH marks post-submit failure uncertain without retry: ${JSON.stringify(config)}`, async () => {
    const fixture = sshFixture(config);
    await assert.rejects(sendToCodex(options(fixture)), e => e.deliveryUnknown === true);
    assert.equal(fixture.requests.filter(r => r.method === 'turn/start').length, 1);
    assert.equal(fixture.launches.length, 1);
  });
}

test('SSH cancellation before connection launches nothing', async () => {
  const fixture = sshFixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(sendToCodex({ ...options(fixture), signal: controller.signal }), e => e.name === 'AbortError');
  assert.equal(fixture.launches.length, 0);
});

test('SSH cancellation after turn transmission is uncertain and is not resent', async () => {
  const controller = new AbortController();
  const fixture = sshFixture({ dropTurn: true, onTurn: () => controller.abort() });
  await assert.rejects(sendToCodex({ ...options(fixture), signal: controller.signal }), e => e.name === 'AbortError' && e.deliveryUnknown === true);
  assert.equal(fixture.requests.filter(r => r.method === 'turn/start').length, 1);
});

test('SSH times out a silent handshake and cleans up its subprocess', async () => {
  const fixture = sshFixture({ silent: true });
  await assert.rejects(sendToCodex({ ...options(fixture), timeoutMs: 30 }), /timeout/);
  assert.ok(fixture.children[0].stdin.destroyed);
  assert.equal(fixture.requests.length, 0);
});
