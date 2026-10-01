import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { defaultStateDir, processAlive } from './store.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const MAX_LEDGER_BYTES = 32 * 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_LEDGERS = 1024;
const MAX_PAGE_BYTES = 1024 * 1024;
const statuses = new Set(['sending', 'submitted', 'failed', 'uncertain']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateHistoryOwner(ownerThreadId) {
  if (typeof ownerThreadId !== 'string' || !ownerThreadId.trim() || Buffer.byteLength(ownerThreadId) > 512 || /[\r\n\0]/.test(ownerThreadId)) {
    throw new Error('A verified owning Codex task is required.');
  }
  return ownerThreadId;
}

export function validateClaudeHistoryId(sessionId) {
  if (typeof sessionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId)) {
    throw new Error('An exact Claude Code session UUID is required.');
  }
  return sessionId;
}

function checkCancellation(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Bridge history request was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

const samePath = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);
const rootChanged = () => Object.assign(new Error('The shared bridge state directory changed during the scan.'), { code: 'ROOT_CHANGED' });

async function directorySnapshot(directory) {
  const selected = path.resolve(directory);
  const before = await fs.lstat(selected);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('A real local directory is required.');
  const realPath = await fs.realpath(selected);
  const after = await fs.lstat(selected);
  if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error('The local directory changed while resolving it.');
  }
  return { path: selected, realPath, dev: after.dev, ino: after.ino };
}

async function assertDirectory(snapshot, isRoot = false) {
  try {
    const before = await fs.lstat(snapshot.path);
    if (!before.isDirectory() || before.isSymbolicLink() || before.dev !== snapshot.dev || before.ino !== snapshot.ino ||
        !samePath(await fs.realpath(snapshot.path), snapshot.realPath)) throw new Error('Directory changed');
    const after = await fs.lstat(snapshot.path);
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== snapshot.dev || after.ino !== snapshot.ino) {
      throw new Error('Directory changed');
    }
  } catch (error) {
    if (isRoot) throw rootChanged();
    throw error;
  }
}

async function assertLedgerDirectories(root, directory) {
  await assertDirectory(root, true);
  await assertDirectory(directory);
  const relative = path.relative(root.realPath, directory.realPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The delivery ledger is outside the shared bridge state directory.');
  }
  await assertDirectory(root, true);
}

async function safeLedger(root, key, budget) {
  await assertDirectory(root, true);
  const directory = await directorySnapshot(path.join(root.path, key));
  await assertLedgerDirectories(root, directory);
  if (!samePath(directory.realPath, path.join(root.realPath, key))) throw new Error('The delivery ledger resolved to an unexpected directory.');
  const file = path.join(directory.path, 'state.json');
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_LEDGER_BYTES || before.size > budget.remaining) {
    throw new Error('The delivery ledger exceeds the safe read limit or is not a regular file.');
  }
  if (!samePath(await fs.realpath(file), path.join(directory.realPath, 'state.json'))) {
    throw new Error('The delivery ledger resolved outside its selected directory.');
  }
  await assertLedgerDirectories(root, directory);
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error('The delivery ledger changed while opening it.');
    }
    await assertLedgerDirectories(root, directory);
    budget.remaining -= opened.size;
    const bytes = Buffer.alloc(opened.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== opened.size) throw new Error('The delivery ledger changed while reading it.');
    const state = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (!object(state) || state.schemaVersion !== 1 || state.key !== key ||
        typeof state.threadId !== 'string' || hash(state.threadId) !== key || typeof state.cwd !== 'string' ||
        !object(state.messages)) throw new Error('Invalid delivery ledger ownership.');
    // The bounded snapshot validates the same ownership fields as readSession.
    // Do not reopen it with the store's synchronous, unbounded JSON reader.
    await assertLedgerDirectories(root, directory);
    const after = await fs.lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || !samePath(await fs.realpath(file), path.join(directory.realPath, 'state.json')) ||
        after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error('The delivery ledger changed during the read.');
    }
    await assertLedgerDirectories(root, directory);
    return state;
  } finally { await handle.close(); }
}

