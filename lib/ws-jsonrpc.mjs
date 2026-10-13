// lib/ws-jsonrpc.mjs
// Minimal WebSocket client framing (RFC 6455) for the Codex app-server control
// socket, which is reached through `codex app-server proxy` on stdio. No I/O here.
import { createHash, randomBytes } from 'node:crypto';

export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function upgradeRequest() {
  const key = randomBytes(16).toString('base64');
  return {
    text: 'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    accept: createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64'),
  };
}

function clientFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) header = Buffer.from([0x80 | opcode, 0x80 | length]);
  else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index++) masked[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

export function encodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > MAX_MESSAGE_BYTES) throw new Error('Codex daemon request exceeds 8 MiB.');
  return clientFrame(0x1, payload);
}

export const encodePong = payload => clientFrame(0xa, payload);
export const encodeClose = () => clientFrame(0x8, Buffer.alloc(0));

export class FrameDecoder {
  #buffer = Buffer.alloc(0);
  #upgraded;
  #parts = [];
  #partBytes = 0;

  #accept;

  constructor({ upgraded = false, accept = null } = {}) { this.#upgraded = upgraded; this.#accept = accept; }

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const events = [];
    if (!this.#upgraded) {
      const end = this.#buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (this.#buffer.length > 16384) throw new Error('Codex daemon upgrade response is too large.');
        return events;
      }
      const head = this.#buffer.subarray(0, end).toString('latin1');
      if (!/^HTTP\/1\.1 101\b/.test(head)) throw new Error('Codex daemon refused the WebSocket upgrade.');
      if (this.#accept !== null) {
        const received = /^sec-websocket-accept:\s*(.+)$/im.exec(head)?.[1]?.trim();
        if (received !== this.#accept) throw new Error('Codex daemon returned an invalid WebSocket accept key.');
      }
      this.#buffer = this.#buffer.subarray(end + 4);
      this.#upgraded = true;
      events.push({ type: 'open' });
    }
    for (;;) {
      if (this.#buffer.length < 2) return events;
      const first = this.#buffer[0];
      const second = this.#buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return events;
        length = this.#buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return events;
        const wide = this.#buffer.readBigUInt64BE(2);
        if (wide > BigInt(MAX_MESSAGE_BYTES)) throw new Error('Codex daemon frame exceeds 8 MiB.');
        length = Number(wide); offset = 10;
      }
      if (length > MAX_MESSAGE_BYTES) throw new Error('Codex daemon frame exceeds 8 MiB.');
      const maskLength = masked ? 4 : 0;
      if (this.#buffer.length < offset + maskLength + length) return events;
      const payload = Buffer.from(this.#buffer.subarray(offset + maskLength, offset + maskLength + length));
      if (masked) {
        const mask = this.#buffer.subarray(offset, offset + 4);
        for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
      }
      this.#buffer = this.#buffer.subarray(offset + maskLength + length);
      if (opcode >= 0x8) {
        if (!fin || length > 125) throw new Error('Codex daemon sent an invalid control frame.');
        if (opcode === 0x8) events.push({ type: 'close' });
        else if (opcode === 0x9) events.push({ type: 'ping', payload });
        else if (opcode !== 0xa) throw new Error('Codex daemon sent an unsupported frame type.');
        continue;
      }
      if (opcode === 0x2) throw new Error('Codex daemon sent an unsupported binary frame.');
      if (opcode === 0x1 || opcode === 0x0) {
        if (opcode === 0x0 && this.#parts.length === 0) throw new Error('Codex daemon sent an unexpected continuation frame.');
        if (opcode === 0x1) { this.#parts = []; this.#partBytes = 0; }
        this.#parts.push(payload);
        this.#partBytes += payload.length;
        if (this.#partBytes > MAX_MESSAGE_BYTES) throw new Error('Codex daemon message exceeds 8 MiB.');
        if (fin) {
          events.push({ type: 'text', text: Buffer.concat(this.#parts).toString('utf8') });
          this.#parts = []; this.#partBytes = 0;
        }
      }
    }
  }
}
