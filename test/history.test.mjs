import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { listClaudeConversations } from '../lib/claude-history.mjs';
import { getBridgeConversation, scanBridgeExchange } from '../lib/bridge-history.mjs';
import { createSession, recordMessage, finishMessage, updateSession } from '../lib/store.mjs';
import { nativeFixture } from './native-helpers.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function ledger(fixture, owner) {
  fs.mkdirSync(fixture.stateDir, { recursive: true });
  return createSession({ stateDir: fixture.stateDir, threadId: owner, cwd: fixture.cwd });
}
function message(session, from, to, id, text, status = 'submitted', manual = false) {
  const route = { from, to };
  const saved = recordMessage(session, { id, direction: `to_${to.kind}`, message: text, route, manual }).message;
  return finishMessage(session, saved.id, { route, status });
}
function writeHistory(project, sessionId, records, newline = true) {
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), records.map(value => JSON.stringify(value)).join('\n') + (newline ? '\n' : ''));
}

test('bridge exchange joins both directions only for the exact owner and Claude route', async t => {
  const fixture = await nativeFixture(t);
  const sessionId = randomUUID();
  const otherSession = randomUUID();
  const outgoing = ledger(fixture, 'owning-task');
  const incoming = ledger(fixture, `claude:${sessionId}`);
  const unrelated = ledger(fixture, 'another-task');
  message(outgoing, { kind: 'codex', id: 'owning-task' }, { kind: 'claude', id: sessionId }, 'outgoing', 'Full user message.\nUnicode: Привет', 'submitted', true);
  message(incoming, { kind: 'claude', id: sessionId }, { kind: 'codex', id: 'owning-task' }, 'incoming', 'Full Claude reply.', 'uncertain');
  message(outgoing, { kind: 'codex', id: 'owning-task' }, { kind: 'claude', id: otherSession }, 'elsewhere', 'Other recipient');
  message(incoming, { kind: 'claude', id: sessionId }, { kind: 'codex', id: 'another-task' }, 'other-owner', 'Reply for another owner');
  message(unrelated, { kind: 'codex', id: 'owning-task' }, { kind: 'claude', id: sessionId }, 'spoofed-owner', 'Do not expose a misowned record');
  const result = await getBridgeConversation({ stateDir: fixture.stateDir, ownerThreadId: 'owning-task', sessionId });
  assert.deepEqual(result.messages.map(value => value.id).sort(), ['incoming', 'outgoing']);
  assert.equal(result.messages.find(value => value.id === 'incoming').status, 'uncertain');
  assert.equal(result.messages.find(value => value.id === 'outgoing').manual, true);
  assert.equal(result.messages.find(value => value.id === 'outgoing').message, 'Full user message.\nUnicode: Привет');
  assert.doesNotMatch(JSON.stringify(result), /fingerprint|senderPid|procStart|spoofed-owner|Other recipient|Reply for another owner/);
  assert.equal(result.next_cursor, null);
  assert.equal(result.has_more, false);
});

test('history pagination reaches every message once even when timestamps and IDs overlap across directions', async t => {
  const fixture = await nativeFixture(t);
  const sessionId = randomUUID();
  const outgoing = ledger(fixture, 'pagination-owner');
  const incoming = ledger(fixture, `claude:${sessionId}`);
  for (let index = 0; index < 12; index++) {
    const id = `message-${String(index).padStart(2, '0')}`;
    message(outgoing, { kind: 'codex', id: 'pagination-owner' }, { kind: 'claude', id: sessionId }, id, `out ${index}`);
    message(incoming, { kind: 'claude', id: sessionId }, { kind: 'codex', id: 'pagination-owner' }, id, `in ${index}`);
  }
  for (const session of [outgoing, incoming]) updateSession(session, state => {
    for (const value of Object.values(state.messages)) value.createdAt = 123456;
  });
  const complete = await getBridgeConversation({ stateDir: fixture.stateDir, ownerThreadId: 'pagination-owner', sessionId, limit: 200 });
  let cursor;
  let collected = [];
  do {
    const page = await getBridgeConversation({ stateDir: fixture.stateDir, ownerThreadId: 'pagination-owner', sessionId, limit: 3, cursor });
    collected = [...page.messages, ...collected];
    cursor = page.next_cursor;
    assert.equal(page.has_more, cursor !== null);
  } while (cursor);
  assert.deepEqual(collected, complete.messages);
  assert.equal(collected.length, 24);
  const first = await getBridgeConversation({ stateDir: fixture.stateDir, ownerThreadId: 'pagination-owner', sessionId, limit: 1 });
  await assert.rejects(getBridgeConversation({ stateDir: fixture.stateDir, ownerThreadId: 'another-owner', sessionId, cursor: first.next_cursor }), /Invalid conversation cursor/);
  await assert.rejects(getBridgeConversation({ stateDir: fixture.stateDir, ownerThreadId: 'pagination-owner', sessionId: randomUUID(), cursor: first.next_cursor }), /Invalid conversation cursor/);
  await assert.rejects(getBridgeConversation({ stateDir: fixture.stateDir, ownerThreadId: 'pagination-owner', sessionId, cursor: '../state.json' }), /Invalid conversation cursor/);
});

