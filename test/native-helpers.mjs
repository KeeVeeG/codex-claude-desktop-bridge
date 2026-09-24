import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testRoot = fileURLToPath(new URL('../work/desktop-bridge-tests/', import.meta.url));

export async function nativeFixture(t) {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(path.join(testRoot, 'case-'));
  const stateDir = path.join(root, 'state');
  const cwd = path.join(root, 'project with spaces');
  await mkdir(cwd, { recursive: true });
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(testRoot));
    assert.ok(path.basename(root).startsWith('case-'));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, stateDir, cwd };
}

export function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

export async function mockPipe(t, { framed = false, onMessage, onConnection } = {}) {
  const pipePath = process.platform === 'win32'
    ? `\\\\.\\pipe\\codex-claude-bridge-test-${randomUUID()}`
    : `/tmp/codex-claude-test-${randomUUID()}.sock`;
  const connections = [];
  const messages = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    const index = connections.length;
    connections.push(socket);
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    if (onConnection) onConnection(socket, index);
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        let line;
        if (framed) {
          if (pending.length < 4) return;
          const length = pending.readUInt32LE(0);
          if (pending.length < 4 + length) return;
          line = pending.subarray(4, 4 + length).toString('utf8');
          pending = pending.subarray(4 + length);
        } else {
          const newline = pending.indexOf(10);
          if (newline < 0) return;
          line = pending.subarray(0, newline).toString('utf8');
          pending = pending.subarray(newline + 1);
        }
        const message = JSON.parse(line);
        messages.push({ connection: index, message });
        if (onMessage) onMessage(message, socket, index);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, resolve);
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    if (!server.listening) return;
    await new Promise(resolve => server.close(resolve));
  };
  t.after(close);
  return { pipePath, server, connections, messages, close };
}

export const messageTool = {
  name: 'send_message_to_thread', namespace: 'codex_app',
  inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, prompt: { type: 'string' } } },
};
