import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createSession, processAlive, readSession, updateSession } from '../lib/store.mjs';
import { nativeFixture as fixture } from './native-helpers.mjs';

const storeUrl = new URL('../lib/store.mjs', import.meta.url).href;
const DEAD_PID = 2_147_483_647;

function worker(t, script, args) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let readyResolve;
  let readyReject;
  let isReady = false;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise((resolve, reject) => {
    child.on('error', error => { readyReject(error); reject(error); });
    child.on('exit', (code, signal) => {
      if (!isReady) readyReject(new Error(`Worker exited before ready (${code ?? signal}): ${stderr}`));
      resolve({ code, signal, stdout, stderr });
    });
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => {
    stdout += text;
    if (!isReady && stdout.includes('ready\n')) { isReady = true; readyResolve(); }
  });
  child.stderr.on('data', text => { stderr += text; });
  const watchdog = setTimeout(() => child.kill(), 15_000);
  exited.finally(() => clearTimeout(watchdog));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return { child, ready, exited };
}

test('simultaneous crash recovery never unlinks a replacement lock or loses updates', { timeout: 20_000 }, async t => {
  assert.equal(processAlive(DEAD_PID), false);
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 'contended-recovery' });
  const lock = path.join(session.dir, 'state.lock');
  const gate = path.join(setup.root, 'start');
  const sentinel = path.join(setup.root, 'critical-section');
  fs.writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, token: 'dead-owner' }));
  const script = `
    import fs from 'node:fs';
    import { loadSession, updateSession } from ${JSON.stringify(storeUrl)};
    const [stateDir, sessionKey, gate, sentinel, lock] = process.argv.slice(1);
    const session = loadSession({ stateDir, sessionKey });
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const originalRead = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      const result = originalRead.call(this, file, ...args);
      // Hold a stale observation long enough for concurrent recovery attempts.
      // A compare-then-unlink implementation can delete the next owner's lock.
      if (file === lock && String(result).includes('dead-owner')) Atomics.wait(sleeper, 0, 0, 35);
      return result;
    };
    process.stdout.write('ready\\n');
    while (!fs.existsSync(gate)) Atomics.wait(sleeper, 0, 0, 5);
    for (let count = 0; count < 25; count++) {
      updateSession(session, state => {
        fs.writeFileSync(sentinel, String(process.pid), { flag: 'wx' });
        try {
          Atomics.wait(sleeper, 0, 0, 2);
          state.counter = (state.counter ?? 0) + 1;
        } finally { fs.unlinkSync(sentinel); }
      });
    }
  `;
  const workers = Array.from({ length: 8 }, () => worker(t, script, [setup.stateDir, session.key, gate, sentinel, lock]));
  await Promise.all(workers.map(item => item.ready));
  fs.writeFileSync(gate, 'go');
  const results = await Promise.all(workers.map(item => item.exited));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(readSession(session).counter, 200);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(path.join(session.dir, 'state.lock.recovery')), false);
});

test('an old live owner is waited for and never stolen', { timeout: 15_000 }, async t => {
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 'live-owner' });
  const lock = path.join(session.dir, 'state.lock');
  const gate = path.join(setup.root, 'release-owner');
  const owner = worker(t, `
    import fs from 'node:fs';
    import { loadSession, updateSession } from ${JSON.stringify(storeUrl)};
    const [stateDir, sessionKey, gate, lock] = process.argv.slice(1);
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    updateSession(loadSession({ stateDir, sessionKey }), state => {
      const old = new Date(Date.now() - 120_000);
      fs.utimesSync(lock, old, old);
      process.stdout.write('ready\\n');
      while (!fs.existsSync(gate)) Atomics.wait(sleeper, 0, 0, 5);
      state.counter = (state.counter ?? 0) + 1;
    });
  `, [setup.stateDir, session.key, gate, lock]);
  await owner.ready;
  const originalLock = fs.readFileSync(lock, 'utf8');
  const contender = worker(t, `
    import { loadSession, updateSession } from ${JSON.stringify(storeUrl)};
    const [stateDir, sessionKey] = process.argv.slice(1);
    process.stdout.write('ready\\n');
    updateSession(loadSession({ stateDir, sessionKey }), state => { state.counter = (state.counter ?? 0) + 1; });
  `, [setup.stateDir, session.key]);
  await contender.ready;
  await delay(150);
  assert.equal(fs.readFileSync(lock, 'utf8'), originalLock);
  assert.equal(contender.child.exitCode, null);
  fs.writeFileSync(gate, 'release');
  for (const result of await Promise.all([owner.exited, contender.exited])) assert.equal(result.code, 0, result.stderr);
  assert.equal(readSession(session).counter, 2);
});

test('a crashed recovery guard stops safely without removing either lock', async t => {
  assert.equal(processAlive(DEAD_PID), false);
  const setup = await fixture(t);
  const session = createSession({ ...setup, threadId: 'interrupted-recovery' });
  const lock = path.join(session.dir, 'state.lock');
  const recovery = path.join(session.dir, 'state.lock.recovery');
  const staleLock = JSON.stringify({ pid: DEAD_PID, token: 'dead-lock' });
  const staleRecovery = JSON.stringify({ pid: DEAD_PID, token: 'dead-recovery' });
  fs.writeFileSync(lock, staleLock);
  fs.writeFileSync(recovery, staleRecovery);
  assert.throws(() => updateSession(session, state => { state.unexpected = true; }), /recovery was interrupted/);
  assert.equal(fs.readFileSync(lock, 'utf8'), staleLock);
  assert.equal(fs.readFileSync(recovery, 'utf8'), staleRecovery);
  assert.equal(readSession(session).unexpected, undefined);
});