function selectedRoute(record, ledgerOwner, ownerThreadId, sessionId) {
  if (!object(record) || !object(record.route) || !object(record.route.from) || !object(record.route.to)) return null;
  const { from, to } = record.route;
  if (record.direction === 'to_claude' && ledgerOwner === ownerThreadId &&
      from.kind === 'codex' && from.id === ownerThreadId && to.kind === 'claude' &&
      (sessionId === undefined || to.id === sessionId)) return { sessionId: to.id, direction: 'to_claude' };
  if (record.direction === 'to_codex' && from.kind === 'claude' && to.kind === 'codex' &&
      to.id === ownerThreadId && ledgerOwner === `claude:${from.id}` &&
      (sessionId === undefined || from.id === sessionId)) return { sessionId: from.id, direction: 'to_codex' };
  return null;
}

function effectiveStatus(record) {
  if (record.status === 'sending' && ((Number.isSafeInteger(record.senderPid) && !processAlive(record.senderPid)) ||
      Date.now() - record.createdAt > 60_000)) return 'uncertain';
  return record.status;
}

/** Read only explicitly sent bridge messages. No native conversation log is
 * read, and each message must belong to both its ledger owner and route pair.
 */
export async function scanBridgeExchange({ stateDir = defaultStateDir(), ownerThreadId, sessionId, signal } = {}) {
  validateHistoryOwner(ownerThreadId);
  if (sessionId !== undefined) validateClaudeHistoryId(sessionId);
  checkCancellation(signal);
  const warnings = new Set();
  let root;
  try { root = await directorySnapshot(path.resolve(stateDir)); }
  catch (error) {
    if (error.code === 'ENOENT') return { records: [], warnings: [] };
    return { records: [], warnings: ['The shared bridge state directory is unreadable or is not a real directory.'] };
  }
  const budget = { remaining: MAX_SCAN_BYTES };
  const records = [];
  let entries;
  const changedRootResult = () => ({ records: [], warnings: [...warnings,
    'The shared bridge state directory changed during the scan. No delivery records are returned; retry after its location is stable.'] });
  try {
    await assertDirectory(root, true);
    entries = await fs.readdir(root.path, { withFileTypes: true });
    await assertDirectory(root, true);
  } catch (error) {
    if (error.code === 'ROOT_CHANGED') return changedRootResult();
    return { records: [], warnings: ['The local bridge delivery ledgers could not be listed.'] };
  }
  // Exact owner ledgers are checked first so unrelated directories cannot
  // displace this conversation from the bounded scan.
  const ownerKey = hash(ownerThreadId);
  const selectedKey = sessionId === undefined ? null : hash(`claude:${sessionId}`);
  const candidates = entries.filter(entry => /^[a-f0-9]{64}$/.test(entry.name))
    .sort((left, right) => {
      const rank = key => key === ownerKey ? 0 : key === selectedKey ? 1 : 2;
      return rank(left.name) - rank(right.name) || left.name.localeCompare(right.name);
    });
  const relevant = sessionId === undefined ? candidates : candidates.filter(entry => entry.name === ownerKey || entry.name === selectedKey);
  if (relevant.length > MAX_LEDGERS) warnings.add('Some delivery ledgers were omitted because the local scan limit was reached.');
  for (const entry of relevant.slice(0, MAX_LEDGERS)) {
    checkCancellation(signal);
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Invalid ledger directory');
      const state = await safeLedger(root, entry.name, budget);
      for (const record of Object.values(state.messages)) {
        if (object(record) && !object(record.route) &&
            (state.threadId === ownerThreadId || entry.name === selectedKey)) {
          warnings.add('Older delivery records without exact routing metadata are not included.');
        }
        const route = selectedRoute(record, state.threadId, ownerThreadId, sessionId);
        if (route === null) continue;
        try { validateClaudeHistoryId(route.sessionId); } catch { warnings.add('Some invalid bridge delivery records were skipped.'); continue; }
        if (typeof record.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(record.id) ||
            typeof record.message !== 'string' || Buffer.byteLength(record.message) > 65536 ||
            !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 || !statuses.has(record.status)) {
          warnings.add('Some invalid bridge delivery records were skipped.');
          continue;
        }
        records.push({ ...record, sessionId: route.sessionId, status: effectiveStatus(record) });
      }
    } catch (error) {
      if (error.code === 'ROOT_CHANGED') return changedRootResult();
      warnings.add('Some local delivery ledgers were unreadable, changed, or exceeded the safe scan limit.');
    }
  }
  checkCancellation(signal);
  try { await assertDirectory(root, true); }
  catch { return changedRootResult(); }
  return { records, warnings: [...warnings] };
}

