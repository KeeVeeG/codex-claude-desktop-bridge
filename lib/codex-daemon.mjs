// Codex sessions can register with the local Codex app-server daemon. Its
// control socket speaks WebSocket and is only reachable through
// `codex app-server proxy` (the socket's ACL blocks direct Node access).
// This module never starts the daemon, never resumes a thread, and never uses a shell.
import { execFile, spawn } from 'node:child_process';
import { FrameDecoder, encodeClose, encodePong, encodeText, upgradeRequest } from './ws-jsonrpc.mjs';
import { resolveCodexExecutable } from './codex-binary.mjs';

export class DaemonUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'DaemonUnavailableError'; }
}

function cancelled() {
  return Object.assign(new Error('Bridge request was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function checkCancellation(signal) {
  if (signal?.aborted) throw cancelled();
}

const CMD_SHIM_MESSAGE = 'CODEX_CLAUDE_BRIDGE_CODEX_BIN must point to codex.exe, not the codex.cmd shim.';
// Node cannot spawn a .cmd/.bat shim without a shell, and this module never uses one.
const isDirectExecutable = executable => /\.exe$/i.test(executable);

// Accept the usual spellings of "off", so an opt-out is never silently ignored.
const DISABLED = /^(off|0|false|no|disabled?)$/i;
const disabledValue = env => {
  const value = String(env.CODEX_CLAUDE_BRIDGE_DAEMON ?? '').trim();
  return DISABLED.test(value) ? value : null;
};

/** Replace local paths, which can carry user names, before text reaches a model or the ledger. */
export function scrubPaths(text) {
  return String(text)
    // A profile directory can contain spaces, so a path through one is removed through its last segment.
    .replace(/[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\r\n'")]+(?:[\\/][^\s'")]*)?/gi, '<path>')
    .replace(/[A-Za-z]:[\\/][^\s'")]*/g, '<path>')
    .replace(/\\\\[^\s'")]+/g, '<path>');
}

// The injected command (tests) skips the kill switch and the .exe check.
function resolveExecutable({ effective, command }) {
  if (command) return command;
  const disabled = disabledValue(effective);
  if (disabled !== null) {
    throw new DaemonUnavailableError(`Codex terminal support is disabled by CODEX_CLAUDE_BRIDGE_DAEMON=${disabled}.`);
  }
  const executable = resolveCodexExecutable({ env: effective });
  if (!executable) {
    throw new DaemonUnavailableError('The Codex executable was not found. Install the Codex CLI, or set CODEX_CLAUDE_BRIDGE_CODEX_BIN to the path of codex.exe.');
  }
  if (!isDirectExecutable(executable)) throw new DaemonUnavailableError(CMD_SHIM_MESSAGE);
  return executable;
}

export function openDaemon({ env = process.env, command, args, signal, timeoutMs = 10000 } = {}) {
  try { checkCancellation(signal); } catch (error) { return Promise.reject(error); }
  // The effective environment (for example CODEX_HOME) is the supplied one layered over the process's.
  const effective = { ...process.env, ...env };
  let executable;
  try { executable = resolveExecutable({ effective, command }); } catch (error) { return Promise.reject(error); }
  return new Promise((resolveOpen, rejectOpen) => {
    let child;
    try {
      child = spawn(executable, args ?? ['app-server', 'proxy'],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: effective });
    } catch {
      rejectOpen(new DaemonUnavailableError('The Codex executable could not be started.'));
      return;
    }
    const upgrade = upgradeRequest();
    const decoder = new FrameDecoder({ accept: upgrade.accept });
    const waiting = new Map();
    let nextId = 1;
    let opened = false;
    let closed = false;
    let stderr = '';

    const connectTimer = setTimeout(() => fail(new DaemonUnavailableError('The Codex daemon did not answer the connection attempt.')), timeoutMs);

    function fail(error) {
      if (closed) return;
      closed = true;
      clearTimeout(connectTimer);
      signal?.removeEventListener('abort', onAbort);
      child.kill();
      for (const entry of waiting.values()) {
        const copy = Object.assign(new Error(error.message), { name: error.name, code: error.code });
        if (entry.mutating && entry.written) {
          copy.deliveryUnknown = true;
          copy.message += ' Delivery is uncertain; inspect the selected Codex session before retrying.';
        }
        entry.reject(copy);
      }
      waiting.clear();
      if (!opened) rejectOpen(error);
    }

    function onAbort() { fail(cancelled()); }
    signal?.addEventListener('abort', onAbort, { once: true });

    function write(buffer) {
      child.stdin.write(buffer);
    }

    function request(method, params, { mutating = false, signal: requestSignal, timeoutMs: limit = 15000 } = {}) {
      if (closed) return Promise.reject(new DaemonUnavailableError('The Codex daemon connection is closed.'));
      try { checkCancellation(requestSignal); } catch (error) { return Promise.reject(error); }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const entry = { mutating, written: false, resolve: undefined, reject: undefined };
        const timer = setTimeout(() => fail(new Error('Codex daemon did not answer before the local request timeout.')), limit);
        const onRequestAbort = () => fail(cancelled());
        const done = () => { clearTimeout(timer); requestSignal?.removeEventListener('abort', onRequestAbort); };
        entry.resolve = value => { done(); resolve(value); };
        entry.reject = error => { done(); reject(error); };
        requestSignal?.addEventListener('abort', onRequestAbort, { once: true });
        waiting.set(id, entry);
        try {
          write(encodeText(JSON.stringify({ id, method, params })));
          entry.written = true;
        } catch (error) {
          waiting.delete(id);
          entry.reject(error);
        }
      });
    }

    function notify(method, params) {
      write(encodeText(JSON.stringify({ method, params })));
    }

    function handle(text) {
      let message;
      try { message = JSON.parse(text); } catch { return; }
      // Server-initiated requests and notifications carry a method and are never responses.
      if (message === null || typeof message !== 'object' || message.method !== undefined) return;
      if (message.id === undefined || !waiting.has(message.id)) return;
      if (!Object.hasOwn(message, 'result') && !message.error) {
        fail(new Error('Codex daemon returned a malformed response.'));
        return;
      }
      const entry = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) {
        const rpcMessage = String(message.error.message ?? 'request rejected');
        // rpcMessage stays verbatim for classification; only the visible message is scrubbed.
        entry.reject(Object.assign(new Error(`Codex daemon: ${scrubPaths(rpcMessage)}`), { rpcCode: message.error.code, rpcMessage }));
      } else entry.resolve(message.result);
    }

    async function afterUpgrade() {
      try {
        await request('initialize', { clientInfo: { name: 'codex-claude-desktop-bridge', title: 'Codex Claude Desktop Bridge', version: '1' } });
        notify('initialized', {});
        opened = true;
        clearTimeout(connectTimer);
        resolveOpen({
          request,
          close() {
            if (closed) return;
            try { write(encodeClose()); } catch { /* the child is already gone */ }
            // One shutdown path: it settles every pending request with the right
            // delivery classification, clears timers and listeners, and stops the proxy.
            fail(new Error('The Codex daemon connection was closed.'));
          },
        });
      } catch (error) { fail(error); }
    }

    child.on('error', () => fail(new DaemonUnavailableError('The Codex executable could not be started.')));
    child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += chunk; });
    child.stdout.on('error', () => fail(new Error('The Codex daemon connection failed.')));
    child.stderr.on('error', () => fail(new Error('The Codex daemon connection failed.')));
    child.on('close', () => {
      const cleaned = scrubPaths(stderr.trim());
      const hint = cleaned ? ` (${cleaned.slice(0, 200)})` : '';
      fail(opened ? new Error('The Codex daemon connection closed unexpectedly.')
        : new DaemonUnavailableError(`The Codex daemon is not reachable${hint}. The bridge never starts the daemon.`));
    });
    child.stdout.on('data', chunk => {
      let events;
      let invalid = null;
      // Frames decoded before an invalid one in the same chunk are still handled, so a response
      // that arrived intact is not downgraded to an uncertain outcome.
      try { events = decoder.push(chunk); } catch (error) { events = error.events ?? []; invalid = error; }
      for (const event of events) {
        if (event.type === 'open') afterUpgrade();
        else if (event.type === 'text') handle(event.text);
        else if (event.type === 'ping') { try { write(encodePong(event.payload)); } catch { /* closing */ } }
        else if (event.type === 'close') fail(new Error('The Codex daemon closed the connection.'));
      }
      if (invalid) fail(invalid);
    });
    write(Buffer.from(upgrade.text, 'latin1'));
  });
}

// Rejections that prove the daemon did not accept the input, matched on code AND an
// anchored message. Anything else the daemon answers after a write may have started a
// turn, so it is recorded as uncertain and never retried.
const PRE_ACCEPTANCE = [
  { code: -32600, pattern: /^thread not found\b/i },
  { code: -32602, pattern: /^invalid params\b/i },
];

const CODEX_THREAD_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const isCodexThreadUuid = threadId => typeof threadId === 'string' && threadId.length === 36 && CODEX_THREAD_UUID.test(threadId);

/** UUID casing is not part of identity; preserve non-UUID values for callers that validate separately. */
export function normalizeCodexThreadId(threadId) {
  return isCodexThreadUuid(threadId) ? threadId.toLowerCase() : threadId;
}

const summarize = thread => ({
  thread_id: normalizeCodexThreadId(thread.id),
  title: String(thread.name || thread.preview || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  status: thread.status?.type ?? 'unknown',
  cwd: thread.cwd ?? '',
  host_id: 'local',
  // Discovery transport, not the current client: originator records creation only.
  source: 'terminal',
});

export async function listTerminalThreads(connection, { limit = 30, signal, timeoutMs, budgetMs = 5000 } = {}) {
  const found = [];
  let cursor = null;
  const until = Date.now() + budgetMs;
  // Bounded: at most 40 pages of 50 stored threads, and no new page once the time budget is spent,
  // so discovery cannot stall every listing. An exact ID is still resolved by thread/read.
  // The originator is immutable creation metadata; a resumed thread may use any client.
  for (let page = 0; page < 40 && found.length < limit && (page === 0 || Date.now() < until); page++) {
    const result = await connection.request('thread/list', { limit: 50, sortKey: 'updated_at', ...(cursor ? { cursor } : {}) }, { signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    for (const thread of result?.data ?? []) if (typeof thread?.id === 'string' && thread.id) found.push(summarize(thread));
    cursor = result?.nextCursor ?? null;
    if (!cursor) break;
  }
  return found.slice(0, limit);
}

export async function readTerminalThread(connection, threadId, { includeTurns = false, signal, timeoutMs } = {}) {
  threadId = normalizeCodexThreadId(threadId);
  try {
    const result = await connection.request('thread/read', { threadId, includeTurns }, { signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    const thread = result?.thread ?? null;
    if (thread && normalizeCodexThreadId(thread.id) !== threadId) throw new Error('The Codex daemon returned a different thread than the selected task. Refresh the session list before sending.');
    return thread && thread.id !== threadId ? { ...thread, id: threadId } : thread;
  } catch (error) {
    if (error.rpcMessage && /thread not found/i.test(error.rpcMessage)) return null;
    throw error;
  }
}

function markUnknown(error) {
  if (!error.deliveryUnknown) {
    error.deliveryUnknown = true;
    error.message += ' Delivery is uncertain; inspect the selected Codex session before retrying.';
  }
  return error;
}

async function writeInput(connection, method, params, signal) {
  try {
    return await connection.request(method, params, { mutating: true, signal });
  } catch (error) {
    // Transport-level failures (encoding overflow, a closed connection, cancellation before the
    // write) carry no rpc fields; the connection already set deliveryUnknown when, and only when,
    // the request had actually been written.
    if (error.rpcMessage === undefined) throw error;
    if (PRE_ACCEPTANCE.some(item => item.code === error.rpcCode && item.pattern.test(error.rpcMessage))) throw error;
    throw markUnknown(error);
  }
}

// Matched on BOTH the JSON-RPC code and an anchored message, so an unrelated internal error
// that merely mentions a turn can never trigger the fallback. Values recorded by the supervised
// steering probe (2026-10-13): an idle thread answers "no active turn to steer", a wrong turn id
// answers "expected active turn id `X` but found `Y`", both with code -32600.
const STEER_STALE = { code: -32600, pattern: /^(no active turn to steer|expected active turn id)/i };

function activeTurnId(thread) {
  const running = [...(thread?.turns ?? [])].reverse()
    .find(turn => turn.status === 'inProgress' || turn.status?.type === 'inProgress');
  return running?.id ?? null;
}

/** The thread is not attached to the daemon; nothing was written, so another route may be tried. */
export class TerminalNotLoadedError extends Error {
  constructor(message) { super(message); this.name = 'TerminalNotLoadedError'; }
}

export async function sendToTerminalThread(connection, { threadId, text, messageId, signal }) {
  threadId = normalizeCodexThreadId(threadId);
  const thread = await readTerminalThread(connection, threadId, { signal });
  if (!thread) throw new Error('The selected Codex task was not found in the Codex daemon.');
  const status = thread.status?.type;
  if (status === 'notLoaded') {
    throw new TerminalNotLoadedError('The selected Codex session is not loaded in the daemon. Open it in a Codex terminal first.');
  }
  if (status === 'systemError') {
    throw new Error('The selected Codex session is not loaded in the daemon. Open it in a Codex terminal first.');
  }
  const input = [{ type: 'text', text }];
  if (status === 'idle') {
    const result = await writeInput(connection, 'turn/start', { threadId, input, clientUserMessageId: messageId }, signal);
    return { method: 'turn/start', turnId: result?.turn?.id ?? null };
  }
  if (status !== 'active') throw new Error('The selected Codex session is busy. Try again when it is idle.');
  // The running turn is always the newest, so a one-turn page (newest first) is enough and
  // keeps the read far below the inbound cap even for very long sessions.
  let withTurns;
  try {
    const page = await connection.request('thread/turns/list', { threadId, limit: 1 }, { signal });
    withTurns = { turns: page?.data ?? [] };
  } catch (error) {
    if (/exceeds 8 MiB/.test(error.message ?? '')) {
      throw new Error('The selected Codex session is busy and its running turn could not be read because the session history is too large. Try again when it is idle.');
    }
    throw error;
  }
  const expectedTurnId = activeTurnId(withTurns);
  if (!expectedTurnId) throw new Error('The selected Codex session is busy and its running turn could not be identified. Try again when it is idle.');
  try {
    await writeInput(connection, 'turn/steer', { threadId, expectedTurnId, input }, signal);
    return { method: 'turn/steer', turnId: expectedTurnId };
  } catch (error) {
    // Any rejection that is not the narrow "turn is gone" case keeps the normal
    // classification already applied by writeInput (uncertain unless proven pre-acceptance).
    if (error.rpcCode !== STEER_STALE.code || !STEER_STALE.pattern.test(error.rpcMessage ?? '')) throw error;
    // A steer rejected because the turn is gone proves nothing was accepted, so the
    // error is discarded and replaced by fresh errors below. Re-read the thread: only a
    // now-idle thread may take exactly one new turn; a still-busy one is a clean failure.
    const current = await readTerminalThread(connection, threadId, { signal });
    if (current?.status?.type !== 'idle') throw new Error('The selected Codex session changed turns while sending. Try again.');
    const result = await writeInput(connection, 'turn/start', { threadId, input, clientUserMessageId: messageId }, signal);
    return { method: 'turn/start', turnId: result?.turn?.id ?? null };
  }
}

// libuv doubles backslash runs and escapes every quote, so quote-heavy text can double in length;
// twice this limit plus the path and flags stays under the Windows 32767-character command line.
const QUEUE_TEXT_LIMIT = 16000;
const QUEUED = /Queued message (\S+) for thread (\S+?)\.?\s*$/m;

/** `codex queue --thread` also resolves titles; only an exact UUID is safe for bridge delivery. */
export function queueTargetRefusal(threadId) {
  return isCodexThreadUuid(threadId)
    ? null : 'The Codex queue route requires an exact session UUID; titles and aliases are not supported.';
}

/** Why the queue route cannot carry this text, or null. Only the queue route has these limits; the daemon route does not. */
export function queueRefusal(text) {
  // Windows command lines are limited to about 32 K characters.
  if (typeof text === 'string' && text.length > QUEUE_TEXT_LIMIT) {
    return `The message is too long for the Codex queue route (limit ${QUEUE_TEXT_LIMIT} characters). Send a shorter message.`;
  }
  if (typeof text === 'string' && text.includes('\0')) return 'The message contains a NUL character, which cannot be passed to the Codex queue route.';
  return null;
}

/** Deliver through `codex queue`, for terminal sessions the daemon does not hold. Never retried. */
export function queueToTerminalThread({ threadId, text, env = process.env, signal, timeoutMs = 30000, command, args } = {}) {
  try { checkCancellation(signal); } catch (error) { return Promise.reject(error); }
  const refusal = queueTargetRefusal(threadId) || queueRefusal(text);
  if (refusal) return Promise.reject(new Error(refusal));
  threadId = normalizeCodexThreadId(threadId);
  const effective = { ...process.env, ...env };
  let executable;
  try { executable = resolveExecutable({ effective, command }); } catch (error) { return Promise.reject(error); }
  const unknown = message => markUnknown(new Error(message));
  return new Promise((resolve, reject) => {
    try {
      execFile(executable, [...(args ?? []), 'queue', '--thread', threadId, '--message', text],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 65536, env: effective, signal }, (error, stdout, stderr) => {
          if (error) {
            // Node sets `syscall: 'spawn <file>'` on errors raised while starting the child.
            const startFailure = typeof error.syscall === 'string' && error.syscall.startsWith('spawn');
            if (startFailure) { reject(new Error('The Codex executable could not be started.')); return; }
            if (error.code === 1 && /no rollout found for thread id|No active session found matching/i.test(String(stderr))) {
              reject(new Error('The selected Codex session was not found in the Codex thread store.'));
              return;
            }
            reject(unknown('Codex queue did not complete.'));
            return;
          }
          const match = QUEUED.exec(String(stdout));
          if (match && normalizeCodexThreadId(match[2]) === threadId) resolve({ method: 'queue', queueId: match[1] });
          else reject(unknown('Codex queue returned an unexpected answer.'));
        });
    } catch {
      reject(new Error('The Codex executable could not be started.'));
    }
  });
}

/** Read the CLI and daemon versions without starting anything (`codex app-server daemon version`). */
export function readDaemonVersions({ env = process.env, command, args, timeoutMs = 5000 } = {}) {
  const effective = { ...process.env, ...env };
  if (!command && disabledValue(effective) !== null) return Promise.resolve(null);
  const executable = command ?? resolveCodexExecutable({ env: effective });
  if (!executable) return Promise.resolve(null);
  if (!command && !isDirectExecutable(executable)) return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      execFile(executable, args ?? ['app-server', 'daemon', 'version'],
        { windowsHide: true, timeout: timeoutMs, env: effective }, (error, stdout) => {
          if (error) { resolve(null); return; }
          try {
            const parsed = JSON.parse(stdout);
            resolve({ cli: parsed.cliVersion ?? null, server: parsed.appServerVersion ?? null });
          } catch { resolve(null); }
        });
    } catch { resolve(null); }
  });
}