test('catalog indexes bounded native metadata, titles and live sessions without returning transcript text', async t => {
  const fixture = await nativeFixture(t);
  const sessionId = randomUUID();
  const oldSession = randomUUID();
  const projectsDir = path.join(fixture.root, 'projects');
  const project = path.join(projectsDir, 'encoded-project');
  const secret = 'SECRET_NATIVE_TRANSCRIPT';
  writeHistory(project, sessionId, [
    { type: 'user', sessionId, cwd: fixture.cwd, timestamp: '2026-01-02T03:04:05Z', message: { content: secret } },
    { type: 'custom-title', sessionId, customTitle: 'Old native title' },
    { type: 'assistant', sessionId, message: { content: `${secret}${'x'.repeat(1024 * 1024)}` } },
    { type: 'custom-title', sessionId, customTitle: 'Tail native title' },
  ], false);
  fs.mkdirSync(path.join(project, sessionId));
  fs.writeFileSync(path.join(project, sessionId, 'custom-title.json'), JSON.stringify({ customTitle: 'Reference conversation' }));
  writeHistory(project, oldSession, [{ type: 'custom-title', sessionId: oldSession, customTitle: 'Archived native title' }]);
  writeHistory(path.join(project, 'subagents'), randomUUID(), [{ type: 'custom-title', customTitle: 'Do not index subagent' }]);
  const registryDir = path.join(fixture.root, 'sessions');
  fs.mkdirSync(registryDir);
  fs.writeFileSync(path.join(registryDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid,
    sessionId, entrypoint: 'claude-desktop', procStart: '1', pidDomain: 'fixture',
    messagingSocketPath: '\\\\.\\pipe\\fixture-history-session', cwd: fixture.cwd, name: 'Live reference conversation' }));
  const ownLedger = ledger(fixture, 'catalog-owner');
  message(ownLedger, { kind: 'codex', id: 'catalog-owner' }, { kind: 'claude', id: oldSession }, 'contact', 'Sent through bridge');
  const result = await listClaudeConversations({ projectsDir, registryDir, stateDir: fixture.stateDir, ownerThreadId: 'catalog-owner' });
  assert.equal(result.conversations.length, 2);
  const live = result.conversations.find(value => value.session_id === sessionId);
  assert.equal(live.title, 'Live reference conversation');
  assert.equal(live.live, true);
  assert.equal(live.cwd, fixture.cwd);
  const old = result.conversations.find(value => value.session_id === oldSession);
  assert.equal(old.title, 'Archived native title');
  assert.equal(old.live, false);
  assert.equal(typeof old.last_contact_at, 'number');
  assert.doesNotMatch(JSON.stringify(result), /SECRET_NATIVE_TRANSCRIPT|Do not index subagent|Sent through bridge|senderPid|messagingSocketPath/);
  const filtered = await listClaudeConversations({ projectsDir, registryDir, stateDir: fixture.stateDir,
    ownerThreadId: 'catalog-owner', search: 'ARCHIVED' });
  assert.deepEqual(filtered.conversations.map(value => value.session_id), [oldSession]);
  const secretSearch = await listClaudeConversations({ projectsDir, registryDir, stateDir: fixture.stateDir,
    ownerThreadId: 'catalog-owner', search: secret });
  assert.deepEqual(secretSearch.conversations, []);
});

