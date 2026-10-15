import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';

/** Verify the registry's creation token against the actual local process.
 * The injectable probe and platform keep OS policy tests independent of the host.
 */
export function assertClaudeProcessIdentity(record, { platform = process.platform,
  hostName = hostname(), spawn = spawnSync } = {}) {
  if (!['win32', 'darwin'].includes(platform)) {
    throw new Error('Verified Claude process identity is supported only on Windows and macOS.');
  }
  const expectedDomain = platform === 'win32' ? `win32:${hostName.toLowerCase()}` : 'darwin';
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || record.pidDomain !== expectedDomain ||
      typeof record.procStart !== 'string' || !record.procStart ||
      (platform === 'win32' && !/^[0-9]+$/.test(record.procStart))) {
    throw new Error('Claude session belongs to a different process namespace or has invalid creation metadata.');
  }
  // Only the validated PID is passed to the OS; keys, sockets and messages are not.
  const result = platform === 'win32'
    ? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${record.pid} -ErrorAction Stop).StartTime.ToFileTimeUtc().ToString()`],
    { encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 16_384 })
    : spawn('/bin/ps', ['-o', 'lstart=', '-p', String(record.pid)],
      { encoding: 'utf8', timeout: 1_000, maxBuffer: 16_384, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.trim() !== record.procStart) {
    throw new Error('Claude session is offline or its process identity changed. Open the intended Code session again.');
  }
}
