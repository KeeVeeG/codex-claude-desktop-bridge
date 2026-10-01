import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { manualSend, retryManualNotice, readManualRecords } from '../lib/manual-service.mjs';
import { executeBridgeTool } from '../lib/desktop-service.mjs';
import { nativeFixture, mockPipe, encodeFrame, messageTool } from './native-helpers.mjs';

const windowsOnly = { skip: process.platform !== 'win32' && 'Manual native messaging requires verified Windows Desktop sessions.' };
const hash = value => createHash('sha256').update(value).digest('hex');
const recordKey = args => hash(JSON.stringify([args.session_id, args.message_id]));
const processStart = process.platform === 'win32' ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc().ToString()`], { encoding: 'utf8', windowsHide: true }).stdout.trim() : '1';

async function setup(t, { noticeFailure, onNotice } = {}) {
  const fixture = await nativeFixture(t);
  const claude = await mockPipe(t);
  const notices = [];
  const failureMode = { current: noticeFailure };
  const codex = await mockPipe(t, { framed: true, onMessage(message, socket) {
    if (message.method === 'tools/list') {
      socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id,
        result: { tools: failureMode.current === 'schema' ? [] : [messageTool] } }));
      return;
    }
    notices.push(message.params);
    onNotice?.(message.params);
    if (failureMode.current === 'closed') socket.destroy();
    else socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id, result: { success: true, contentItems: [] } }));
  } });
  const registryDir = path.join(fixture.root, 'registry');
  fs.mkdirSync(registryDir);
  const sessionId = randomUUID(), token = randomUUID().replaceAll('-', '');
  const pidDomain = `win32:${os.hostname().toLowerCase()}`;
  fs.writeFileSync(path.join(registryDir, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId, name: 'Manual Claude fixture', cwd: fixture.cwd, entrypoint: 'claude-desktop',
    procStart: processStart, pidDomain, messagingSocketPath: claude.pipePath,
  }));
  const keyPath = path.join(registryDir, `${process.pid}.${hash(claude.pipePath.toLowerCase())}.key`);
  fs.writeFileSync(keyPath, JSON.stringify({ peerToken: token, procStartFt: processStart, pidDomain }));
  const owner = 'manual-owner-task';
  const env = { CODEX_APP_TOOLS_PIPE_PATH: codex.pipePath, CODEX_THREAD_ID: 'untrusted-startup-thread',
    CODEX_CLAUDE_BRIDGE_STATE_DIR: fixture.stateDir, CODEX_CLAUDE_BRIDGE_REGISTRY_DIR: registryDir };
  const context = { env, metadata: { 'x-codex-turn-metadata': { thread_id: owner } } };
  const args = { session_id: sessionId, message: 'Полный текст пользователя: Unicode 🦊\nВторая строка.', message_id: 'manual-fixture-one' };
  const ledgerFile = path.join(fixture.stateDir, 'manual', hash(owner), 'state.json');
  return { ...fixture, claude, codex, notices, failureMode, registryDir, keyPath, owner, args, context, ledgerFile };
}

const userFrames = claude => claude.messages.filter(entry => entry.message.type === 'user');

test('human manual send preserves full text and provenance and posts one context notice only to the verified owning Codex task', windowsOnly, async t => {
  const setup = await setupFixture(t);
  const result = await manualSend(setup.args, setup.context);
  assert.equal(result.message.status, 'submitted');
  assert.equal(result.message.manual, true);
  assert.equal(result.manual, true);
  assert.equal(result.notice_status, 'submitted');
  assert.equal(userFrames(setup.claude).length, 1);
  const received = userFrames(setup.claude)[0].message.message.content;
  assert.match(received, /User manually sending from Codex Desktop task/);
  assert.ok(received.endsWith(setup.args.message));
  assert.equal(setup.notices.length, 1);
  assert.equal(setup.notices[0].threadId, setup.owner);
  assert.equal(setup.notices[0].arguments.threadId, setup.owner);
  assert.ok(setup.notices[0].arguments.prompt.includes(setup.args.session_id));
  assert.ok(setup.notices[0].arguments.prompt.endsWith(setup.args.message));
  assert.match(setup.notices[0].arguments.prompt, /новой задачи или запроса на ответ нет/);
  assert.equal(readManualRecords({ stateDir: setup.stateDir, threadId: setup.owner })[0].notice_status, 'submitted');
  assert.equal(fs.readFileSync(setup.ledgerFile, 'utf8').includes(setup.args.message), false, 'supplementary ledger must not duplicate message bodies');
  const again = await manualSend(setup.args, setup.context);
  assert.equal(again.notice_status, 'submitted');
  assert.equal(userFrames(setup.claude).length, 1);
  assert.equal(setup.notices.length, 1);
});

// Alias avoids shadowing the setup helper with a readable local fixture name.
const setupFixture = setup;

test('concurrent repeated manual IDs never repeat Claude delivery or the owner notice', windowsOnly, async t => {
  const fixture = await setup(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => manualSend(fixture.args, fixture.context)));
  assert.ok(results.some(result => result.notice_status === 'submitted'));
  assert.equal(userFrames(fixture.claude).length, 1);
  assert.equal(fixture.notices.length, 1);
  assert.equal((await manualSend(fixture.args, fixture.context)).notice_status, 'submitted');
});

test('manual ID is bound to exact recipient and full text while independent verified owners may use the same ID', windowsOnly, async t => {
  const fixture = await setup(t);
  await manualSend(fixture.args, fixture.context);
  await assert.rejects(manualSend({ ...fixture.args, message: 'Changed content.' }, fixture.context), /another recipient or message text/);
  const otherOwner = 'another-verified-owner';
  const other = { ...fixture.context, metadata: { 'x-codex-turn-metadata': { thread_id: otherOwner } } };
  assert.equal((await manualSend(fixture.args, other)).notice_status, 'submitted');
  assert.equal(userFrames(fixture.claude).length, 2);
  assert.deepEqual(fixture.notices.map(notice => notice.arguments.threadId), [fixture.owner, otherOwner]);
  assert.equal(readManualRecords({ stateDir: fixture.stateDir, threadId: otherOwner }).length, 1);
});

test('manual interface rejects source spoofing, unverified callers, Claude callers, oversized text, and already cancelled requests before I/O', windowsOnly, async t => {
  const fixture = await setup(t);
  const aborted = new AbortController(); aborted.abort();
  for (const [args, context, error] of [
    [{ ...fixture.args, thread_id: 'another-owner' }, fixture.context, /only session_id/],
    [{ ...fixture.args, sender_id: 'spoof' }, fixture.context, /only session_id/],
    [fixture.args, { ...fixture.context, metadata: {} }, /identity is unavailable/],
    [fixture.args, { ...fixture.context, env: { ...fixture.context.env, CLAUDE_CODE_MESSAGING_SOCKET: fixture.claude.pipePath } }, /only from/],
    [{ ...fixture.args, message: 'Ж'.repeat(32769) }, fixture.context, /65536/],
    [{ ...fixture.args, message_id: '__proto__' }, fixture.context, /valid message_id/],
    [fixture.args, { ...fixture.context, signal: aborted.signal }, /cancelled/],
  ]) await assert.rejects(manualSend(args, context), error);
  assert.equal(userFrames(fixture.claude).length, 0);
  assert.equal(fixture.notices.length, 0);
  assert.equal(fs.existsSync(path.join(fixture.stateDir, 'manual')), false);
});

test('failed Claude resolution produces an honest failed result with no owner notice and no retry on the same ID', windowsOnly, async t => {
  const fixture = await setup(t);
  fs.unlinkSync(fixture.keyPath);
  const failed = await manualSend(fixture.args, fixture.context);
  assert.equal(failed.message.status, 'failed');
  assert.match(failed.message.error, /key/);
  assert.equal(failed.notice_status, 'pending');
  const retry = await manualSend(fixture.args, fixture.context);
  assert.equal(retry.message.status, 'failed');
  assert.equal(userFrames(fixture.claude).length, 0);
  assert.equal(fixture.notices.length, 0);
});

test('definite and uncertain Codex notice failures never resend the Claude message or blindly retry the notice', windowsOnly, async t => {
  for (const [noticeFailure, expected] of [['schema', 'failed'], ['closed', 'uncertain']]) {
    await t.test(noticeFailure, async sub => {
      const fixture = await setup(sub, { noticeFailure });
      const first = await manualSend(fixture.args, fixture.context);
      assert.equal(first.message.status, 'submitted');
      assert.equal(first.notice_status, expected);
      const noticeCount = fixture.notices.length;
      const connectionCount = fixture.codex.connections.length;
      const retry = await manualSend(fixture.args, fixture.context);
      assert.equal(retry.notice_status, expected);
      assert.equal(userFrames(fixture.claude).length, 1);
      assert.equal(fixture.notices.length, noticeCount);
      assert.equal(fixture.codex.connections.length, connectionCount);
    });
  }
});

test('a posted owner notice whose local receipt cannot be saved becomes uncertain and is not repeated', windowsOnly, async t => {
  let posted = false;
  const fixture = await setup(t, { onNotice() { posted = true; } });
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, destination) => {
    if (posted && !injected && destination === fixture.ledgerFile) {
      injected = true;
      throw Object.assign(new Error('Simulated manual receipt write failure'), { code: 'EIO' });
    }
    return originalRename(source, destination);
  };
  let first;
  try { first = await manualSend(fixture.args, fixture.context); }
  finally { fs.renameSync = originalRename; }
  assert.equal(injected, true);
  assert.equal(first.message.status, 'submitted');
  assert.equal(first.notice_status, 'uncertain');
  assert.equal((await manualSend(fixture.args, fixture.context)).notice_status, 'uncertain');
  assert.equal(userFrames(fixture.claude).length, 1);
  assert.equal(fixture.notices.length, 1);
});

test('an abandoned send reservation is uncertain and never invokes either native transport again', windowsOnly, async t => {
  const fixture = await setup(t);
  const route = { from: { kind: 'codex', id: fixture.owner }, to: { kind: 'claude', id: fixture.args.session_id } };
  const record = { message_id: fixture.args.message_id, session_id: fixture.args.session_id,
    fingerprint: hash(JSON.stringify({ direction: 'to_claude', message: fixture.args.message, route })), manual: true,
    send_status: 'sending', notice_status: 'pending', notice_attempted: false,
    sender_pid: 2_147_483_647, createdAt: Date.now(), updatedAt: Date.now() };
  fs.mkdirSync(path.dirname(fixture.ledgerFile), { recursive: true });
  fs.writeFileSync(fixture.ledgerFile, JSON.stringify({ schemaVersion: 1, owner_thread_id: fixture.owner,
    records: { [recordKey(fixture.args)]: record } }));
  const result = await manualSend(fixture.args, fixture.context);
  assert.equal(result.message.status, 'uncertain');
  assert.equal(userFrames(fixture.claude).length, 0);
  assert.equal(fixture.notices.length, 0);
});

test('read-only supplementary history isolates owner records and reports abandoned notices without mutating disk', windowsOnly, async t => {
  const fixture = await setup(t);
  await manualSend(fixture.args, fixture.context);
  const value = JSON.parse(fs.readFileSync(fixture.ledgerFile, 'utf8'));
  const record = value.records[recordKey(fixture.args)];
  record.notice_status = 'pending'; record.notice_attempted = true; record.sender_pid = 2_147_483_647;
  const serialized = JSON.stringify(value);
  fs.writeFileSync(fixture.ledgerFile, serialized);
  assert.equal(readManualRecords({ stateDir: fixture.stateDir, threadId: fixture.owner })[0].notice_status, 'uncertain');
  assert.deepEqual(readManualRecords({ stateDir: fixture.stateDir, threadId: 'other-owner' }), []);
  assert.equal(fs.readFileSync(fixture.ledgerFile, 'utf8'), serialized);
  value.owner_thread_id = 'spoofed-owner'; fs.writeFileSync(fixture.ledgerFile, JSON.stringify(value));
  assert.throws(() => readManualRecords({ stateDir: fixture.stateDir, threadId: fixture.owner }), /invalid owner/);
});

test('manual and automatic messages cannot relabel or reuse one another sending origin', windowsOnly, async t => {
  const fixture = await setup(t);
  await executeBridgeTool('send_to_claude', fixture.args, fixture.context);
  await assert.rejects(manualSend(fixture.args, fixture.context), /outside the manual interface/);
  const manualArgs = { ...fixture.args, message_id: 'different-manual-id' };
  await manualSend(manualArgs, fixture.context);
  await assert.rejects(executeBridgeTool('send_to_claude', manualArgs, fixture.context), /different sending origin/);
  assert.equal(userFrames(fixture.claude).length, 2);
  assert.equal(fixture.notices.length, 1);
});

test('one verified owner can manually send the same ID independently to two exact live Claude recipients', windowsOnly, async t => {
  const fixture = await setup(t);
  const secondClaude = await mockPipe(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const exit = new Promise(resolve => child.once('exit', resolve));
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  t.after(async () => { child.kill(); await exit; });
  const secondSessionId = randomUUID();
  const start = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${child.pid}).StartTime.ToFileTimeUtc().ToString()`], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  const pidDomain = `win32:${os.hostname().toLowerCase()}`;
  fs.writeFileSync(path.join(fixture.registryDir, `${child.pid}.json`), JSON.stringify({
    pid: child.pid, sessionId: secondSessionId, name: 'Second manual recipient', cwd: fixture.cwd,
    entrypoint: 'claude-desktop', procStart: start, pidDomain, messagingSocketPath: secondClaude.pipePath,
  }));
  fs.writeFileSync(path.join(fixture.registryDir, `${child.pid}.${hash(secondClaude.pipePath.toLowerCase())}.key`),
    JSON.stringify({ peerToken: randomUUID().replaceAll('-', ''), procStartFt: start, pidDomain }));
  const secondArgs = { ...fixture.args, session_id: secondSessionId };
  assert.equal((await manualSend(fixture.args, fixture.context)).notice_status, 'submitted');
  assert.equal((await manualSend(secondArgs, fixture.context)).notice_status, 'submitted');
  await manualSend(fixture.args, fixture.context);
  await manualSend(secondArgs, fixture.context);
  assert.equal(userFrames(fixture.claude).length, 1);
  assert.equal(userFrames(secondClaude).length, 1);
  assert.equal(fixture.notices.length, 2);
  assert.equal(readManualRecords({ stateDir: fixture.stateDir, threadId: fixture.owner }).length, 2);
});

