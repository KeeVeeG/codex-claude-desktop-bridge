import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultStateDir, withStateLock } from './store.mjs';

const HOST_FILE = 'codex-host.json';
const MAX_HOST_BYTES = 16_384;

function validateHost(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.schemaVersion !== 1) {
    throw new Error('Invalid Codex host registry format.');
  }
  const pipe = record.pipePath;
  const localPipe = typeof pipe === 'string' && pipe.length <= 4096 &&
    /^\\\\\.\\pipe\\(?:LOCAL\\)?[^\\/\r\n\0]+$/i.test(pipe) && !/[. ]$/.test(pipe);
  if (!localPipe) throw new Error('Codex host endpoint must be a local Windows named pipe.');
  if (typeof record.threadId !== 'string' || !record.threadId.trim() ||
      Buffer.byteLength(record.threadId) > 512 || /[\r\n\0]/.test(record.threadId)) {
    throw new Error('Codex host requires a real context task ID.');
  }
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || !Number.isSafeInteger(record.publishedAt) || record.publishedAt <= 0) {
    throw new Error('Codex host registry contains invalid process metadata.');
  }
  return { schemaVersion: 1, pipePath: pipe, threadId: record.threadId, pid: record.pid, publishedAt: record.publishedAt };
}

function registryPaths(stateDir) {
  const directory = path.resolve(stateDir || defaultStateDir());
  return { directory, file: path.join(directory, HOST_FILE) };
}

function checkDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Codex host registry must use a real local state directory.');
}

/** Publish an endpoint from verified Codex context. This is a local address
 * registry, not a new task or a messaging subscription. It stores no token.
 */
export function publishCodexHost({ stateDir, pipePath, threadId, pid = process.pid } = {}) {
  const record = validateHost({ schemaVersion: 1, pipePath, threadId, pid, publishedAt: Date.now() });
  const { directory, file } = registryPaths(stateDir);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  checkDirectory(directory);
  return withStateLock(directory, () => {
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Codex host registry entry must be a regular file.');
    }
    const temporary = path.join(directory, `${HOST_FILE}.${process.pid}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return record;
  });
}

/** Read a previously published app endpoint. A stopped publisher does not make
 * the app endpoint stale: actual tool calls determine whether it is available.
 */
export function getCodexHost({ stateDir } = {}) {
  const { directory, file } = registryPaths(stateDir);
  let before;
  try {
    checkDirectory(directory);
    before = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_HOST_BYTES) {
    throw new Error('Codex host registry entry must be a bounded regular file.');
  }
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_HOST_BYTES) {
      throw new Error('Codex host registry changed while opening it.');
    }
    const buffer = Buffer.alloc(MAX_HOST_BYTES + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > MAX_HOST_BYTES) throw new Error('Codex host registry exceeds its size limit.');
    const after = fs.lstatSync(file);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error('Codex host registry changed while reading it; retry discovery.');
    }
    let record;
    try { record = JSON.parse(buffer.subarray(0, size).toString('utf8')); } catch {
      throw new Error('Invalid Codex host registry JSON.');
    }
    return validateHost(record);
  } finally { fs.closeSync(fd); }
}