test('tail title events and incomplete trailing records have safe fallback behavior', async t => {
  const fixture = await nativeFixture(t);
  const sessionId = randomUUID();
  const project = path.join(fixture.root, 'projects', 'project');
  writeHistory(project, sessionId, [{ type: 'user', sessionId, cwd: 'C:/project', message: { content: 'private first prompt' } },
    { type: 'assistant', sessionId, message: { content: 'x'.repeat(160000) } },
    { type: 'custom-title', sessionId, customTitle: 'Latest title' }], false);
  const first = await listClaudeConversations({ projectsDir: path.dirname(project), registryDir: path.join(fixture.root, 'absent'),
    stateDir: fixture.stateDir, ownerThreadId: 'owner' });
  assert.equal(first.conversations[0].title, 'Latest title');
  fs.appendFileSync(path.join(project, `${sessionId}.jsonl`), '\n{"type":"custom-title","customTitle":"unfinished');
  const next = await listClaudeConversations({ projectsDir: path.dirname(project), registryDir: path.join(fixture.root, 'absent'),
    stateDir: fixture.stateDir, ownerThreadId: 'owner' });
  assert.equal(next.conversations[0].title, 'Latest title');
  assert.doesNotMatch(JSON.stringify(next), /private first prompt|unfinished/);
});

test('corrupted title and unrelated delivery ledger do not hide valid catalog entries', async t => {
  const fixture = await nativeFixture(t);
  const sessionId = randomUUID();
  const project = path.join(fixture.root, 'projects', 'project');
  writeHistory(project, sessionId, [{ type: 'custom-title', customTitle: 'Safe event title' }]);
  fs.mkdirSync(path.join(project, sessionId));
  fs.writeFileSync(path.join(project, sessionId, 'custom-title.json'), '{corrupted private metadata');
  ledger(fixture, 'owner');
  const corrupted = path.join(fixture.stateDir, hash('corrupted-owner'));
  fs.mkdirSync(corrupted);
  fs.writeFileSync(path.join(corrupted, 'state.json'), '{corrupted private ledger');
  const result = await listClaudeConversations({ projectsDir: path.dirname(project), registryDir: path.join(fixture.root, 'absent'),
    stateDir: fixture.stateDir, ownerThreadId: 'owner' });
  assert.equal(result.conversations[0].title, 'Safe event title');
  assert.ok(result.warnings.length >= 2);
  assert.doesNotMatch(JSON.stringify(result), /corrupted private/);
});

test('metadata tail preserves a title whose record begins exactly at the read boundary', async t => {
  const fixture = await nativeFixture(t);
  const sessionId = randomUUID();
  const project = path.join(fixture.root, 'projects', 'project');
  fs.mkdirSync(project, { recursive: true });
  const first = JSON.stringify({ type: 'user', sessionId, cwd: 'C:/project' }) + '\n';
  const head = first + ' '.repeat(65536 - Buffer.byteLength(first) - 1) + '\n';
  const title = JSON.stringify({ type: 'custom-title', sessionId, customTitle: 'Boundary title' }) + '\n';
  const tail = title + '\n'.repeat(65536 - Buffer.byteLength(title));
  fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), head + tail);
  const catalog = await listClaudeConversations({ projectsDir: path.dirname(project),
    registryDir: path.join(fixture.root, 'absent'), stateDir: fixture.stateDir, ownerThreadId: 'owner' });
  assert.equal(catalog.conversations[0].title, 'Boundary title');
});

test('bridge history uses its bounded descriptor snapshot without an unbounded second read', async t => {
  const fixture = await nativeFixture(t);
  const sessionId = randomUUID();
  const outgoing = ledger(fixture, 'bounded-owner');
  message(outgoing, { kind: 'codex', id: 'bounded-owner' }, { kind: 'claude', id: sessionId }, 'bounded', 'Full saved message');
  const original = fs.readFileSync;
  fs.readFileSync = function (file, ...args) {
    if (String(file).endsWith('state.json')) throw new Error('Unbounded ledger reader invoked');
    return original.call(this, file, ...args);
  };
  try {
    const result = await getBridgeConversation({ stateDir: fixture.stateDir, ownerThreadId: 'bounded-owner', sessionId });
    assert.deepEqual(result.messages.map(item => item.id), ['bounded']);
  } finally { fs.readFileSync = original; }
});

