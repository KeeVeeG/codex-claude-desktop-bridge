// test/ws-jsonrpc.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { FrameDecoder, MAX_MESSAGE_BYTES, encodeClose, encodePong, encodeText, upgradeRequest } from '../lib/ws-jsonrpc.mjs';

const UPGRADED = 'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n';

function serverFrame(opcode, payload, { fin = true } = {}) {
  const body = Buffer.from(payload);
  const header = body.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, body.length])
    : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 126]), Buffer.from([body.length >> 8, body.length & 255])]);
  return Buffer.concat([header, body]);
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const acceptFor = key => createHash('sha1').update(key + GUID).digest('base64');

test('upgrade request is a WebSocket upgrade with a fresh key and the matching accept value each time', () => {
  const first = upgradeRequest();
  assert.match(first.text, /^GET \/ HTTP\/1\.1\r\n/);
  assert.match(first.text, /Upgrade: websocket\r\n/);
  assert.match(first.text, /Sec-WebSocket-Version: 13\r\n\r\n$/);
  const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(first.text)[1];
  assert.equal(first.accept, acceptFor(key));
  assert.notEqual(first.text, upgradeRequest().text);
});

test('the decoder validates the accept key when one is expected', () => {
  const { accept } = upgradeRequest();
  const good = `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nsec-websocket-accept: ${accept}\r\n\r\n`;
  assert.deepEqual(new FrameDecoder({ accept }).push(Buffer.from(good)), [{ type: 'open' }]);
  assert.throws(() => new FrameDecoder({ accept }).push(Buffer.from(UPGRADED)), /invalid WebSocket accept key/);
  const wrong = `HTTP/1.1 101 Switching Protocols\r\nsec-websocket-accept: nope\r\n\r\n`;
  assert.throws(() => new FrameDecoder({ accept }).push(Buffer.from(wrong)), /invalid WebSocket accept key/);
});

test('masked client frames round-trip through the decoder at every length class', () => {
  for (const size of [5, 125, 126, 300, 70000]) {
    const text = 'x'.repeat(size);
    const decoder = new FrameDecoder({ upgraded: true });
    assert.deepEqual(decoder.push(encodeText(text)), [{ type: 'text', text }], `size ${size}`);
  }
});

test('decoder waits for the upgrade, reports open, and accepts bytes split across chunks', () => {
  const decoder = new FrameDecoder();
  const wire = Buffer.concat([Buffer.from(UPGRADED), serverFrame(1, '{"id":1}')]);
  const events = [];
  for (let offset = 0; offset < wire.length; offset += 7) events.push(...decoder.push(wire.subarray(offset, offset + 7)));
  assert.deepEqual(events, [{ type: 'open' }, { type: 'text', text: '{"id":1}' }]);
});

test('decoder rejects a refused upgrade', () => {
  assert.throws(() => new FrameDecoder().push(Buffer.from('HTTP/1.1 403 Forbidden\r\n\r\n')), /refused the WebSocket upgrade/);
});

test('fragmented text messages are reassembled and ping and close are reported', () => {
  const decoder = new FrameDecoder({ upgraded: true });
  const events = decoder.push(Buffer.concat([
    serverFrame(1, 'hel', { fin: false }), serverFrame(0, 'lo'), serverFrame(9, 'p'), serverFrame(8, ''),
  ]));
  assert.deepEqual(events, [{ type: 'text', text: 'hello' }, { type: 'ping', payload: Buffer.from('p') }, { type: 'close' }]);
});

test('oversize frames and messages are rejected', () => {
  assert.throws(() => encodeText('x'.repeat(MAX_MESSAGE_BYTES + 1)), /exceeds 8 MiB/);
  const header = Buffer.alloc(10);
  header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(MAX_MESSAGE_BYTES) + 1n, 2);
  assert.throws(() => new FrameDecoder({ upgraded: true }).push(header), /exceeds 8 MiB/);
});

test('invalid frame sequences are rejected: binary, stray continuation, fragmented or oversize control frames', () => {
  const fresh = () => new FrameDecoder({ upgraded: true });
  assert.throws(() => fresh().push(serverFrame(2, 'bin')), /unsupported binary frame/);
  assert.throws(() => fresh().push(serverFrame(0, 'orphan')), /unexpected continuation frame/);
  assert.throws(() => fresh().push(serverFrame(9, 'p', { fin: false })), /invalid control frame/);
  assert.throws(() => fresh().push(Buffer.concat([Buffer.from([0x89, 126, 0, 126]), Buffer.alloc(126)])), /invalid control frame/);
});

test('pong and close frames are masked control frames', () => {
  assert.equal(encodePong(Buffer.from('p'))[0], 0x8a);
  assert.equal(encodeClose()[0], 0x88);
  assert.equal(encodeClose()[1] & 0x80, 0x80);
});
