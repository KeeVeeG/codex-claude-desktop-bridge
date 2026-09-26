import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultStateDir, withStateLock } from './store.mjs';

const HOST_FILE = 'codex-host.json';
const MAX_HOST_BYTES = 16_384;
const MAX_HOSTS = 32;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function retryContention(error, until) {
  if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) return false;
  const remaining = until - Date.now();
  if (remaining <= 0) return false;
  Atomics.wait(sleepBuffer, 0, 0, Math.min(25, remaining));
  return true;
}

function retryChanged(until) {
  const remaining = until - Date.now();
  if (remaining <= 0) return false;
  Atomics.wait(sleepBuffer, 0, 0, Math.min(10, remaining));
  return true;
}

function hostChanged(message) {
  const error = new Error(message);
  error.code = 'HOST_CHANGED';
  return error;
}

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

function validateRegistry(value) {
  const primary = validateHost(value);
  if (value.hosts === undefined) return [primary];
  if (!Array.isArray(value.hosts) || value.hosts.length >= MAX_HOSTS) throw new Error('Invalid Codex host registry candidates.');
  return [primary, ...value.hosts.map(validateHost)];
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
    const prior = getCodexHosts({ stateDir: directory });
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Codex host registry entry must be a regular file.');
    }
    const key = host => `${host.pipePath}\0${host.threadId}`;
    const candidates = [record, ...prior.filter(host => key(host) !== key(record))].slice(0, MAX_HOSTS);
    let serialized;
    for (;;) {
      serialized = `${JSON.stringify({ ...record, hosts: candidates.slice(1) }, null, 2)}\n`;
      if (Buffer.byteLength(serialized) <= MAX_HOST_BYTES) break;
      if (candidates.length === 1) throw new Error('Codex host registry exceeds its size limit.');
      candidates.pop();
    }
    const temporary = path.join(directory, `${HOST_FILE}.${process.pid}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      const until = Date.now() + 1000;
      for (;;) {
        try { fs.renameSync(temporary, file); break; }
        catch (error) { if (!retryContention(error, until)) throw error; }
      }
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return record;
  });
}

/** Read a previously published app endpoint. A stopped publisher does not make
 * the app endpoint stale: actual tool calls determine whether it is available.
 */
export function getCodexHosts({ stateDir } = {}) {
  const { directory, file } = registryPaths(stateDir);
  try {
    checkDirectory(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const until = Date.now() + 1000;
  let observedFile = false;
  for (;;) {
    let before;
    try {
      before = fs.lstatSync(file);
      observedFile = true;
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_HOST_BYTES) {
        throw new Error('Codex host registry entry must be a bounded regular file.');
      }
      const fd = fs.openSync(file, 'r');
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_HOST_BYTES) {
          throw hostChanged('Codex host registry changed while opening it.');
        }
        const buffer = Buffer.alloc(MAX_HOST_BYTES + 1);
        const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (size > MAX_HOST_BYTES) throw new Error('Codex host registry exceeds its size limit.');
        const after = fs.lstatSync(file);
        if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
          throw hostChanged('Codex host registry changed while reading it; retry discovery.');
        }
        let record;
        try { record = JSON.parse(buffer.subarray(0, size).toString('utf8')); } catch {
          throw new Error('Invalid Codex host registry JSON.');
        }
        return validateRegistry(record);
      } finally { fs.closeSync(fd); }
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (observedFile && retryChanged(until)) continue;
        return [];
      }
      if (error.code === 'HOST_CHANGED' && retryChanged(until)) continue;
      if (retryContention(error, until)) continue;
      throw error;
    }
  }
}

export function getCodexHost({ stateDir } = {}) {
  return getCodexHosts({ stateDir })[0] ?? null;
}
