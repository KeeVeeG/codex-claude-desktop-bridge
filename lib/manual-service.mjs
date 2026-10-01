import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { codexIdentity, executeBridgeTool } from './desktop-service.mjs';
import { sendToCodex } from './codex-desktop.mjs';
import { defaultStateDir, getSession, readSession, processAlive, withStateLock } from './store.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
const STALE_ATTEMPT_MS = 60_000;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) &&
  value !== 'prototype' && !Object.hasOwn(Object.prototype, value);
const recordKey = (sessionId, messageId) => hash(JSON.stringify([sessionId, messageId]));

function requiredText(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim() || /\0/.test(value) || Buffer.byteLength(value) > maximum) {
    throw new Error(`${name} must be nonempty text, at most ${maximum} UTF-8 bytes.`);
  }
  return value;
}

function checkCancellation(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Manual bridge send was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function ledgerPaths(stateDir, threadId) {
  requiredText(threadId, 'Verified Codex task ID', 512);
  if (/[\r\n]/.test(threadId)) throw new Error('Invalid verified Codex task ID.');
  const state = path.resolve(stateDir || defaultStateDir());
  const manual = path.join(state, 'manual');
  const directory = path.join(manual, hash(threadId));
  return { state, manual, directory, file: path.join(directory, 'state.json'), threadId };
}

function checkDirectory(directory, create = false) {
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Manual bridge records require a real local directory.');
}

function checkDirectories(paths, create = false) {
  for (const directory of [paths.state, paths.manual, paths.directory]) checkDirectory(directory, create);
}

function validateLedger(value, paths) {
  if (!object(value) || value.schemaVersion !== 1 || value.owner_thread_id !== paths.threadId || !object(value.records)) {
    throw new Error('Manual bridge records have an invalid owner or format.');
  }
  for (const [key, record] of Object.entries(value.records)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !object(record) || !safeId(record.message_id) || recordKey(record.session_id, record.message_id) !== key ||
        typeof record.session_id !== 'string' || !record.session_id.trim() || Buffer.byteLength(record.session_id) > 256 ||
        !/^[a-f0-9]{64}$/.test(record.fingerprint) || record.manual !== true ||
        !['sending', 'submitted', 'failed', 'uncertain'].includes(record.send_status) ||
        !['pending', 'submitted', 'failed', 'uncertain'].includes(record.notice_status) ||
        typeof record.notice_attempted !== 'boolean' || !Number.isSafeInteger(record.sender_pid) || record.sender_pid <= 0 ||
        (record.notice_retryable !== undefined && typeof record.notice_retryable !== 'boolean') ||
        !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.updatedAt)) {
      throw new Error('Manual bridge records contain an invalid delivery entry.');
    }
  }
  return value;
}

function readLedger(paths) {
  let before;
  try { before = fs.lstatSync(paths.file); }
  catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, owner_thread_id: paths.threadId, records: {} };
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_LEDGER_BYTES) {
    throw new Error('Manual bridge ledger must be a bounded regular file.');
  }
  const fd = fs.openSync(paths.file, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_LEDGER_BYTES) {
      throw new Error('Manual bridge ledger changed while it was opened.');
    }
    const buffer = Buffer.alloc(MAX_LEDGER_BYTES + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > MAX_LEDGER_BYTES) throw new Error('Manual bridge ledger exceeds its size limit.');
    const after = fs.lstatSync(paths.file);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error('Manual bridge ledger changed while it was read.');
    }
    let value;
    try { value = JSON.parse(buffer.subarray(0, size).toString('utf8')); }
    catch { throw new Error('Manual bridge ledger contains invalid JSON.'); }
    return validateLedger(value, paths);
  } finally { fs.closeSync(fd); }
}

