import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discoverClaudeSessions } from './claude-desktop.mjs';
import { scanBridgeExchange, validateHistoryOwner, validateClaudeHistoryId } from './bridge-history.mjs';

const MAX_PROJECTS = 256;
const MAX_HISTORY_FILES = 4096;
const WINDOW_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const UUID_FILE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.jsonl$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeText = (value, maximum = 512) => typeof value === 'string' && !/[\r\n\0]/.test(value)
  ? value.trim().slice(0, maximum) : '';

function checkCancellation(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Claude catalog request was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function contained(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function directoryIdentity(directory, parent) {
  if (parent) await verifyDirectory(parent);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid metadata directory');
  const realPath = await fs.realpath(directory);
  if (parent && !contained(parent.realPath, realPath)) throw new Error('Metadata directory escapes its parent');
  const identity = { directory, realPath, dev: stat.dev, ino: stat.ino, parent };
  await verifyDirectory(identity);
  return identity;
}

async function verifyDirectory(identity) {
  if (identity.parent) await verifyDirectory(identity.parent);
  const stat = await fs.lstat(identity.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino ||
      await fs.realpath(identity.directory) !== identity.realPath ||
      (identity.parent && !contained(identity.parent.realPath, identity.realPath))) {
    throw new Error('Metadata directory changed during the read');
  }
}

async function verifyFileLocation(file, directory) {
  await verifyDirectory(directory);
  if (!contained(directory.realPath, await fs.realpath(file))) throw new Error('Metadata file escapes its directory');
}

async function readMetadataWindow(handle, size, offset, budget, totalSize) {
  const boundaryBytes = offset > 0 ? 1 : 0;
  if (size + boundaryBytes > budget.remaining) throw new Error('Metadata scan limit reached');
  budget.remaining -= size + boundaryBytes;
  let startsAtBoundary = offset === 0;
  if (offset > 0) {
    const previous = Buffer.alloc(1);
    const read = await handle.read(previous, 0, 1, offset - 1);
    startsAtBoundary = read.bytesRead === 1 && previous[0] === 10;
  }
  const buffer = Buffer.alloc(size);
  const { bytesRead } = await handle.read(buffer, 0, size, offset);
  let text = buffer.subarray(0, bytesRead).toString('utf8');
  // Neither a partial leading JSON record nor a trailing unterminated record
  // is needed for the catalog. Large native tool outputs are never returned.
  if (!startsAtBoundary) {
    const newline = text.indexOf('\n');
    if (newline < 0) return [];
    text = text.slice(newline + 1);
  }
  const lines = text.split('\n');
  return offset + bytesRead === totalSize ? lines : lines.slice(0, -1);
}

async function sidecarTitle(projectIdentity, sessionId, budget) {
  await verifyDirectory(projectIdentity);
  const folder = path.join(projectIdentity.directory, sessionId);
  const folderIdentity = await directoryIdentity(folder, projectIdentity);
  const file = path.join(folder, 'custom-title.json');
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 8192 || before.size > budget.remaining) {
    throw new Error('Invalid title metadata');
  }
  await verifyFileLocation(file, folderIdentity);
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('Title changed');
    budget.remaining -= opened.size;
    const buffer = Buffer.alloc(opened.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await fs.lstat(file);
    await verifyFileLocation(file, folderIdentity);
    if (bytesRead !== opened.size || after.isSymbolicLink() || !after.isFile() ||
        after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size) throw new Error('Title changed');
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    return object(value) ? safeText(value.customTitle) : '';
  } finally { await handle.close(); }
}

async function historyMetadata(projectIdentity, filename, budget, signal, warnings) {
  checkCancellation(signal);
  await verifyDirectory(projectIdentity);
  const sessionId = filename.slice(0, -6);
  const file = path.join(projectIdentity.directory, filename);
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Invalid history file');
  await verifyFileLocation(file, projectIdentity);
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('History changed');
    const length = Math.min(opened.size, WINDOW_BYTES);
    const lines = await readMetadataWindow(handle, length, 0, budget, opened.size);
    if (opened.size > WINDOW_BYTES) {
      const offset = Math.max(WINDOW_BYTES, opened.size - WINDOW_BYTES);
      lines.push(...await readMetadataWindow(handle, opened.size - offset, offset, budget, opened.size));
    }
    let title = '';
    let cwd = '';
    let lastActivity = Math.trunc(opened.mtimeMs);
    for (const line of lines) {
      checkCancellation(signal);
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!object(record) || (record.sessionId !== undefined && record.sessionId !== sessionId)) continue;
      // Deliberately omit summaries, firstPrompt, lastPrompt, message.content,
      // assistant outputs, attachments, and tool results.
      if (record.type === 'custom-title') title = safeText(record.customTitle) || title;
      if (!cwd) cwd = safeText(record.cwd, 32768);
      const timestamp = typeof record.timestamp === 'number' ? record.timestamp
        : typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
      if (Number.isFinite(timestamp) && timestamp >= 0) lastActivity = Math.max(lastActivity, Math.trunc(timestamp));
    }
    try { title = await sidecarTitle(projectIdentity, sessionId, budget) || title; }
    catch (error) { if (error.code !== 'ENOENT') warnings.add('Some Claude custom title metadata was unreadable or unsafe; a fallback title is shown.'); }
    const after = await fs.lstat(file);
    await verifyFileLocation(file, projectIdentity);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) throw new Error('History changed');
    return { session_id: sessionId, title, cwd, live: false, last_activity_at: lastActivity, last_contact_at: null };
  } finally { await handle.close(); }
}

