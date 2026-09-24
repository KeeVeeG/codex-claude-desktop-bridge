import { connect } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { spawnSync } from 'node:child_process';

// Claude Code 2.1.280 inbox transport. The public documentation covers the
// socket and authentication; this user-frame shape is verified against that
// installed version. Keep it separate from the bridge's application protocol.
const MAX_FRAME_CHARS = 1_048_576;
const MAX_CONNECTION_MS = 10_000;

export function canonicalClaudeSocket(socketPath) {
  if (typeof socketPath !== 'string' || /[\r\n\0]/.test(socketPath)) return null;
  const match = /^[\\/]{2}[.?][\\/]pipe[\\/](?:(LOCAL)[\\/])?([^\\/]+)$/i.exec(socketPath);
  if (!match || ['.', '..'].includes(match[2]) || /[. ]$/.test(match[2])) return null;
  if (socketPath.startsWith('\\\\?\\') && socketPath.includes('/')) return null;
  const name = `${match[1] ? 'LOCAL\\' : ''}${match[2]}`.replace(/[A-Z]/g, letter => letter.toLowerCase());
  return `\\\\.\\pipe\\${name}`;
}

const canonicalPipe = canonicalClaudeSocket;

function checkEndpoint(socketPath) {
  if (typeof socketPath !== 'string' || !socketPath || /[\r\n\0]/.test(socketPath)) {
    throw new Error('Claude messaging socket is missing or invalid. Pair from the intended Claude Code session.');
  }
  const localPipe = canonicalPipe(socketPath) !== null;
  if (process.platform === 'win32' ? !localPipe : !localPipe && !isAbsolute(socketPath)) {
    throw new Error('Claude messaging endpoint must be a local named pipe on Windows or an absolute Unix socket path.');
  }
}

function registryLocation(registryDir) {
  const directory = resolve(registryDir ?? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'sessions'));
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Claude session registry must be a real directory.');
  return directory;
}

function readRegularJson(file, maxBytes) {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
    throw new Error('Claude registry entry is not a regular file of the expected size.');
  }
  const fd = openSync(file, 'r');
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) {
      throw new Error('Claude registry entry changed while it was opened.');
    }
    const data = Buffer.alloc(maxBytes + 1);
    const bytesRead = readSync(fd, data, 0, data.length, 0);
    if (bytesRead > maxBytes) throw new Error('Claude registry entry exceeds its size limit.');
    const after = lstatSync(file);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error('Claude registry entry changed while it was read.');
    }
    const value = JSON.parse(data.subarray(0, bytesRead).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Claude registry entry.');
    return value;
  } finally {
    closeSync(fd);
  }
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function metadata(record) {
  return {
    sessionId: record.sessionId,
    pid: record.pid,
    name: record.name ?? '',
    cwd: record.cwd ?? '',
    status: record.status ?? 'unknown',
    version: record.version ?? '',
    entrypoint: record.entrypoint,
    hostSessionId: record.hostSessionId ?? null,
    procStart: record.procStart,
    pidDomain: record.pidDomain,
  };
}

function desktopRecords(directory) {
  const records = [];
  for (const filename of readdirSync(directory)) {
    const match = /^([1-9][0-9]*)\.json$/.exec(filename);
    if (!match) continue;
    let record;
    try { record = readRegularJson(join(directory, filename), 65_536); } catch { continue; }
    if (record.pid !== Number(match[1]) || !Number.isSafeInteger(record.pid) || record.pid <= 0) continue;
    if (record.entrypoint !== 'claude-desktop' || typeof record.sessionId !== 'string' || !record.sessionId) continue;
    if (typeof record.procStart !== 'string' || !record.procStart || typeof record.pidDomain !== 'string') continue;
    if (!canonicalPipe(record.messagingSocketPath) || !processIsAlive(record.pid)) continue;
    records.push(record);
  }
  return records;
}