function saveLedger(paths, value) {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(text) > MAX_LEDGER_BYTES) throw new Error('Manual bridge ledger exceeds its size limit.');
  const temporary = `${paths.file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    const until = Date.now() + 1000;
    for (;;) {
      try { fs.renameSync(temporary, paths.file); break; }
      catch (error) {
        const remaining = until - Date.now();
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || remaining <= 0) throw error;
        Atomics.wait(sleepBuffer, 0, 0, Math.min(25, remaining));
      }
    }
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function updateLedger(paths, callback) {
  checkDirectories(paths, true);
  return withStateLock(paths.directory, () => {
    const ledger = readLedger(paths);
    const result = callback(ledger);
    saveLedger(paths, ledger);
    return result;
  });
}

const interrupted = record => !processAlive(record.sender_pid) || Date.now() - record.updatedAt > STALE_ATTEMPT_MS;

/** Only a verified owner may select threadId; history callers must obtain it
 * from the runtime, never from a model/UI-supplied sender field. This read creates
 * no directory and exposes no records from other Codex tasks.
 */
export function readManualRecords({ stateDir, threadId }) {
  const paths = ledgerPaths(stateDir, threadId);
  try { checkDirectories(paths); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return Object.values(readLedger(paths).records).map(record => {
    const visible = { ...record };
    if (visible.send_status === 'sending' && interrupted(visible)) visible.send_status = 'uncertain';
    if (visible.notice_status === 'pending' && visible.notice_attempted && interrupted(visible)) {
      visible.notice_status = 'uncertain'; visible.notice_retryable = false;
    }
    return visible;
  });
}

function originalMessage(stateDir, route, id) {
  const session = getSession({ stateDir, threadId: route.from.id });
  if (!session) return null;
  return Object.values(readSession(session).messages).find(record => record.id === id &&
    record.route?.from?.kind === 'codex' && record.route.from.id === route.from.id &&
    record.route?.to?.kind === 'claude' && record.route.to.id === route.to.id) || null;
}

function resultFor(args, route, record, message) {
  return { message: { ...(message || {
    id: args.message_id, route, direction: 'to_claude', message: args.message,
    createdAt: record.createdAt, updatedAt: record.updatedAt, status: record.send_status, fingerprint: record.fingerprint,
    ...(record.error ? { error: record.error } : {}),
  }), status: record.send_status, ...(record.error ? { error: record.error } : {}), manual: true }, manual: true,
  notice_status: record.notice_status, notice_retryable: record.notice_retryable === true,
  ...(record.notice_error ? { notice_error: record.notice_error } : {}) };
}

function noticeText(args) {
  return `[User sent to Claude session ${JSON.stringify(args.session_id)}; bridge message ${JSON.stringify(args.message_id)}; context only]\n\n${args.message}`;
}

async function submitNotice(args, context, identity, paths, key) {
  let noticeSubmitted = false;
  try {
    checkCancellation(context.signal);
    await sendToCodex({ pipePath: identity.pipePath, contextThreadId: identity.threadId, threadId: identity.threadId,
      message: noticeText(args), signal: context.signal });
    noticeSubmitted = true;
    return updateLedger(paths, ledger => {
      const saved = ledger.records[key]; saved.notice_status = 'submitted'; saved.notice_retryable = false;
      delete saved.notice_error; saved.updatedAt = Date.now();
      return { ...saved };
    });
  } catch (error) {
    return updateLedger(paths, ledger => {
      const saved = ledger.records[key];
      saved.notice_status = noticeSubmitted || error.deliveryUnknown ? 'uncertain' : 'failed';
      saved.notice_retryable = saved.notice_status === 'failed';
      saved.notice_error = error instanceof Error ? error.message : 'The Codex owner notice failed.'; saved.updatedAt = Date.now();
      return { ...saved };
    });
  }
}

function owningCodexContext(context) {
  const env = context.env || process.env;
  if (env.CLAUDE_CODE_MESSAGING_SOCKET) throw new Error('Manual sending is available only from the owning Codex Desktop task.');
  const identity = codexIdentity(context.metadata || {}, env);
  const stateDir = context.stateDir || env.CODEX_CLAUDE_BRIDGE_STATE_DIR || defaultStateDir({ env });
  return { identity, stateDir };
}

/** A human UI click supplies only a Claude destination, text, and stable request
 * ID. The owning Codex task is always taken from verified per-call metadata.
 * Neither the Claude send nor the native owner notice is retried automatically.
 */
export async function manualSend(args, context = {}) {
  checkCancellation(context.signal);
  if (!object(args) || Object.keys(args).some(key => !['session_id', 'message', 'message_id'].includes(key))) {
    throw new Error('Manual send accepts only session_id, message, and message_id.');
  }
  requiredText(args.session_id, 'Claude session ID', 256);
  requiredText(args.message, 'Message', 65536);
  if (!safeId(args.message_id)) throw new Error('Manual send requires a stable, valid message_id.');
  const { identity, stateDir } = owningCodexContext(context);
  const route = { from: { kind: 'codex', id: identity.threadId }, to: { kind: 'claude', id: args.session_id } };
  const fingerprint = hash(JSON.stringify({ direction: 'to_claude', message: args.message, route }));
  const paths = ledgerPaths(stateDir, identity.threadId);
  let message = originalMessage(stateDir, route, args.message_id);
  if (message && message.fingerprint !== fingerprint) {
    throw new Error('This manual message_id already belongs to another recipient or message text.');
  }
  if (message && message.manual !== true && message.origin !== 'manual') {
    throw new Error('This message_id was already used outside the manual interface. Choose a new message_id.');
  }
  const key = recordKey(args.session_id, args.message_id);
  const reservation = updateLedger(paths, ledger => {
    let record = ledger.records[key];
    if (record) {
      if (record.session_id !== args.session_id || record.fingerprint !== fingerprint) {
        throw new Error('This manual message_id already belongs to another recipient or message text.');
      }
      if (record.send_status === 'sending') {
        if (message && ['submitted', 'failed', 'uncertain'].includes(message.status)) record.send_status = message.status;
        else if (interrupted(record)) record.send_status = 'uncertain';
      }
      if (record.notice_status === 'pending' && record.notice_attempted && interrupted(record)) {
        record.notice_status = 'uncertain'; record.notice_retryable = false;
      }
      return { created: false, record: { ...record } };
    }
    const now = Date.now();
    record = { message_id: args.message_id, session_id: args.session_id, fingerprint, manual: true,
      send_status: message?.status || 'sending', notice_status: message ? 'uncertain' : 'pending',
      notice_attempted: Boolean(message), notice_retryable: false,
      sender_pid: process.pid, createdAt: now, updatedAt: now };
    if (message) record.notice_error = 'The original manual notice record is missing. Inspect the current Codex chat; no notice was repeated.';
    ledger.records[key] = record;
    return { created: !message, record: { ...record } };
  });
  let record = reservation.record;
  if (reservation.created) {
    try {
      const submitted = await executeBridgeTool('send_to_claude', args, { ...context, stateDir, manual: true });
      message = submitted.message;
      if (message?.status !== 'submitted') throw Object.assign(new Error('Manual Claude send returned an unsupported outcome.'), { deliveryUnknown: true });
      record = updateLedger(paths, ledger => {
        const saved = ledger.records[key]; saved.send_status = 'submitted'; saved.updatedAt = Date.now();
        return { ...saved };
      });
    } catch (error) {
      message = originalMessage(stateDir, route, args.message_id);
      record = updateLedger(paths, ledger => {
        const saved = ledger.records[key];
        saved.send_status = error.deliveryUnknown ? 'uncertain' : message?.status === 'submitted' ? 'submitted' : 'failed';
        saved.error = error instanceof Error ? error.message : 'Manual Claude send failed.'; saved.updatedAt = Date.now();
        return { ...saved };
      });
      return resultFor(args, route, record, message ? { ...message, status: record.send_status } : null);
    }
  }
  if (record.send_status !== 'submitted') return resultFor(args, route, record, message);
  const claim = updateLedger(paths, ledger => {
    const saved = ledger.records[key];
    if (saved.notice_status !== 'pending' || saved.notice_attempted) return { claimed: false, record: { ...saved } };
    saved.notice_attempted = true; saved.notice_retryable = false; saved.sender_pid = process.pid; saved.updatedAt = Date.now();
    return { claimed: true, record: { ...saved } };
  });
  record = claim.record;
  if (!claim.claimed) return resultFor(args, route, record, message);
  record = await submitNotice(args, context, identity, paths, key);
  return resultFor(args, route, record, message);
}

/** Explicit human retry after a definite owner-notice rejection. The original
 * submitted Claude delivery and its full text are recovered from the owner
 * ledger; this operation cannot initiate or repeat a Claude transport write.
 */
export async function retryManualNotice(args, context = {}) {
  checkCancellation(context.signal);
  if (!object(args) || Object.keys(args).some(key => !['session_id', 'message_id'].includes(key))) {
    throw new Error('Notice retry accepts only session_id and message_id.');
  }
  requiredText(args.session_id, 'Claude session ID', 256);
  if (!safeId(args.message_id)) throw new Error('Notice retry requires the original valid message_id.');
  const { identity, stateDir } = owningCodexContext(context);
  const route = { from: { kind: 'codex', id: identity.threadId }, to: { kind: 'claude', id: args.session_id } };
  const message = originalMessage(stateDir, route, args.message_id);
  if (!message || message.status !== 'submitted' || (message.manual !== true && message.origin !== 'manual')) {
    throw new Error('Only a confirmed submitted manual message from this Codex task can retry its owner notice.');
  }
  const paths = ledgerPaths(stateDir, identity.threadId);
  // An absent ledger is not permission to send a notice again.
  checkDirectories(paths);
  const key = recordKey(args.session_id, args.message_id);
  updateLedger(paths, ledger => {
    const record = ledger.records[key];
    if (!record || record.session_id !== args.session_id || record.fingerprint !== message.fingerprint ||
        record.send_status !== 'submitted' || record.notice_status !== 'failed' || record.notice_retryable !== true) {
      throw new Error('This owner notice is not safely retryable. Inspect the current Codex chat before taking another action.');
    }
    record.notice_status = 'pending'; record.notice_attempted = true; record.notice_retryable = false;
    record.sender_pid = process.pid; record.updatedAt = Date.now();
  });
  const originalArgs = { ...args, message: message.message };
  const record = await submitNotice(originalArgs, context, identity, paths, key);
  return resultFor(originalArgs, route, record, message);
}
