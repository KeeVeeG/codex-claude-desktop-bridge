// macOS uses Codex's public app-server on the Desktop-configured SSH host.
// This never opens the protected Desktop app-tools socket or starts a server.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { normalizeCodexThreadId } from './codex-daemon.mjs';

const runtimeVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const MAX_MESSAGE = 8 * 1024 * 1024;
const MAX_HEADER = 65536;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateSshHostAlias(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new Error('SSH host alias must be a concrete ~/.ssh/config alias, without options, user names, or shell characters.');
  }
  return value;
}

function cancellation() {
  return Object.assign(new Error('Bridge request was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function check(signal) { if (signal?.aborted) throw cancellation(); }

const UNCERTAIN_NOTICE = 'Delivery is uncertain; inspect the selected chat before retrying.';

function markUnknown(error) {
  error.deliveryUnknown = true;
  // MCP exposes error.message, so the text must preserve the delivery state too.
  if (!error.message.includes(UNCERTAIN_NOTICE)) error.message += ` ${UNCERTAIN_NOTICE}`;
  return error;
}

function text(value, name, limit = 65536) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit) {
    throw new Error(`${name} must be nonempty bounded text.`);
  }
  return value;
}

function selectedThreadId(value) {
  const id = text(value, 'Selected Codex task ID', 512);
  if (/[\r\n\0]/.test(id)) throw new Error('Selected Codex task ID contains invalid control characters.');
  return normalizeCodexThreadId(id);
}

function clientFrame(payload, opcode = 1) {
  if (payload.length > MAX_MESSAGE) throw new Error('Codex SSH request exceeds the transport limit.');
  const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10);
  header[0] = 128 | opcode;
  header[1] = 128 | (payload.length < 126 ? payload.length : payload.length < 65536 ? 126 : 127);
  if (header.length === 4) header.writeUInt16BE(payload.length, 2);
  if (header.length === 10) header.writeBigUInt64BE(BigInt(payload.length), 2);
  const mask = randomBytes(4), data = Buffer.from(payload);
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, data]);
}