test('explicit notice retry after definite failure restores full context without resending Claude', windowsOnly, async t => {
  const fixture = await setup(t, { noticeFailure: 'schema' });
  const first = await manualSend(fixture.args, fixture.context);
  assert.equal(first.message.status, 'submitted');
  assert.equal(first.notice_status, 'failed');
  assert.equal(first.notice_retryable, true);
  fixture.failureMode.current = null;
  const args = { session_id: fixture.args.session_id, message_id: fixture.args.message_id };
  const retried = await retryManualNotice(args, fixture.context);
  assert.equal(retried.message.status, 'submitted');
  assert.equal(retried.notice_status, 'submitted');
  assert.equal(retried.notice_retryable, false);
  assert.equal(userFrames(fixture.claude).length, 1);
  assert.equal(fixture.notices.length, 1);
  assert.ok(fixture.notices[0].arguments.prompt.endsWith(fixture.args.message));
  assert.equal(fixture.notices[0].arguments.threadId, fixture.owner);
  await assert.rejects(retryManualNotice(args, fixture.context), /not safely retryable/);
  await assert.rejects(retryManualNotice({ ...args, message: 'Injected replacement text.' }, fixture.context), /only session_id/);
  await assert.rejects(retryManualNotice(args, { ...fixture.context,
    metadata: { 'x-codex-turn-metadata': { thread_id: 'another-owner' } } }), /confirmed submitted manual message/);
  assert.equal(fixture.notices.length, 1);
});