function sortKey(record) { return `${record.direction}:${record.id}`; }
function compare(left, right) { return left.createdAt - right.createdAt || sortKey(left).localeCompare(sortKey(right)); }

function readCursor(cursor, ownerThreadId, sessionId) {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid conversation cursor.');
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!object(value) || value.v !== 1 || value.owner !== hash(ownerThreadId) || value.session !== hash(sessionId) ||
        !Number.isSafeInteger(value.at) || value.at < 0 || typeof value.key !== 'string' ||
        !/^(to_claude|to_codex):[a-zA-Z0-9_-]{1,100}$/.test(value.key)) throw new Error('Invalid cursor');
    return value;
  } catch { throw new Error('Invalid conversation cursor.'); }
}

function makeCursor(record, ownerThreadId, sessionId) {
  return Buffer.from(JSON.stringify({ v: 1, owner: hash(ownerThreadId), session: hash(sessionId),
    at: record.createdAt, key: sortKey(record) })).toString('base64url');
}

export async function getBridgeConversation({ stateDir = defaultStateDir(), ownerThreadId, sessionId, limit = 100, cursor, signal } = {}) {
  validateHistoryOwner(ownerThreadId);
  validateClaudeHistoryId(sessionId);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Conversation limit must be between 1 and 200.');
  const before = readCursor(cursor, ownerThreadId, sessionId);
  const scanned = await scanBridgeExchange({ stateDir, ownerThreadId, sessionId, signal });
  let manualRecords = [];
  try {
    const { readManualRecords } = await import('./manual-service.mjs');
    const result = await readManualRecords({ stateDir, threadId: ownerThreadId });
    manualRecords = Array.isArray(result) ? result : Object.values(result ?? {});
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ERR_MODULE_NOT_FOUND') scanned.warnings.push('Manual delivery notice metadata could not be read.');
  }
  checkCancellation(signal);
  const notices = new Map(manualRecords.filter(record => record?.manual === true && record.session_id === sessionId)
    .map(record => [record.message_id, record]));
  const eligible = scanned.records.filter(record => before === null || record.createdAt < before.at ||
    (record.createdAt === before.at && sortKey(record).localeCompare(before.key) < 0)).sort(compare);
  const page = [];
  let bytes = 0;
  for (let index = eligible.length - 1; index >= 0 && page.length < limit; index--) {
    const record = eligible[index];
    const notice = record.direction === 'to_claude' ? notices.get(record.id) : undefined;
    const matchesNotice = notice !== undefined && typeof record.fingerprint === 'string' && notice.fingerprint === record.fingerprint;
    const visible = { id: record.id, direction: record.direction, message: record.message, created_at: record.createdAt,
      status: record.status, ...(record.manual === true || matchesNotice ? { manual: true } : {}) };
    if (matchesNotice && ['pending', 'submitted', 'failed', 'uncertain'].includes(notice.notice_status)) {
      visible.notice_status = notice.notice_status;
    }
    if (matchesNotice && typeof notice.notice_retryable === 'boolean') visible.notice_retryable = notice.notice_retryable;
    const size = Buffer.byteLength(JSON.stringify(visible));
    if (page.length && bytes + size > MAX_PAGE_BYTES) break;
    bytes += size;
    page.push({ record, visible });
  }
  page.reverse();
  const hasMore = page.length < eligible.length;
  return { session_id: sessionId, messages: page.map(item => item.visible),
    next_cursor: hasMore ? makeCursor(page[0].record, ownerThreadId, sessionId) : null,
    has_more: hasMore, warnings: [...new Set(scanned.warnings)] };
}