test('symlinked project and delivery ledger directories are not followed', async t => {
  const fixture = await nativeFixture(t);
  const sessionId = randomUUID();
  const outside = path.join(fixture.root, 'outside');
  writeHistory(outside, sessionId, [{ type: 'custom-title', customTitle: 'Outside secret title' }]);
  const projectsDir = path.join(fixture.root, 'projects');
  fs.mkdirSync(projectsDir);
  fs.symlinkSync(outside, path.join(projectsDir, 'linked-project'), process.platform === 'win32' ? 'junction' : 'dir');
  const outgoing = ledger(fixture, 'different-owner');
  message(outgoing, { kind: 'codex', id: 'owner' }, { kind: 'claude', id: sessionId }, 'unsafe', 'Outside bridge content');
  fs.symlinkSync(outgoing.dir, path.join(fixture.stateDir, hash('owner')), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await listClaudeConversations({ projectsDir, registryDir: path.join(fixture.root, 'absent'),
    stateDir: fixture.stateDir, ownerThreadId: 'owner' });
  assert.deepEqual(result.conversations, []);
  const conversation = await getBridgeConversation({ stateDir: fixture.stateDir, ownerThreadId: 'owner', sessionId });
  assert.deepEqual(conversation.messages, []);
  assert.ok(conversation.warnings.length);
  assert.doesNotMatch(JSON.stringify(result), /Outside secret title|Outside bridge content/);
});

test('manual notice metadata joins only the exact route and fingerprint', async t => {
  const fixture = await nativeFixture(t);
  const sessionId = randomUUID();
  const outgoing = ledger(fixture, 'manual-owner');
  const saved = message(outgoing, { kind: 'codex', id: 'manual-owner' }, { kind: 'claude', id: sessionId }, 'manual-id', 'manual message', 'submitted', true);
  const directory = path.join(fixture.stateDir, 'manual', hash('manual-owner'));
  fs.mkdirSync(directory, { recursive: true });
  const record = { message_id: 'manual-id', session_id: sessionId, fingerprint: saved.fingerprint,
    manual: true, send_status: 'submitted', notice_status: 'submitted', notice_retryable: false, notice_attempted: true,
    sender_pid: process.pid, createdAt: saved.createdAt, updatedAt: saved.createdAt };
  const state = { schemaVersion: 1, owner_thread_id: 'manual-owner', records: { [hash(JSON.stringify([sessionId, 'manual-id']))]: record } };
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify(state));
  const result = await getBridgeConversation({ stateDir: fixture.stateDir, ownerThreadId: 'manual-owner', sessionId });
  assert.equal(result.messages[0].manual, true);
  assert.equal(result.messages[0].notice_status, 'submitted');
  assert.equal(result.messages[0].notice_retryable, false);
  record.session_id = randomUUID();
  state.records = { [hash(JSON.stringify([record.session_id, 'manual-id']))]: record };
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify(state));
  const unrelated = await getBridgeConversation({ stateDir: fixture.stateDir, ownerThreadId: 'manual-owner', sessionId });
  assert.equal(unrelated.messages[0].manual, true, 'primary manual origin remains authoritative');
  assert.equal(unrelated.messages[0].notice_status, undefined, 'another recipient cannot supply a notice');
  record.session_id = sessionId;
  state.records = { [hash(JSON.stringify([record.session_id, 'manual-id']))]: record };
  record.fingerprint = 'f'.repeat(64);
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify(state));
  const changed = await getBridgeConversation({ stateDir: fixture.stateDir, ownerThreadId: 'manual-owner', sessionId });
  assert.equal(changed.messages[0].notice_status, undefined);
});

