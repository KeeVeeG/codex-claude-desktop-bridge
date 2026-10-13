import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeFixture } from './native-helpers.mjs';

const proxyScript = fileURLToPath(new URL('./fixtures/fake-codex-proxy.mjs', import.meta.url));

const queueScript = fileURLToPath(new URL('./fixtures/fake-codex-queue.mjs', import.meta.url));

/** A fake `codex queue`. Returns the {command, args} for queueToTerminalThread and its call log. */
export async function fakeQueue(t, scenario = {}) {
  const fixture = await nativeFixture(t);
  const logFile = path.join(fixture.root, 'queue.log');
  const scenarioFile = path.join(fixture.root, 'queue-scenario.json');
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(scenarioFile, JSON.stringify({ mode: 'ok', ...scenario, logFile }));
  const queue = { command: process.execPath, args: [queueScript, scenarioFile] };
  const queueCalls = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  // A running hang child ends through execFile's timeout or abort. This only affects children that
  // have not read the scenario file yet: they now see a mode that exits.
  t.after(() => { try { fs.writeFileSync(scenarioFile, JSON.stringify({ mode: 'ok', logFile })); } catch {} });
  return { ...fixture, queue, queueCalls };
}

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
