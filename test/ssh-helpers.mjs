import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

function frame(data, opcode = 1, fin = true) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10);
  header[0] = (fin ? 128 : 0) | opcode;
  header[1] = payload.length < 126 ? payload.length : payload.length < 65536 ? 126 : 127;
  if (header.length === 4) header.writeUInt16BE(payload.length, 2);
  if (header.length === 10) header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

// Independent server-side fixture: exercises the actual client handshake,
// masked frames and RPCs while replacing only the external SSH subprocess.
export function sshFixture({ status = 'idle', handshake = 'valid', dropTurn = false,
  rpcError = false, fragmented = false, malformedTurn = false, silent = false,
  loaded = ['target-thread'], onTurn, thread = {}, collidingRequests = false,
  historyBytes = 0, unloadAfterRead = false, statuses = {} } = {}) {
  const requests = [], launches = [], children = [], acceptedTurns = [];
  function spawnImpl(command, args, options) {
    launches.push({ command, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.stdout.end(); child.stdin.destroy(); queueMicrotask(() => child.emit('close', 0, 'SIGTERM')); return true; };
    children.push(child);
    let pending = Buffer.alloc(0), upgraded = false, unloaded = false;
    child.stdin.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (!upgraded) {
        const end = pending.indexOf('\r\n\r\n');
        if (end < 0) return;
        const headers = pending.subarray(0, end).toString();
        assert.match(headers, /^GET \/rpc HTTP\/1\.1/);
        const key = /Sec-WebSocket-Key: ([^\r]+)/i.exec(headers)?.[1];
        assert.ok(key);
        const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        pending = pending.subarray(end + 4); upgraded = true;
        if (silent) return;
        const response = Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${handshake === 'valid' ? accept : 'wrong-accept'}\r\n\r\n`);
        child.stdout.write(response.subarray(0, 9));
        queueMicrotask(() => child.stdout.write(response.subarray(9)));
      }
      for (;;) {
        if (pending.length < 2) return;
        const opcode = pending[0] & 15;
        assert.ok(pending[1] & 128, 'Client frames must be masked');
        let length = pending[1] & 127, offset = 2;
        if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (pending.length < 10) return; length = Number(pending.readBigUInt64BE(2)); offset = 10; }
        if (pending.length < offset + 4 + length) return;
        const mask = pending.subarray(offset, offset + 4), payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        pending = pending.subarray(offset + 4 + length);
        if (opcode !== 1) continue;
        const request = JSON.parse(payload.toString()); requests.push(request);
        if (request.id === undefined) continue;
        let result;
        if (request.method === 'initialize') result = { userAgent: 'codex-test', platformFamily: 'unix', platformOs: 'macos' };
        else if (request.method === 'thread/loaded/list') result = { data: loaded, nextCursor: null };
        else if (request.method === 'thread/read' || request.method === 'thread/resume') {
          result = { thread: {
            id: request.params.threadId, name: 'Selected SSH chat', preview: '', cwd: '/test/project',
            status: { type: statuses[request.params.threadId] ?? status }, turns: [], createdAt: 1, updatedAt: 2, modelProvider: 'openai', ephemeral: false,
            ...thread,
          } };
          if (historyBytes && (request.params.includeTurns || request.method === 'thread/resume')) {
            result.thread.turns = [{ id: 'old-turn', items: [{ text: 'x'.repeat(historyBytes) }] }];
          }
          if (request.method === 'thread/resume') unloaded = false;
          else if (unloadAfterRead) unloaded = true;
        }
        else if (request.method === 'turn/start') {
          onTurn?.(request, child);
          if (!rpcError && !unloaded) acceptedTurns.push(request);
          if (dropTurn) { queueMicrotask(() => child.stdout.end()); return; }
          result = malformedTurn ? {} : { turn: { id: 'accepted-turn', status: 'inProgress', items: [], error: null } };
        } else assert.fail(`Unexpected RPC ${request.method}`);
        const value = request.method === 'turn/start' && unloaded ? { id: request.id, error: { code: -32600, message: 'thread not found' } }
          : request.method === 'turn/start' && rpcError ? { id: request.id, error: { code: -32000, message: 'Request failed' } }
          : { id: request.id, result };
        if (collidingRequests) child.stdout.write(frame(JSON.stringify({ id: request.id,
          method: 'item/commandExecution/requestApproval', params: { threadId: 'unrelated-thread' } })));
        const bytes = Buffer.from(JSON.stringify(value));
        if (fragmented) {
          child.stdout.write(frame(bytes.subarray(0, 7), 1, false));
          child.stdout.write(frame(Buffer.from('ping'), 9));
          child.stdout.write(frame(bytes.subarray(7), 0));
        } else child.stdout.write(frame(bytes));
      }
    });
    return child;
  }
  return { spawnImpl, requests, launches, children, acceptedTurns };
}
