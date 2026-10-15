// Fake `codex queue`: node fake-codex-queue.mjs <scenario.json> queue --thread <id> --message <text>
import fs from 'node:fs';

const scenario = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const argv = process.argv.slice(3);
fs.appendFileSync(scenario.logFile, `${JSON.stringify({ argv })}\n`);
const threadId = argv[argv.indexOf('--thread') + 1];

switch (scenario.mode) {
  case 'ok':
    console.log(`Queued message 01a13000-0000-7000-8000-000000000001 for thread ${threadId}.`);
    break;
  case 'notfound':
    console.error(`Error: failed to queue session message: thread/queue/add failed: failed to read thread: invalid thread-store request: no rollout found for thread id ${threadId} (code -32603)`);
    process.exitCode = 1;
    break;
  case 'fail':
    console.error('Error: something else broke');
    process.exitCode = 1;
    break;
  case 'garbage':
    console.log('hello');
    break;
  case 'wrongthread':
    console.log('Queued message q1 for thread some-other-id.');
    break;
  case 'hang':
    setInterval(() => {}, 1000);
    break;
  default:
    process.exitCode = 2;
}
