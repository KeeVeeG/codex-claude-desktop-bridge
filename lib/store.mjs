import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function retryWindowsContention(error, until) {
  if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) return false;
  const remaining = until - Date.now();
  if (remaining <= 0) return false;
  Atomics.wait(sleepBuffer, 0, 0, Math.min(25, remaining));
  return true;
}

export function defaultStateDir({ homeDir = os.homedir(), env = process.env } = {}) {
  // Windows app packages can see different virtualized AppData directories.
  // Both desktop apps must use the same user-owned location regardless of cwd.
  return env.CODEX_CLAUDE_BRIDGE_STATE_DIR || path.join(homeDir, '.local', 'share', 'codex-claude-desktop-bridge');
}

function text(value, name, max = 65536) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) {
    throw new Error(`${name} must be nonempty text, at most ${max} UTF-8 bytes`);
  }
  return value;
}

function sessionAt(stateDir, key) {
  if (!/^[a-f0-9]{64}$/.test(key || '')) throw new Error('Invalid session key');
  const dir = path.join(path.resolve(stateDir || defaultStateDir()), key);
  return { key, dir, stateFile: path.join(dir, 'state.json') };
}

function atomicJson(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const deadline = Date.now() + 1000;
    for (;;) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (error) {
        // Windows readers and sync clients can briefly prevent replacement.
        // Retain the same prepared document and the caller's state lock; only
        // this rename is retried, never the state callback or message delivery.
        const remaining = deadline - Date.now();
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || remaining <= 0) throw error;
        Atomics.wait(sleepBuffer, 0, 0, Math.min(25, remaining));
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function withLock(session, fn) {
  fs.mkdirSync(session.dir, { recursive: true });
  const lockPath = path.join(session.dir, 'state.lock');
  const recoveryPath = path.join(session.dir, 'state.lock.recovery');
  const token = crypto.randomUUID();
  const until = Date.now() + 5000;
  let acquired = false;
  while (!acquired) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); }
      catch (writeError) {
        // Nobody can recover an incomplete lock while its creator is still
        // writing it. Remove our own failed creation before propagating.
        try { fs.unlinkSync(lockPath); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
        throw writeError;
      }
      finally { fs.closeSync(fd); }
      acquired = true;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        // Windows can deny an exclusive open while another process closes or
        // removes its lock. Retry acquisition without assuming we own it.
        if (retryWindowsContention(e, until)) continue;
        throw e;
      }
      let stale = false;
      try {
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        stale = Number.isInteger(owner?.pid) && owner.pid > 0 && !processAlive(owner.pid);
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        // A transient sharing violation can also race a lock replacement.
        if (retryWindowsContention(err, until)) continue;
        // A creator can be between open and write. Without a valid PID, age
        // alone cannot prove it is dead, so incomplete locks are never stolen.
        if (!(err instanceof SyntaxError)) throw err;
      }
      if (stale) {
        let recoveryFd;
        try { recoveryFd = fs.openSync(recoveryPath, 'wx', 0o600); }
        catch (guardError) {
          // Windows can briefly deny exclusive creation while another process
          // releases this guard. A failed open grants no ownership: wait within
          // the existing deadline, then reread the main lock on the next pass.
          if (retryWindowsContention(guardError, until)) continue;
          if (guardError.code !== 'EEXIST') throw guardError;
          // Recovery guards are never automatically reclaimed: recursively
          // recovering them would recreate the same compare/unlink race.
          try {
            const recovering = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
            if (Number.isInteger(recovering?.pid) && recovering.pid > 0 && !processAlive(recovering.pid)) {
              throw new Error('Bridge lock recovery was interrupted; inspect state.lock.recovery before retrying');
            }
          } catch (readError) {
            if (readError.code === 'ENOENT') continue;
            // Reading another process's guard can briefly fail while it closes
            // or removes the file. A failed read gives us no recovery ownership.
            if (retryWindowsContention(readError, until)) continue;
            if (!(readError instanceof SyntaxError)) throw readError;
          }
        }
        if (recoveryFd !== undefined) {
          try {
            fs.writeFileSync(recoveryFd, JSON.stringify({ pid: process.pid, token }));
            // Only this recovery owner can remove a stale lock. Always reread
            // after taking the guard: the initial observation may be obsolete.
            for (;;) {
              try {
                const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
                if (Number.isInteger(owner?.pid) && owner.pid > 0 && !processAlive(owner.pid)) fs.unlinkSync(lockPath);
                break;
              } catch (readError) {
                if (readError.code === 'ENOENT' || readError instanceof SyntaxError) break;
                // If a Windows reader prevents access or deletion, inspect the
                // lock again before the next unlink attempt. Never rely on an
                // earlier stale-owner observation.
                if (retryWindowsContention(readError, until)) continue;
                throw readError;
              }
            }
          } finally {
            fs.closeSync(recoveryFd);
            const cleanupUntil = Date.now() + 1000;
            for (;;) {
              try { fs.unlinkSync(recoveryPath); break; }
              catch (cleanupError) {
                if (cleanupError.code === 'ENOENT') break;
                if (retryWindowsContention(cleanupError, cleanupUntil)) continue;
                throw cleanupError;
              }
            }
          }
          continue;
        }
      }
      if (Date.now() >= until) throw new Error('Bridge state is busy; retry with the same message ID');
      Atomics.wait(sleepBuffer, 0, 0, 15);
    }
  }
  try { return fn(); }
  finally {
    const cleanupUntil = Date.now() + 1000;
    for (;;) {
      try {
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (owner.token === token) fs.unlinkSync(lockPath);
        break;
      } catch (e) {
        if (e.code === 'ENOENT') break;
        // Recheck our token after a temporary sharing violation so cleanup
        // cannot remove a replacement lock owned by another process.
        if (retryWindowsContention(e, cleanupUntil)) continue;
        throw e;
      }
    }
  }
}

