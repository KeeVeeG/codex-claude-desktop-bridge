import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getClaudeEnvironment, sendToClaude } from '../lib/claude-desktop.mjs';
import { MAX_CODEX_CHAT_LIMIT, listCodexTools, listCodexChats, sendToCodex } from '../lib/codex-desktop.mjs';
import { encodeFrame, mockPipe, messageTool } from './native-helpers.mjs';

function answer(socket, id, result) {
  socket.write(encodeFrame({ jsonrpc: '2.0', id, result }));
}

test('Claude adapter writes auth first, preserves Unicode, and does not claim model delivery', async t => {
  const pipe = await mockPipe(t);
  const token = `test-secret-${randomUUID()}`;
  const message = 'Привет, Claude.\nReview "src/file with spaces.js".';
  const environment = getClaudeEnvironment({ CLAUDE_CODE_MESSAGING_SOCKET: pipe.pipePath, CLAUDE_CODE_MESSAGING_TOKEN: token });
  const response = await sendToClaude({ ...environment, message });
  assert.deepEqual(response, { status: 'written', messageId: response.messageId, acknowledged: false });
  assert.equal(pipe.connections.length, 1);
  assert.equal(pipe.messages.length, 2);
  assert.deepEqual(pipe.messages[0].message, { type: 'auth', token });
  const envelope = pipe.messages[1].message;
  assert.equal(envelope.type, 'user');
  assert.equal(envelope.uuid, response.messageId);
  assert.equal(envelope.priority, 'next');
  assert.equal(envelope.message.role, 'user');
  assert.equal(envelope.message.content, message);
  assert.doesNotMatch(JSON.stringify(response), new RegExp(token));
});

test('Claude adapter refuses absent credentials, malformed targets, and oversized input', async t => {
  const pipe = await mockPipe(t);
  assert.throws(() => getClaudeEnvironment({}), /socket/);
  assert.throws(() => getClaudeEnvironment({ CLAUDE_CODE_MESSAGING_SOCKET: pipe.pipePath }), /token/);
  assert.throws(() => getClaudeEnvironment({ CLAUDE_CODE_MESSAGING_SOCKET: 'https://remote.example', CLAUDE_CODE_MESSAGING_TOKEN: 'secret' }), /local named pipe|absolute Unix/);
  await assert.rejects(sendToClaude({ socketPath: pipe.pipePath, token: 'secret\n', message: 'x' }), /token/);
  await assert.rejects(sendToClaude({ socketPath: pipe.pipePath, token: 'secret', message: 'x', senderName: 'bad\nsender' }), /one line/);
  await assert.rejects(sendToClaude({ socketPath: pipe.pipePath, token: 'secret', message: 'x'.repeat(1_048_576) }), /transport limit/);
  assert.equal(pipe.connections.length, 0);
});

test('Claude transport failure never leaks the session token', async t => {
  const pipe = await mockPipe(t);
  await pipe.close();
  const token = `do-not-print-${randomUUID()}`;
  await assert.rejects(sendToClaude({ socketPath: pipe.pipePath, token, message: 'undeliverable' }), error => {
    assert.doesNotMatch(error.message, new RegExp(token));
    assert.match(error.message, /Cannot write|closed/);
    return true;
  });
});

test('Codex adapter discovers the app tool and addresses only the paired task', async t => {
  const pipe = await mockPipe(t, {
    framed: true,
    onMessage(message, socket) {
      if (message.method === 'tools/list') answer(socket, message.id, { tools: [messageTool] });
      else if (message.method === 'tools/call') answer(socket, message.id, { success: true, contentItems: [{ type: 'inputText', text: 'sent' }] });
      else assert.fail(`Unexpected method: ${message.method}`);
    },
  });
  const message = 'Отчёт Claude.\nAll checks passed.';
  const result = await sendToCodex({ pipePath: pipe.pipePath, threadId: 'paired-task', message, turnId: 'bridge-turn', callId: 'bridge-call' });
  assert.equal(result.success, true);
  assert.equal(pipe.connections.length, 2);
  assert.deepEqual(pipe.messages[0].message.params, { threadStartKind: 'all' });
  assert.deepEqual(pipe.messages[1].message, {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { arguments: { threadId: 'paired-task', prompt: message }, callId: 'bridge-call', namespace: 'codex_app', threadId: 'paired-task', tool: 'send_message_to_thread', turnId: 'bridge-turn' },
  });
});

