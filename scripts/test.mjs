import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Explicit discovery keeps scratch copies and release builds outside the suite.
// Pass concrete paths so Node 20 on Windows does not need shell glob expansion.
const root = fileURLToPath(new URL('../', import.meta.url));
const tests = fs.readdirSync(path.join(root, 'test'))
  .filter(name => name.endsWith('.test.mjs')).sort().map(name => path.join(root, 'test', name));
if (!tests.length) throw new Error('No tests found in test/.');
// The lock-recovery stress tests already run several child processes. Running
// every file concurrently can exhaust their bounded lock-acquisition deadline.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