class SshRpc {
  constructor({ sshHostAlias, signal, spawnImpl = spawn, timeoutMs = 30000 }) {
    check(signal);
    const alias = validateSshHostAlias(sshHostAlias);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid Codex SSH timeout.');
    this.pending = Buffer.alloc(0); this.calls = new Map(); this.id = 0;
    this.fragments = []; this.fragmentBytes = 0; this.fragmenting = false;
    this.closed = false; this.upgraded = false; this.signal = signal;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Attach rejection handling immediately, including a synchronous spawn failure.
    this.ready.catch(() => {});
    this.nonce = randomBytes(16).toString('base64');
    this.accept = createHash('sha1').update(this.nonce + GUID).digest('base64');
    this.abort = () => this.fail(cancellation());
    signal?.addEventListener('abort', this.abort, { once: true });
    this.timer = setTimeout(() => this.fail(new Error('Codex SSH request timeout. Inspect delivery before retrying.')), timeoutMs);
    try {
      this.child = spawnImpl('/usr/bin/ssh', ['-T', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes',
        '-oConnectTimeout=5', '--', alias, 'exec "$SHELL" -lc \'exec codex app-server proxy\''],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      if (!this.child.stdin || !this.child.stdout || !this.child.stderr) throw new Error('SSH proxy streams are unavailable.');
      this.child.on('error', () => this.fail(new Error('Could not start the configured SSH proxy.')));
      this.child.on('close', () => this.fail(new Error('The configured SSH proxy closed before replying.')));
      this.child.stdin.on('error', () => this.fail(new Error('Could not write to the configured SSH proxy.')));
      this.child.stdout.on('error', () => this.fail(new Error('Could not read from the configured SSH proxy.')));
      this.child.stderr.on('error', () => this.fail(new Error('Could not read from the configured SSH proxy.')));
      this.child.stdout.on('end', () => this.fail(new Error('The configured SSH proxy closed before replying.')));
      this.child.stdout.on('data', chunk => { try { this.receive(chunk); } catch (error) { this.fail(error); } });
      // Drain stderr without exposing login banners, diagnostics, or credentials.
      this.child.stderr.resume();
      check(signal);
      this.child.stdin.write(`GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${this.nonce}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    } catch (error) { this.fail(error); }
  }

  receive(chunk) {
    if (this.closed) return;
    if (this.pending.length + chunk.length > MAX_MESSAGE + MAX_HEADER) throw new Error('Codex SSH response exceeds the transport limit.');
    this.pending = Buffer.concat([this.pending, chunk]);
    if (!this.upgraded) {
      const end = this.pending.indexOf('\r\n\r\n');
      if (end < 0) { if (this.pending.length > MAX_HEADER) throw new Error('Codex SSH handshake exceeds the transport limit.'); return; }
      if (end > MAX_HEADER) throw new Error('Codex SSH handshake exceeds the transport limit.');
      const lines = this.pending.subarray(0, end).toString('ascii').split('\r\n');
      const headers = new Map();
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon < 1) throw new Error('Invalid Codex SSH WebSocket handshake.');
        const key = line.slice(0, colon).toLowerCase();
        if (headers.has(key)) throw new Error('Duplicate Codex SSH handshake header.');
        headers.set(key, line.slice(colon + 1).trim());
      }
      if (!/^HTTP\/1\.1 101(?: |$)/.test(lines[0]) || headers.get('sec-websocket-accept') !== this.accept ||
          headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
          !headers.get('connection')?.toLowerCase().split(/\s*,\s*/).includes('upgrade') ||
          headers.has('sec-websocket-extensions') || headers.has('sec-websocket-protocol')) {
        throw new Error('Invalid Codex SSH WebSocket handshake.');
      }
      this.pending = this.pending.subarray(end + 4); this.upgraded = true; this.resolveReady();
    }
    while (this.pending.length >= 2 && !this.closed) {
      const first = this.pending[0], second = this.pending[1], opcode = first & 15, fin = !!(first & 128);
      if ((first & 112) || (second & 128)) throw new Error('Invalid Codex SSH WebSocket frame.');
      let size = second & 127, header = 2;
      if (size === 126) { if (this.pending.length < 4) return; size = this.pending.readUInt16BE(2); header = 4; }
      if (size === 127) {
        if (this.pending.length < 10) return;
        const length = this.pending.readBigUInt64BE(2);
        if (length > BigInt(MAX_MESSAGE)) throw new Error('Codex SSH response exceeds the transport limit.');
        size = Number(length); header = 10;
      }
      if (size > MAX_MESSAGE || (opcode >= 8 && (!fin || size > 125))) throw new Error('Invalid Codex SSH WebSocket frame length.');
      if (this.pending.length < header + size) return;
      const payload = this.pending.subarray(header, header + size);
      this.pending = this.pending.subarray(header + size);
      if (opcode === 8) throw new Error('Codex SSH WebSocket closed before replying.');
      if (opcode === 9) { this.child.stdin.write(clientFrame(payload, 10)); continue; }
      if (opcode === 10) continue;
      if (opcode === 1) {
        if (this.fragmenting) throw new Error('Invalid Codex SSH fragmented message.');
        this.fragments = []; this.fragmentBytes = 0; this.fragmenting = true;
      } else if (opcode !== 0 || !this.fragmenting) throw new Error('Unsupported Codex SSH WebSocket frame.');
      this.fragmentBytes += size;
      if (this.fragmentBytes > MAX_MESSAGE) throw new Error('Codex SSH fragmented response exceeds the transport limit.');
      this.fragments.push(payload);
      if (fin) {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(this.fragments)));
        this.fragments = []; this.fragmentBytes = 0; this.fragmenting = false;
        if (!object(value)) throw new Error('Invalid Codex SSH JSON-RPC response.');
        // Each peer owns its request-ID namespace. A server request may have the
        // same ID as our pending call, but can never acknowledge that call.
        if (Object.hasOwn(value, 'method')) continue;
        const call = this.calls.get(value.id);
        if (!call) continue; // Notifications and unrelated responses are not approvals.
        this.calls.delete(value.id);
        if (value.error || !Object.hasOwn(value, 'result')) {
          const error = new Error(`Codex SSH request rejected: ${String(value.error?.message || 'unsupported response').slice(0, 300)}`);
          if (call.mutating && call.written) markUnknown(error);
          call.reject(error);
        } else call.resolve(value.result);
      }
    }
  }

  request(method, params, mutating = false) {
    check(this.signal);
    if (this.closed) return Promise.reject(new Error('Codex SSH connection is closed.'));
    const id = ++this.id;
    const bytes = clientFrame(Buffer.from(JSON.stringify({ id, method, params })));
    return new Promise((resolve, reject) => {
      const call = { resolve, reject, mutating, written: false };
      this.calls.set(id, call);
      try { check(this.signal); call.written = true; this.child.stdin.write(bytes); }
      catch (error) { this.fail(error); }
    });
  }

  notify(method) { check(this.signal); this.child.stdin.write(clientFrame(Buffer.from(JSON.stringify({ method, params: {} })))); }

  fail(error) {
    if (this.closed) return;
    this.rejectReady(error);
    for (const call of this.calls.values()) {
      const failure = Object.assign(new Error(error.message), { name: error.name, code: error.code });
      if (call.mutating && call.written) markUnknown(failure);
      call.reject(failure);
    }
    this.calls.clear(); this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); this.signal?.removeEventListener('abort', this.abort);
    this.child?.stdin?.destroy(); this.child?.kill();
  }
}

async function connected(options) {
  const rpc = new SshRpc(options);
  try {
    await rpc.ready;
    await rpc.request('initialize', { clientInfo: { name: 'codex_claude_desktop_bridge',
      title: 'Codex–Claude Desktop Bridge', version: runtimeVersion } });
    rpc.notify('initialized'); return rpc;
  } catch (error) { rpc.close(); throw error; }
}

function target(result, threadId) {
  if (!object(result?.thread) || normalizeCodexThreadId(result.thread.id) !== threadId ||
      !object(result.thread.status) || !['idle', 'active', 'notLoaded', 'systemError'].includes(result.thread.status.type)) {
    throw new Error('Codex SSH returned an unsupported target thread.');
  }
  return result.thread;
}

function summary(thread, threadId, sshHostAlias) {
  if ((thread.name != null && typeof thread.name !== 'string') ||
      (thread.preview != null && typeof thread.preview !== 'string') ||
      (thread.cwd != null && (typeof thread.cwd !== 'string' || Buffer.byteLength(thread.cwd) > 4096 || /[\r\n\0]/.test(thread.cwd)))) {
    throw new Error('Codex SSH returned unsupported thread metadata.');
  }
  const title = [thread.name, thread.preview, threadId]
    .find(value => typeof value === 'string' && value.trim());
  return { thread_id: threadId, title: title.replace(/\s+/g, ' ').trim().slice(0, 200),
    status: thread.status.type, cwd: thread.cwd ?? '', host_id: `ssh:${sshHostAlias}` };
}

export async function listSshCodexChats(options = {}) {
  const limit = options.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be between 1 and 50');
  const rpc = await connected(options);
  try {
    const loaded = await rpc.request('thread/loaded/list', {});
    if (!Array.isArray(loaded?.data)) throw new Error('Unsupported Codex SSH loaded-thread catalog.');
    const ids = [...new Set(loaded.data.map(selectedThreadId))];
    const chats = [];
    for (const id of ids.slice(0, limit)) {
      const thread = target(await rpc.request('thread/read', { threadId: id, includeTurns: false }), id);
      if (thread.status.type === 'notLoaded') continue;
      chats.push(summary(thread, id, options.sshHostAlias));
    }
    return chats;
  } finally { rpc.close(); }
}

export async function sendSshCodex(options = {}) {
  const threadId = selectedThreadId(options.threadId);
  // The service/store already bounds user text to 64 KiB. The transport also
  // carries its verified sender notice, so enforce the frame bound here.
  const message = text(options.message, 'Message', MAX_MESSAGE);
  const rpc = await connected(options);
  try {
    const read = await rpc.request('thread/read', { threadId, includeTurns: false });
    if (target(read, threadId).status.type !== 'idle') throw new Error('Open the target on the configured SSH host in Codex Desktop; it must be loaded and idle before sending.');
    // Input to an already-loaded thread needs no subscription. Resuming here
    // could load a conversation closed after the read and hydrate its history.
    const result = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: message }] }, true);
    if (!object(result?.turn) || typeof result.turn.id !== 'string' || !result.turn.id) {
      throw markUnknown(new Error('Codex SSH returned an unsupported send receipt.'));
    }
    return { transport: 'ssh-app-server', turnId: result.turn.id, threadId };
  } finally { rpc.close(); }
}