test('Codex adapter handles split frames and unrelated response IDs', async t => {
  const pipe = await mockPipe(t, {
    framed: true,
    onMessage(message, socket) {
      const unrelated = encodeFrame({ jsonrpc: '2.0', id: 999, result: { ignore: true } });
      const reply = encodeFrame({ jsonrpc: '2.0', id: message.id, result: { tools: [messageTool] } });
      socket.write(unrelated);
      socket.write(reply.subarray(0, 2));
      setImmediate(() => {
        socket.write(reply.subarray(2, 9));
        setImmediate(() => socket.write(reply.subarray(9)));
      });
    },
  });
  assert.deepEqual(await listCodexTools(pipe.pipePath), [messageTool]);
});

test('Codex adapter refuses incompatible tool schema before sending a message', async t => {
  const pipe = await mockPipe(t, {
    framed: true,
    onMessage(message, socket) {
      assert.equal(message.method, 'tools/list');
      answer(socket, message.id, { tools: [{ ...messageTool, inputSchema: { properties: { threadId: {} } } }] });
    },
  });
  await assert.rejects(sendToCodex({ pipePath: pipe.pipePath, threadId: 'paired', message: 'x' }), /unsupported input schema/);
  assert.equal(pipe.connections.length, 1);
});

test('Codex adapter distinguishes definite tool rejection from uncertain transport loss', async t => {
  for (const scenario of ['rejected', 'closed', 'unsupported-result']) {
    await t.test(scenario, async sub => {
      const pipe = await mockPipe(sub, {
        framed: true,
        onMessage(message, socket) {
          if (message.method === 'tools/list') {
            answer(socket, message.id, { tools: [messageTool] });
          } else if (scenario === 'rejected') {
            answer(socket, message.id, { success: false, contentItems: [{ type: 'inputText', text: 'Task is unavailable.' }] });
          } else if (scenario === 'closed') {
            socket.end();
          } else {
            answer(socket, message.id, { unexpected: true });
          }
        },
      });
      await assert.rejects(sendToCodex({ pipePath: pipe.pipePath, threadId: 'paired', message: 'x' }), error => {
        assert.equal(error.deliveryUnknown === true, scenario !== 'rejected');
        return true;
      });
      assert.equal(pipe.messages.filter(entry => entry.message.method === 'tools/call').length, 1, 'must not retry a mutating call');
    });
  }
});

test('Codex adapter rejects invalid response frames as bounded protocol errors', async t => {
  const pipe = await mockPipe(t, {
    framed: true,
    onMessage(_message, socket) {
      const header = Buffer.alloc(4);
      header.writeUInt32LE(9 * 1024 * 1024);
      socket.write(header);
    },
  });
  await assert.rejects(listCodexTools(pipe.pipePath), /invalid frame length/);
});

test('Codex chat listing rejects unsupported limits before transport and preserves native failure details', async t => {
  const nativeDetail = 'Native list_threads rejected this call: the registered task is unavailable.';
  const listTool = { name: 'list_threads', namespace: 'codex_app', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } } };
  const pipe = await mockPipe(t, {
    framed: true,
    onMessage(message, socket) {
      if (message.method === 'tools/list') answer(socket, message.id, { tools: [listTool] });
      else {
        assert.equal(message.params.tool, 'list_threads');
        assert.ok(message.params.arguments.limit <= 50);
        answer(socket, message.id, { success: false, contentItems: [{ type: 'inputText', text: nativeDetail }] });
      }
    },
  });
  assert.equal(MAX_CODEX_CHAT_LIMIT, 50);
  await assert.rejects(listCodexChats({ pipePath: pipe.pipePath, contextThreadId: 'registered-context', limit: 51 }), /50/);
  assert.equal(pipe.connections.length, 0);
  await assert.rejects(listCodexChats({ pipePath: pipe.pipePath, contextThreadId: 'registered-context', limit: 30 }), error => {
    assert.ok(error.message.includes(nativeDetail));
    assert.notEqual(error.deliveryUnknown, true, 'read-only listing failures are not uncertain message delivery');
    return true;
  });
});

test('Codex chat listing bounds native diagnostic text instead of returning an unbounded error', async t => {
  const detail = `NATIVE_LIST_FAILURE: ${'x'.repeat(5000)} OMITTED_DIAGNOSTIC_TAIL`;
  const pipe = await mockPipe(t, {
    framed: true,
    onMessage(message, socket) {
      if (message.method === 'tools/list') answer(socket, message.id, { tools: [{ name: 'list_threads', namespace: 'codex_app' }] });
      else answer(socket, message.id, { success: false, contentItems: [{ type: 'inputText', text: detail }] });
    },
  });
  await assert.rejects(listCodexChats({ pipePath: pipe.pipePath, contextThreadId: 'registered-context' }), error => {
    assert.match(error.message, /NATIVE_LIST_FAILURE/);
    assert.doesNotMatch(error.message, /OMITTED_DIAGNOSTIC_TAIL/);
    assert.ok(error.message.length <= 2100, 'native detail is bounded to 2000 characters plus a short error prefix');
    return true;
  });
});
