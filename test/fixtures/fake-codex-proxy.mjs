// Stand-in for `codex app-server proxy`: upgrades to WebSocket on stdio and answers
// the JSON-RPC methods the bridge uses, driven by a scenario file.
// Usage: node fake-codex-proxy.mjs <scenario.json>
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { FrameDecoder } from '../../lib/ws-jsonrpc.mjs';

const scenario = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (scenario.unreachable) {
  process.stderr.write('failed to connect to socket (os error 10061)\n');
  process.exit(1);
}
const log = entry => fs.appendFileSync(scenario.logFile, `${JSON.stringify(entry)}\n`);

function serverFrame(text) {
  const body = Buffer.from(text, 'utf8');
  const header = body.length < 126 ? Buffer.from([0x81, body.length])
    : body.length < 65536 ? Buffer.concat([Buffer.from([0x81, 126]), Buffer.from([body.length >> 8, body.length & 255])])
    : (() => { const big = Buffer.alloc(10); big[0] = 0x81; big[1] = 127; big.writeBigUInt64BE(BigInt(body.length), 2); return big; })();
  return Buffer.concat([header, body]);
}
const send = value => process.stdout.write(serverFrame(JSON.stringify(value)));
const threadStatus = thread => thread.status ?? { type: 'idle' };
const publicThread = thread => ({ id: thread.id, originator: thread.originator, name: thread.name ?? '', preview: thread.preview ?? '',
  cwd: thread.cwd ?? 'C:/project', status: threadStatus(thread), updatedAt: 1, source: 'vscode' });

function answer(request) {
  const { id, method, params } = request;
  log({ method, params, ...(method === 'initialize' ? { codexHome: process.env.CODEX_HOME ?? null } : {}) });
  if (method === 'turn/steer') {
    const thread = scenario.threads.find(item => item.id === params?.threadId);
    if (thread?.becomesIdleAfterSteer) thread.status = { type: 'idle' };
  }
  // A server-initiated request that reuses this id must not be mistaken for the response.
  if (scenario.serverRequestBefore === method) send({ id, method: 'item/permissions/requestApproval', params: {} });
  if (scenario.malformed === method) { send({ id }); return; }
  if (scenario.errors?.[method]) { send({ id, error: scenario.errors[method] }); return; }
  if (method === 'initialize') { send({ id, result: { userAgent: 'fake-codex' } }); return; }
  if (method === 'thread/list') {
    const start = Number(params?.cursor ?? 0);
    const size = scenario.pageSize ?? scenario.threads.length;
    const page = scenario.threads.slice(start, start + size);
    const next = start + size < scenario.threads.length ? String(start + size) : null;
    send({ id, result: { data: page.map(publicThread), nextCursor: next } });
    return;
  }
  if (method === 'thread/read') {
    const thread = scenario.threads.find(item => item.id === params?.threadId);
    if (!thread) { send({ id, error: { code: -32600, message: `thread not found: ${params?.threadId}` } }); return; }
    send({ id, result: { thread: { ...publicThread(thread), ...(params.includeTurns ? { turns: thread.turns ?? [] } : {}) } } });
    return;
  }
  if (method === 'turn/start') { send({ id, result: { turn: { id: 'turn-started', status: 'inProgress' } } }); return; }
  if (method === 'turn/steer') { send({ id, result: { turnId: params?.expectedTurnId } }); return; }
  send({ id, error: { code: -32601, message: `unsupported method ${method}` } });
}

const decoder = new FrameDecoder({ upgraded: true });
let handshake = Buffer.alloc(0);
let upgraded = false;
process.stdin.on('data', chunk => {
  let data = chunk;
  if (!upgraded) {
    handshake = Buffer.concat([handshake, chunk]);
    const end = handshake.indexOf('\r\n\r\n');
    if (end < 0) return;
    upgraded = true;
    const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(handshake.subarray(0, end).toString('latin1'))?.[1]?.trim() ?? '';
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    process.stdout.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
    data = handshake.subarray(end + 4);
    if (!data.length) return;
  }
  for (const event of decoder.push(data)) {
    if (event.type !== 'text') continue;
    const request = JSON.parse(event.text);
    if (request.id === undefined) { log({ method: request.method, params: request.params }); continue; }
    if (scenario.dropAfter === request.method) {
      // Simulate a connection lost after the request was written and before any answer.
      log({ method: request.method, params: request.params });
      process.exit(0);
    }
    if (scenario.silent === request.method) { log({ method: request.method, params: request.params }); continue; }
    answer(request);
  }
});
process.stdin.on('end', () => process.exit(0));