/** List live native Claude Desktop Code sessions without exposing credentials or endpoints. */
export function discoverClaudeSessions({ registryDir } = {}) {
  let directory;
  try { directory = registryLocation(registryDir); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return desktopRecords(directory).map(metadata);
}

function assertProcessStart(record) {
  if (process.platform !== 'win32') return;
  const expectedDomain = `win32:${hostname().toLowerCase()}`;
  if (record.pidDomain !== expectedDomain || !/^[0-9]+$/.test(record.procStart)) {
    throw new Error('Claude session belongs to a different process namespace or has invalid creation metadata.');
  }
  // A numeric PID is validated above, and only its creation time is queried.
  // No credential or endpoint is passed to the shell.
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${record.pid} -ErrorAction Stop).StartTime.ToFileTimeUtc().ToString()`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 16_384 });
  if (result.error || result.status !== 0 || result.stdout.trim() !== record.procStart) {
    throw new Error('Claude session is offline or its process identity changed. Open the intended Code session again.');
  }
}

/** Resolve one explicitly chosen desktop session. Its key is read only at send
 * time, never copied into bridge configuration or included in diagnostics.
 */
export function resolveClaudeSession(sessionId, { registryDir } = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('An explicit Claude session ID is required.');
  const directory = registryLocation(registryDir);
  const records = desktopRecords(directory).filter(record => record.sessionId === sessionId);
  if (records.length === 0) throw new Error('The chosen Claude Desktop Code session is unavailable or has no live inbox.');
  if (records.length !== 1) throw new Error('More than one process claims this Claude session. Close the duplicate before connecting.');
  const record = records[0];
  assertProcessStart(record);
  const socketPath = canonicalPipe(record.messagingSocketPath);
  const keyHash = createHash('sha256').update(socketPath).digest('hex');
  let key;
  try { key = readRegularJson(join(directory, `${record.pid}.${keyHash}.key`), 4096); } catch {
    throw new Error('The chosen Claude session has no readable regular inbox key. Reopen that Code session.');
  }
  if (typeof key.peerToken !== 'string' || !/^[a-f0-9]{32}$/.test(key.peerToken) ||
      key.procStartFt !== record.procStart || key.pidDomain !== record.pidDomain) {
    throw new Error('Claude inbox key does not match the selected session process.');
  }
  // Catch a restart or registry replacement that occurred during the key read.
  const current = readRegularJson(join(directory, `${record.pid}.json`), 65_536);
  if (current.sessionId !== record.sessionId || current.pid !== record.pid || current.procStart !== record.procStart ||
      current.pidDomain !== record.pidDomain || canonicalPipe(current.messagingSocketPath) !== socketPath || !processIsAlive(record.pid)) {
    throw new Error('Claude session changed while resolving its inbox. Retry after it finishes restarting.');
  }
  return { ...metadata(record), socketPath, token: key.peerToken };
}

/** Identify the Claude Code conversation that spawned this bridge instance.
 * Only the direct registered parent is accepted. An exported socket must match
 * that parent; neither project paths nor recency identify a calling session.
 */
export function resolveClaudeCaller({ registryDir, parentPid = process.ppid,
  socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET } = {}) {
  let directory;
  try { directory = registryLocation(registryDir); } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Claude caller is unavailable. Open the bridge in the intended Claude Desktop Code session.');
    throw error;
  }
  const ownSocket = socketPath === undefined ? null : canonicalClaudeSocket(socketPath);
  if (socketPath !== undefined && !ownSocket) throw new Error('Claude caller exported an invalid messaging socket. Reload the bridge in that Code session.');
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw new Error('Claude caller has no valid direct parent process. Reload the bridge from the intended Code session.');
  }
  const matches = desktopRecords(directory).filter(record => record.pid === parentPid &&
    (!ownSocket || canonicalClaudeSocket(record.messagingSocketPath) === ownSocket));
  if (matches.length === 0) {
    throw new Error('Cannot identify the calling Claude Desktop Code session from its direct parent and socket. Reload its bridge MCP server; launch it directly without an intermediary shell.');
  }
  if (matches.length !== 1) throw new Error('Claude caller identity is ambiguous; more than one session claims its messaging endpoint.');
  const matched = matches[0];
  const endpoint = resolveClaudeSession(matched.sessionId, { registryDir: directory });
  if (endpoint.pid !== matched.pid || endpoint.socketPath !== canonicalClaudeSocket(matched.messagingSocketPath)) {
    throw new Error('Claude caller changed while resolving its identity. Reload the bridge in that Code session.');
  }
  return endpoint;
}

function checkToken(token) {
  if (typeof token !== 'string' || !token.trim() || token.length > 4096 || /[\r\n\0]/.test(token)) {
    throw new Error('Claude messaging token is missing or invalid. Pair from the intended Claude Code session.');
  }
}

/** Read only the credentials exported by the Claude session running this command.
 * Never print the returned token, and never discover a different session's key.
 */
export function getClaudeEnvironment(env = process.env) {
  const socketPath = env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN;
  checkEndpoint(socketPath);
  checkToken(token);
  return { socketPath, token };
}

/** Write one authenticated message. This protocol does not acknowledge delivery
 * to the model: a successful result confirms only the completed transport write.
 * A later reply is a separate, optional bridge message.
 */
export async function sendToClaude({ socketPath, token, message, senderName = 'Codex desktop bridge', sessionId }) {
  checkEndpoint(socketPath);
  checkToken(token);
  if (typeof message !== 'string' || !message.trim()) throw new Error('Claude message must be nonempty text.');
  if (typeof senderName !== 'string' || !senderName.trim() || senderName.length > 200 || /[\r\n\0]/.test(senderName)) {
    throw new Error('senderName must be one line of text, at most 200 characters.');
  }
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200)) {
    throw new Error('sessionId must identify the explicitly selected Claude session.');
  }
  const messageId = randomUUID();
  const authLine = JSON.stringify({ type: 'auth', token });
  const messageLine = JSON.stringify({
    type: 'user',
    uuid: messageId,
    priority: 'next',
    from: senderName,
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    message: { role: 'user', content: message },
  });
  // The receiver checks the accumulated UTF-16 string before splitting lines,
  // so limit the entire write, including the auth line and delimiters.
  if (authLine.length + messageLine.length + 2 > MAX_FRAME_CHARS) {
    throw new Error('Claude message exceeds the inbox transport limit. Send a shorter message.');
  }
  const payload = `${authLine}\n${messageLine}\n`;
  return await new Promise((resolveSend, rejectSend) => {
    let finished = false;
    let writeFinished = false;
    let writeAttempted = false;
    let remoteEnded = false;
    const socket = connect({ path: socketPath, allowHalfOpen: true });
    const timeout = setTimeout(() => finish(new Error('Claude inbox connection timed out. Check that the paired Code session is open.')), MAX_CONNECTION_MS);

    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) {
        error.deliveryUnknown = writeAttempted;
        rejectSend(error);
      }
      else resolveSend({ status: 'written', messageId, acknowledged: false });
    }

    socket.on('error', error => {
      // Do not include the endpoint, token, payload, or OS error text in logs.
      const code = typeof error.code === 'string' ? error.code : 'CONNECTION_ERROR';
      finish(new Error(`Cannot write to the paired Claude Code session (${code}). Pair again if that session restarted.`));
    });
    socket.once('connect', () => {
      writeAttempted = true;
      socket.end(payload);
    });
    socket.once('finish', () => {
      writeFinished = true;
      if (remoteEnded) finish();
    });
    socket.on('data', () => {
      // No response frames are defined by the own-child inbox protocol.
    });
    socket.once('end', () => {
      remoteEnded = true;
      if (writeFinished) finish();
    });
    socket.once('close', hadError => {
      if (finished) return;
      if (!hadError && writeFinished && remoteEnded) finish();
      else finish(new Error('Claude inbox closed before the transport write completed.'));
    });
  });
}
