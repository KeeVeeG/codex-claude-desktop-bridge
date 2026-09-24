// Codex Desktop's bundled app-tools pipe is a local, version-sensitive interface.
// This adapter intentionally does not start a separate Codex agent or CLI session.
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const maxFrameBytes = 8 * 1024 * 1024;
export const MAX_CODEX_CHAT_LIMIT = 50;

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value;
}

function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > maxFrameBytes) throw new Error('Codex Desktop request exceeds 8 MiB.');
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function request(pipePath, method, params, { timeoutMs = 30000, mutating = false } = {}) {
  requiredText(pipePath, 'Codex Desktop pipe path');
  const id = 1;
  const frame = encodeFrame({ id, jsonrpc: '2.0', method, params });
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let pending = Buffer.alloc(0);
    let finished = false;
    let submitted = false;
    const timer = setTimeout(() => fail(new Error('Codex Desktop did not answer before the local request timeout.')), timeoutMs);

    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }

    function fail(error) {
      if (mutating && submitted) {
        error.deliveryUnknown = true;
        error.message += ' Delivery is uncertain; inspect the selected task before retrying.';
      }
      finish(error);
    }

    socket.on('connect', () => {
      submitted = true;
      socket.write(frame);
    });
    socket.on('error', error => {
      const code = error.code ? ` (${error.code})` : '';
      fail(new Error(`Could not communicate with Codex Desktop${code}.`));
    });
    socket.on('close', () => {
      if (!finished) fail(new Error('Codex Desktop closed its local connection before replying.'));
    });
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (!finished && pending.length >= 4) {
        const length = pending.readUInt32LE(0);
        if (length === 0 || length > maxFrameBytes) {
          fail(new Error('Codex Desktop returned an invalid frame length.'));
          return;
        }
        if (pending.length < length + 4) return;
        const payload = pending.subarray(4, length + 4);
        pending = pending.subarray(length + 4);
        let response;
        try {
          response = JSON.parse(payload.toString('utf8'));
        } catch {
          fail(new Error('Codex Desktop returned an invalid JSON response.'));
          return;
        }
        if (!response || typeof response !== 'object' || Array.isArray(response)) {
          fail(new Error('Codex Desktop returned an invalid response.'));
          return;
        }
        if (String(response.id) !== String(id)) continue;
        if (response.error) {
          const error = new Error(`Codex Desktop: ${String(response.error.message ?? 'request rejected')}`);
          error.code = response.error.code;
          finish(error);
        } else if (Object.hasOwn(response, 'result')) {
          finish(null, response.result);
        } else {
          fail(new Error('Codex Desktop response has neither a result nor an error.'));
        }
      }
    });
  });
}

export async function listCodexTools(pipePath) {
  const result = await request(pipePath, 'tools/list', { threadStartKind: 'all' }, { timeoutMs: 10000 });
  if (!result || !Array.isArray(result.tools)) throw new Error('Codex Desktop returned no app-tools catalog.');
  return result.tools;
}

/** Discover actual local Codex chats through the running Desktop app. */
export async function listCodexChats({ pipePath, contextThreadId, limit = 30 }) {
  requiredText(contextThreadId, 'Registered Codex context task id');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CODEX_CHAT_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_CODEX_CHAT_LIMIT}`);
  }
  const catalog = await listCodexTools(pipePath);
  const tool = catalog.find(item => item.name === 'list_threads');
  if (!tool?.namespace) throw new Error('This Codex Desktop version does not expose chat discovery');
  const result = await request(pipePath, 'tools/call', {
    arguments: { limit }, namespace: tool.namespace, tool: tool.name,
    threadId: contextThreadId, callId: `bridge-list-${randomUUID()}`, turnId: `bridge-list-${randomUUID()}`,
  }, { timeoutMs: 10000 });
  if (!result || typeof result.success !== 'boolean' || !Array.isArray(result.contentItems)) {
    throw new Error('Codex Desktop returned an unsupported chat discovery result');
  }
  if (!result.success) {
    const detail = result.contentItems
      .filter(item => item.type === 'inputText' && typeof item.text === 'string')
      .map(item => item.text).join('\n').slice(0, 2000);
    throw new Error(`Codex Desktop could not list chats${detail ? `: ${detail}` : '.'}`);
  }
  let listing;
  for (const item of result.contentItems) {
    if (item.type !== 'inputText' || typeof item.text !== 'string') continue;
    try {
      const parsed = JSON.parse(item.text);
      if (Array.isArray(parsed.threads)) { listing = parsed; break; }
    } catch { /* Other text items are not the structured listing. */ }
  }
  if (!listing) throw new Error('Codex Desktop returned an unsupported chat listing');
  const seen = new Set();
  return [...(listing.pinnedThreads || []), ...listing.threads].filter(item => {
    const id = item.id || item.threadId;
    if (typeof id !== 'string' || !id || seen.has(id) || item.kind !== 'codex' ||
        (item.hostId && item.hostId !== 'local')) return false;
    seen.add(id);
    return true;
  }).map(item => ({ thread_id: item.id || item.threadId, title: item.title,
    status: item.status, cwd: item.cwd, host_id: item.hostId || 'local' }));
}

/**
 * Send a native visible prompt to the exact Codex task selected by the caller.
 * Never retry this function automatically: the Desktop tool has no documented
 * idempotency guarantee. On transport loss deliveryUnknown is set on the error.
 */
export async function sendToCodex({ pipePath, threadId, message, turnId, callId }) {
  requiredText(threadId, 'Selected Codex task id');
  requiredText(message, 'Message');
  const catalog = await listCodexTools(pipePath);
  const tool = catalog.find(item => item.name === 'send_message_to_thread');
  if (!tool || typeof tool.namespace !== 'string' || !tool.namespace) {
    throw new Error('This Codex Desktop version does not expose send_message_to_thread.');
  }
  const schema = tool.inputSchema;
  if (!schema?.properties?.threadId || !schema?.properties?.prompt) {
    throw new Error('The installed Codex Desktop message tool has an unsupported input schema.');
  }
  const result = await request(pipePath, 'tools/call', {
    arguments: { threadId, prompt: message },
    callId: callId ?? `bridge-call-${randomUUID()}`,
    namespace: tool.namespace,
    threadId,
    tool: tool.name,
    turnId: turnId ?? `bridge-turn-${randomUUID()}`,
  }, { timeoutMs: 30000, mutating: true });
  if (!result || typeof result.success !== 'boolean' || !Array.isArray(result.contentItems)) {
    const error = new Error('Codex Desktop returned an unsupported result. Inspect the selected task before retrying.');
    error.deliveryUnknown = true;
    throw error;
  }
  if (!result.success) {
    const text = result.contentItems
      .filter(item => item.type === 'inputText' && typeof item.text === 'string')
      .map(item => item.text).join('\n');
    throw new Error(`Codex Desktop rejected the message${text ? `: ${text.slice(0, 2000)}` : '.'}`);
  }
  return result;
}