export function readSession(session) {
  const state = JSON.parse(fs.readFileSync(session.stateFile || path.join(session.dir, 'state.json'), 'utf8'));
  if (!state || typeof state !== 'object' || state.schemaVersion !== 1 || state.key !== session.key ||
      typeof state.threadId !== 'string' || hash(state.threadId) !== state.key || typeof state.cwd !== 'string') {
    throw new Error('Invalid bridge state');
  }
  // Earlier builds stored tasks under requests. Retain that history without
  // allowing old tasks or deadlines to affect asynchronous messaging.
  if (state.messages === undefined) state.messages = {};
  if (!state.messages || typeof state.messages !== 'object' || Array.isArray(state.messages)) throw new Error('Invalid bridge messages');
  if (state.desktop === undefined) state.desktop = null;
  return state;
}

function update(session, fn) {
  return withLock(session, () => {
    const state = readSession(session);
    const result = fn(state);
    atomicJson(session.stateFile || path.join(session.dir, 'state.json'), state);
    return result;
  });
}

export function createSession({ stateDir, threadId, cwd }) {
  text(threadId, 'threadId', 512);
  const realCwd = fs.realpathSync(text(cwd, 'cwd', 32768));
  if (!fs.statSync(realCwd).isDirectory()) throw new Error('cwd must be a directory');
  const session = sessionAt(stateDir, hash(threadId));
  return withLock(session, () => {
    let state;
    if (fs.existsSync(session.stateFile)) {
      state = readSession(session);
      if (state.cwd !== realCwd) throw new Error(`This chat is already bound to ${state.cwd}`);
    } else {
      state = { schemaVersion: 1, key: session.key, threadId, cwd: realCwd,
        createdAt: Date.now(), desktop: null, messages: {} };
      atomicJson(session.stateFile, state);
    }
    return { ...session, threadId: state.threadId, cwd: state.cwd };
  });
}

export function loadSession({ stateDir, sessionKey }) {
  const session = sessionAt(stateDir, sessionKey);
  const state = readSession(session);
  return { ...session, threadId: state.threadId, cwd: state.cwd };
}

export function getSession({ stateDir, threadId }) {
  text(threadId, 'threadId', 512);
  try { return loadSession({ stateDir, sessionKey: hash(threadId) }); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function messageId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value) ||
      value === 'prototype' || Object.hasOwn(Object.prototype, value)) throw new Error('Invalid message ID');
  return value;
}

function validatePairId(pairId) {
  if (pairId !== undefined && (typeof pairId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(pairId) ||
      pairId === 'prototype' || Object.hasOwn(Object.prototype, pairId))) throw new Error('Invalid pair ID');
  return pairId;
}

function messageKey(id, pairId) {
  messageId(id);
  validatePairId(pairId);
  return pairId === undefined ? id : `${pairId}:${id}`;
}

export function recordMessage(session, { id = crypto.randomUUID(), pairId, direction, message } = {}) {
  const key = messageKey(id, pairId);
  if (!['to_claude', 'to_codex'].includes(direction)) throw new Error('direction must be to_claude or to_codex');
  text(message, 'message');
  const fingerprint = hash(JSON.stringify({ direction, message }));
  return update(session, state => {
    if (Object.hasOwn(state.messages, key)) {
      const existing = state.messages[key];
      if (existing.pairId !== pairId) throw new Error('Message does not belong to this pair');
      if (existing.direction !== direction || existing.message !== message) throw new Error('Message ID already belongs to different content or direction');
      return { message: existing, created: false };
    }
    const record = { id, ...(pairId === undefined ? {} : { pairId }), direction, message, createdAt: Date.now(), status: 'sending', fingerprint };
    state.messages[key] = record;
    return { message: record, created: true };
  });
}

function jsonValue(value, name) {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized) > 131072) throw new Error('Invalid JSON value');
    return JSON.parse(serialized);
  } catch {
    throw new Error(`${name} must be JSON-serializable and at most 131072 UTF-8 bytes`);
  }
}

export function finishMessage(session, id, { status, error, receipt, pairId } = {}) {
  const key = messageKey(id, pairId);
  if (!['submitted', 'failed', 'uncertain'].includes(status)) throw new Error('status must be submitted, failed, or uncertain');
  const savedError = jsonValue(error, 'error');
  const savedReceipt = jsonValue(receipt, 'receipt');
  return update(session, state => {
    if (!Object.hasOwn(state.messages, key)) throw new Error('Message does not belong to this session or pair');
    const record = state.messages[key];
    if (record.pairId !== pairId) throw new Error('Message does not belong to this pair');
    record.status = status;
    record.updatedAt = Date.now();
    if (savedError === undefined) delete record.error;
    else record.error = savedError;
    if (savedReceipt === undefined) delete record.receipt;
    else record.receipt = savedReceipt;
    return record;
  });
}

export function getMessages(session, limit = 20, pairId) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('limit must be a nonnegative integer');
  validatePairId(pairId);
  return Object.values(readSession(session).messages).reverse()
    .filter(record => pairId === undefined || record.pairId === pairId)
    .sort((left, right) => right.createdAt - left.createdAt).slice(0, limit)
    .map(record => Object.fromEntries(
      ['id', 'pairId', 'direction', 'message', 'createdAt', 'status', 'fingerprint', 'updatedAt', 'error', 'receipt']
        .filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]),
    ));
}

// Used by the native Desktop transport to persist outbox receipts without storing credentials.
export function updateSession(session, fn) { return update(session, fn); }

export function withStateLock(directory, fn) { return withLock({ dir: directory }, fn); }
