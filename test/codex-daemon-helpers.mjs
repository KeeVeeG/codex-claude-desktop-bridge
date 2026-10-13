import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeFixture } from './native-helpers.mjs';

const proxyScript = fileURLToPath(new URL('./fixtures/fake-codex-proxy.mjs', import.meta.url));

/** Start a scripted fake daemon. Returns the {command, args} accepted by openDaemon. */
export async function fakeDaemon(t, scenario = {}) {
  const fixture = await nativeFixture(t);
  const logFile = path.join(fixture.root, 'daemon.log');
  const scenarioFile = path.join(fixture.root, 'scenario.json');
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(scenarioFile, JSON.stringify({ threads: [], ...scenario, logFile }));
  return {
    ...fixture,
    daemon: { command: process.execPath, args: [proxyScript, scenarioFile] },
    requests: () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}