test('history rejects missing owners, unsafe session IDs and cancellation before filesystem work', async t => {
  const fixture = await nativeFixture(t);
  await assert.rejects(getBridgeConversation({ stateDir: fixture.stateDir, ownerThreadId: '', sessionId: randomUUID() }), /verified owning/);
  await assert.rejects(getBridgeConversation({ stateDir: fixture.stateDir, ownerThreadId: 'owner', sessionId: '../other' }), /session UUID/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(listClaudeConversations({ projectsDir: fixture.root, stateDir: fixture.stateDir,
    ownerThreadId: 'owner', signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(scanBridgeExchange({ stateDir: fixture.stateDir, ownerThreadId: 'owner', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(fs.existsSync(fixture.stateDir), false);
});

test('Claude catalog rejects a projects root replaced by a junction after its initial identity check', async t => {
  const fixture = await nativeFixture(t);
  const projectsDir = path.join(fixture.root, 'projects');
  const outside = path.join(fixture.root, 'outside-projects');
  fs.mkdirSync(projectsDir);
  writeHistory(path.join(outside, 'project'), randomUUID(), [{ type: 'custom-title', customTitle: 'Outside root title' }]);
  const originalOpen = fsPromises.opendir;
  let changed = false;
  fsPromises.opendir = async (directory, ...args) => {
    if (directory === projectsDir && !changed) {
      changed = true;
      fs.renameSync(projectsDir, path.join(fixture.root, 'original-projects'));
      fs.symlinkSync(outside, projectsDir, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return originalOpen(directory, ...args);
  };
  let result;
  try {
    result = await listClaudeConversations({ projectsDir, registryDir: path.join(fixture.root, 'absent'),
      stateDir: fixture.stateDir, ownerThreadId: 'owner' });
  } finally { fsPromises.opendir = originalOpen; }
  assert.equal(changed, true);
  assert.deepEqual(result.conversations, []);
  assert.ok(result.warnings.length);
  assert.doesNotMatch(JSON.stringify(result), /Outside root title/);
});

test('Claude catalog rejects a project directory replaced by either a junction or another regular directory', async t => {
  for (const replacement of ['junction', 'directory']) {
    await t.test(replacement, async sub => {
      const fixture = await nativeFixture(sub);
      const sessionId = randomUUID();
      const projectsDir = path.join(fixture.root, 'projects');
      const project = path.join(projectsDir, 'one');
      const outside = path.join(fixture.root, 'outside-project');
      writeHistory(project, sessionId, [{ type: 'custom-title', customTitle: 'Original project title' }]);
      writeHistory(outside, sessionId, [{ type: 'custom-title', customTitle: 'Replacement private title' }]);
      const originalOpen = fsPromises.opendir;
      let changed = false;
      fsPromises.opendir = async (directory, ...args) => {
        if (directory === project && !changed) {
          changed = true;
          fs.renameSync(project, path.join(fixture.root, 'original-project'));
          if (replacement === 'junction') fs.symlinkSync(outside, project, process.platform === 'win32' ? 'junction' : 'dir');
          else fs.renameSync(outside, project);
        }
        return originalOpen(directory, ...args);
      };
      let result;
      try {
        result = await listClaudeConversations({ projectsDir, registryDir: path.join(fixture.root, 'absent'),
          stateDir: fixture.stateDir, ownerThreadId: 'owner' });
      } finally { fsPromises.opendir = originalOpen; }
      assert.equal(changed, true);
      assert.deepEqual(result.conversations, []);
      assert.ok(result.warnings.length);
      assert.doesNotMatch(JSON.stringify(result), /Original project title|Replacement private title/);
    });
  }
});

test('final Claude catalog validation discards native snapshots if their root changes after metadata was read', async t => {
  const fixture = await nativeFixture(t);
  const sessionId = randomUUID();
  const projectsDir = path.join(fixture.root, 'projects');
  const outside = path.join(fixture.root, 'outside-projects');
  writeHistory(path.join(projectsDir, 'project'), sessionId, [{ type: 'custom-title', customTitle: 'Earlier native snapshot' }]);
  writeHistory(path.join(outside, 'project'), sessionId, [{ type: 'custom-title', customTitle: 'Outside later title' }]);
  ledger(fixture, 'owner');
  const originalRead = fsPromises.readdir;
  let changed = false;
  fsPromises.readdir = async (directory, ...args) => {
    if (directory === fixture.stateDir && !changed) {
      changed = true;
      fs.renameSync(projectsDir, path.join(fixture.root, 'original-projects'));
      fs.symlinkSync(outside, projectsDir, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return originalRead(directory, ...args);
  };
  let result;
  try {
    result = await listClaudeConversations({ projectsDir, registryDir: path.join(fixture.root, 'absent'),
      stateDir: fixture.stateDir, ownerThreadId: 'owner' });
  } finally { fsPromises.readdir = originalRead; }
  assert.equal(changed, true);
  assert.deepEqual(result.conversations, []);
  assert.ok(result.warnings.some(warning => /directory changed/.test(warning)));
  assert.doesNotMatch(JSON.stringify(result), /Earlier native snapshot|Outside later title/);
});
