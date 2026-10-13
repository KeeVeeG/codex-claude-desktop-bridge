// Locate the native Codex executable without a shell. `codex.cmd` shims cannot be
// spawned safely without shell:true, so resolve the vendored codex.exe beside them.
import fs from 'node:fs';
import path from 'node:path';

const VENDORED = path.join('node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64',
  'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');

export function resolveCodexExecutable({ env = process.env, exists = fs.existsSync } = {}) {
  const override = env.CODEX_CLAUDE_BRIDGE_CODEX_BIN;
  if (override) return exists(override) ? override : null;
  const directories = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const direct = path.join(directory, 'codex.exe');
    if (exists(direct)) return direct;
    if (exists(path.join(directory, 'codex.cmd'))) {
      const vendored = path.join(directory, VENDORED);
      if (exists(vendored)) return vendored;
    }
  }
  return null;
}
