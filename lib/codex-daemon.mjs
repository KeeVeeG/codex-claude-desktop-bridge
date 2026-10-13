// Terminal Codex sessions register with the local Codex app-server daemon. Its
// control socket speaks WebSocket and is only reachable through
// `codex app-server proxy` (the socket's ACL blocks direct Node access).
// This module never starts the daemon, never resumes a thread, and never uses a shell.
import { spawn } from 'node:child_process';
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

export function openDaemon({ env = process.env, command, args, signal, timeoutMs = 10000 } = {}) {
  try { checkCancellation(signal); } catch (error) { return Promise.reject(error); }
  let executable = command;
  if (!executable) {
    if (env.CODEX_CLAUDE_BRIDGE_DAEMON === 'off') {
      return Promise.reject(new DaemonUnavailableError('Codex terminal support is disabled by CODEX_CLAUDE_BRIDGE_DAEMON=off.'));
    }
    executable = resolveCodexExecutable({ env });
    if (!executable) {
      return Promise.reject(new DaemonUnavailableError('The Codex executable was not found. Install the Codex CLI, or set CODEX_CLAUDE_BRIDGE_CODEX_BIN to the path of codex.exe.'));
    }
  }
  return new Promise((resolveOpen, rejectOpen) => {
    // The effective environment (for example CODEX_HOME) is the supplied one layered over the process's.
    const child = spawn(executable, args ?? ['app-server', 'proxy'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } });
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
        entry.reject(Object.assign(new Error(`Codex daemon: ${rpcMessage}`), { rpcCode: message.error.code, rpcMessage }));
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
    child.on('close', () => {
      const hint = stderr.trim() ? ` (${stderr.trim().slice(0, 200)})` : '';
      fail(opened ? new Error('The Codex daemon connection closed unexpectedly.')
        : new DaemonUnavailableError(`The Codex daemon is not reachable${hint}. Start a Codex terminal session so the daemon is running.`));
    });
    child.stdout.on('data', chunk => {
      let events;
      try { events = decoder.push(chunk); } catch (error) { fail(error); return; }
      for (const event of events) {
        if (event.type === 'open') afterUpgrade();
        else if (event.type === 'text') handle(event.text);
        else if (event.type === 'ping') { try { write(encodePong(event.payload)); } catch { /* closing */ } }
        else if (event.type === 'close') fail(new Error('The Codex daemon closed the connection.'));
      }
    });
    write(Buffer.from(upgrade.text, 'latin1'));
  });
}
