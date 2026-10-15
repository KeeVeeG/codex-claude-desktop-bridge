import { posix } from 'node:path';

/** Canonical local IPC addresses, without probing or resolving filesystem links. */
export function canonicalLocalSocket(socketPath, platform = process.platform) {
  if (typeof socketPath !== 'string' || !socketPath || /[\r\n\0]/.test(socketPath)) return null;
  if (platform === 'win32') {
    const match = /^[\\/]{2}[.?][\\/]pipe[\\/](?:(LOCAL)[\\/])?([^\\/]+)$/i.exec(socketPath);
    if (!match || ['.', '..'].includes(match[2]) || /[. ]$/.test(match[2])) return null;
    if (socketPath.startsWith('\\\\?\\') && socketPath.includes('/')) return null;
    const name = `${match[1] ? 'LOCAL\\' : ''}${match[2]}`.replace(/[A-Z]/g, letter => letter.toLowerCase());
    return `\\\\.\\pipe\\${name}`;
  }
  // sun_path is byte-sized. Older supported Node versions truncate paths that
  // exceed this boundary, which could connect to a different local address.
  const maxBytes = platform === 'darwin' ? 103 : platform === 'linux' ? 107 : 0;
  if (!maxBytes || !posix.isAbsolute(socketPath) || Buffer.byteLength(socketPath, 'utf8') > maxBytes ||
      posix.resolve(socketPath) !== socketPath || socketPath.endsWith('/')) return null;
  return socketPath;
}
