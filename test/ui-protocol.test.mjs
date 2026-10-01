import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runMcpServer, TOOLS } from '../scripts/mcp.mjs';

function peer(t, executor) {
  const input = new PassThrough(), output = new PassThrough();
  const pending = new Map();
  let nextId = 1, text = '';
  output.setEncoding('utf8');
  output.on('data', chunk => {
    text += chunk;
    for (;;) {
      const end = text.indexOf('\n');
      if (end < 0) return;
      const response = JSON.parse(text.slice(0, end));
      text = text.slice(end + 1);
      const entry = pending.get(response.id);
      if (entry) { clearTimeout(entry.timer); pending.delete(response.id); entry.resolve(response); }
    }
  });
  const done = runMcpServer({ input, output, executor, env: {} });
  t.after(async () => { input.end(); await done; });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`No ${method} response`)), 3000);
    pending.set(id, { resolve, timer });
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { rpc, notify(method) { input.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); } };
}

async function initialize(client) {
  const response = await client.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'ui-contract-test', version: '1' } });
  assert.deepEqual(response.result.capabilities.resources, {});
  client.notify('notifications/initialized');
}

test('MCP Apps resource is self-contained and only the registered UI URI can be read', async t => {
  let calls = 0;
  const client = peer(t, async () => { calls++; });
  assert.equal((await client.rpc('resources/list', {})).error.code, -32000);
  await initialize(client);
  const listing = await client.rpc('resources/list', {});
  assert.equal(listing.result.resources.length, 1);
  const descriptor = listing.result.resources[0];
  assert.equal(descriptor.mimeType, 'text/html;profile=mcp-app');
  const resource = await client.rpc('resources/read', { uri: descriptor.uri });
  const content = resource.result.contents[0];
  assert.equal(content.uri, descriptor.uri);
  assert.equal(content.mimeType, descriptor.mimeType);
  assert.match(content.text, /<!doctype html>/i);
  assert.match(content.text, /ui\/initialize/);
  assert.doesNotMatch(content.text, /<script[^>]+src=["']https?:|<link[^>]+href=["']https?:/i);
  assert.deepEqual(content._meta.ui.csp.connectDomains, []);
  assert.equal((await client.rpc('resources/read', { uri: '../.mcp.json' })).error.code, -32602);
  assert.equal(calls, 0, 'Reading UI assets must not invoke a send or a service tool.');
});

test('UI helper tools preserve trusted host metadata and reject widget-supplied source IDs', async t => {
  const calls = [];
  const client = peer(t, async (name, args, context) => {
    calls.push({ name, args, metadata: context.metadata });
    assert.ok(context.signal instanceof AbortSignal);
    return { session_id: args.session_id, messages: [], next_cursor: null, has_more: false, warnings: [] };
  });
  await initialize(client);
  const metadata = { thread_id: 'actual-owner', threadId: 'actual-owner' };
  const target = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const response = await client.rpc('tools/call', { name: 'bridge_ui_history',
    arguments: { session_id: target }, _meta: metadata });
  assert.deepEqual(response.result.structuredContent.messages, []);
  assert.deepEqual(calls[0].metadata, metadata);
  for (const field of ['owner_thread_id', 'thread_id', 'threadId', 'manual']) {
    const invalid = await client.rpc('tools/call', { name: 'bridge_ui_send', _meta: metadata,
      arguments: { session_id: target, message_id: 'one', message: 'user text', [field]: 'spoofed' } });
    assert.equal(invalid.result.isError, true);
  }
  assert.equal(calls.length, 1);
  for (const name of ['bridge_ui_send', 'bridge_ui_retry_notice']) {
    const tool = TOOLS.find(item => item.name === name);
    assert.deepEqual(tool._meta.ui.visibility, ['app']);
    assert.equal(tool.annotations.destructiveHint, true);
    assert.equal(tool.annotations.readOnlyHint, false);
  }
});
