import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const COMPOSER_ENTER_BEHAVIORS = ['enter', 'cmdIfMultiline', 'cmdAlways'];
const maxConfigBytes = 256 * 1024;

function codexHome({ env = process.env, homeDir = os.homedir() } = {}) {
  const configured = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim();
  return path.resolve(configured || path.join(homeDir, '.codex'));
}

function parseQuoted(value) {
  if (!value.startsWith('"')) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : null;
  } catch { return null; }
}

/** Read only the Codex composer setting; no config file is created or changed. */
export function readComposerEnterBehavior({ env = process.env, homeDir = os.homedir() } = {}) {
  const filename = path.join(codexHome({ env, homeDir }), 'config.toml');
  let stat;
  try {
    stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > maxConfigBytes) return null;
    const text = fs.readFileSync(filename, 'utf8');
    let table = '';
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const tableMatch = line.match(/^\[([^\]]+)\]$/);
      if (tableMatch) { table = tableMatch[1].trim(); continue; }
      const match = line.match(/^(?:desktop\.)?composerEnterBehavior\s*=\s*("(?:\\.|[^"\\])*")\s*(?:#.*)?$/);
      if (!match || (table && table !== 'desktop' && !table.endsWith('.desktop'))) continue;
      const behavior = parseQuoted(match[1]);
      if (COMPOSER_ENTER_BEHAVIORS.includes(behavior)) return behavior;
    }
  } catch { return null; }
  return null;
}