/** Metadata-only catalog. Native JSONL bodies are never returned to the model
 * or UI; head/tail reads are bounded even for very large native histories.
 */
export async function listClaudeConversations({ registryDir, projectsDir = path.join(os.homedir(), '.claude', 'projects'),
  stateDir, ownerThreadId, search = '', signal } = {}) {
  validateHistoryOwner(ownerThreadId);
  if (typeof search !== 'string' || search.length > 256) throw new Error('Conversation search must be at most 256 characters.');
  checkCancellation(signal);
  const warnings = new Set();
  const conversations = new Map();
  const nativeProjects = [];
  let rootIdentity;
  const budget = { remaining: MAX_SCAN_BYTES };
  let totalFiles = 0;
  let totalProjects = 0;
  try {
    const root = path.resolve(projectsDir);
    rootIdentity = await directoryIdentity(root);
    const projects = await fs.opendir(root);
    for await (const project of projects) {
      checkCancellation(signal);
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      if (++totalProjects > MAX_PROJECTS) { warnings.add('Some Claude project metadata was omitted because the scan limit was reached.'); break; }
      const directory = path.join(root, project.name);
      try {
        const projectIdentity = await directoryIdentity(directory, rootIdentity);
        const values = [];
        const files = await fs.opendir(directory);
        for await (const file of files) {
          checkCancellation(signal);
          if (!UUID_FILE.test(file.name)) continue;
          if (++totalFiles > MAX_HISTORY_FILES || budget.remaining < WINDOW_BYTES * 2 + 8192) {
            warnings.add('Some Claude conversation metadata was omitted because the bounded scan limit was reached.');
            break;
          }
          try {
            const value = await historyMetadata(projectIdentity, file.name, budget, signal, warnings);
            values.push(value);
          } catch (error) {
            checkCancellation(signal);
            warnings.add('Some Claude conversation metadata was unreadable, changed, or unsafe and was skipped.');
          }
        }
        await verifyDirectory(projectIdentity);
        nativeProjects.push({ identity: projectIdentity, values });
      } catch (error) {
        checkCancellation(signal);
        warnings.add('Some Claude project metadata could not be read.');
      }
      if (totalFiles > MAX_HISTORY_FILES || budget.remaining < WINDOW_BYTES * 2 + 8192) break;
    }
  } catch (error) {
    checkCancellation(signal);
    if (error.code !== 'ENOENT') warnings.add('The Claude project metadata directory is unreadable or is not a real directory.');
  }
  checkCancellation(signal);
  const liveSessions = [];
  try {
    for (const live of discoverClaudeSessions({ registryDir })) {
      try { validateClaudeHistoryId(live.sessionId); } catch { warnings.add('Some live Claude session identifiers are unsupported.'); continue; }
      liveSessions.push(live);
    }
  } catch { warnings.add('The live Claude session registry could not be read.'); }
  const exchange = await scanBridgeExchange({ stateDir, ownerThreadId, signal });
  for (const warning of exchange.warnings) warnings.add(warning);
  // Keep native metadata private until final ancestor checks pass. A root or
  // project replacement cannot authorize following a new junction and cannot
  // turn earlier snapshots into catalog results for a different directory.
  let rootUnchanged = true;
  if (rootIdentity) {
    try { await verifyDirectory(rootIdentity); }
    catch { rootUnchanged = false; warnings.add('The Claude project metadata directory changed during the read; native metadata was skipped.'); }
  }
  if (rootUnchanged) for (const project of nativeProjects) {
    checkCancellation(signal);
    try {
      await verifyDirectory(project.identity);
      for (const value of project.values) {
        const existing = conversations.get(value.session_id);
        if (!existing || (value.last_activity_at ?? 0) > (existing.last_activity_at ?? 0)) conversations.set(value.session_id, value);
      }
    } catch { warnings.add('Some Claude project metadata changed during the read and was skipped.'); }
  }
  if (rootIdentity && rootUnchanged) {
    try { await verifyDirectory(rootIdentity); }
    catch {
      conversations.clear();
      warnings.add('The Claude project metadata directory changed during the read; native metadata was skipped.');
    }
  }
  checkCancellation(signal);
  for (const live of liveSessions) {
    const prior = conversations.get(live.sessionId);
    conversations.set(live.sessionId, { session_id: live.sessionId,
      title: safeText(live.name) || prior?.title || '', cwd: safeText(live.cwd, 32768) || prior?.cwd || '', live: true,
      last_activity_at: prior?.last_activity_at ?? null, last_contact_at: null });
  }
  for (const record of exchange.records) {
    const prior = conversations.get(record.sessionId) ?? { session_id: record.sessionId, title: '', cwd: '', live: false,
      last_activity_at: null, last_contact_at: null };
    prior.last_contact_at = Math.max(prior.last_contact_at ?? 0, record.createdAt);
    conversations.set(record.sessionId, prior);
  }
  const query = search.trim().toLocaleLowerCase();
  const result = [...conversations.values()].filter(value => !query ||
    `${value.title}\n${value.cwd}\n${value.session_id}`.toLocaleLowerCase().includes(query))
    .sort((left, right) => (right.last_contact_at ?? 0) - (left.last_contact_at ?? 0) ||
      (right.last_activity_at ?? 0) - (left.last_activity_at ?? 0) || left.session_id.localeCompare(right.session_id));
  return { conversations: result, warnings: [...warnings] };
}