test('double-click notice retry claims one definite failed notice and cannot duplicate its submission', windowsOnly, async t => {
  const fixture = await setup(t, { noticeFailure: 'schema' });
  await manualSend(fixture.args, fixture.context);
  fixture.failureMode.current = null;
  const args = { session_id: fixture.args.session_id, message_id: fixture.args.message_id };
  const results = await Promise.allSettled([retryManualNotice(args, fixture.context), retryManualNotice(args, fixture.context)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(fixture.notices.length, 1);
  assert.equal(userFrames(fixture.claude).length, 1);
});

test('uncertain owner notice is never explicitly retryable and keeps the original Claude delivery intact', windowsOnly, async t => {
  const fixture = await setup(t, { noticeFailure: 'closed' });
  const result = await manualSend(fixture.args, fixture.context);
  assert.equal(result.notice_status, 'uncertain');
  assert.equal(result.notice_retryable, false);
  fixture.failureMode.current = null;
  await assert.rejects(retryManualNotice({ session_id: fixture.args.session_id, message_id: fixture.args.message_id }, fixture.context), /not safely retryable/);
  assert.equal(fixture.notices.length, 1);
  assert.equal(userFrames(fixture.claude).length, 1);
});

test('missing supplementary notice history cannot authorize a duplicate notice or Claude send', windowsOnly, async t => {
  const fixture = await setup(t);
  await manualSend(fixture.args, fixture.context);
  fs.unlinkSync(fixture.ledgerFile);
  const retry = await manualSend(fixture.args, fixture.context);
  assert.equal(retry.message.status, 'submitted');
  assert.equal(retry.notice_status, 'uncertain');
  assert.equal(retry.notice_retryable, false);
  assert.match(retry.notice_error, /record is missing/);
  assert.equal(userFrames(fixture.claude).length, 1);
  assert.equal(fixture.notices.length, 1);
});
