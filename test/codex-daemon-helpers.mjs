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
  // A hang-mode child normally dies to the timeout/abort; this is the backstop. The scenario file
  // is the only handle on it, so switch it to a mode that exits for any late starter.
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
