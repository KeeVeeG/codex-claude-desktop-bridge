import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { getBridgeConversation, scanBridgeExchange } from '../lib/bridge-history.mjs';
import { createSession, recordMessage, finishMessage } from '../lib/store.mjs';
import { nativeFixture } from './native-helpers.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';

function save(fixture, stateDir, owner, recipient, text) {
  fs.mkdirSync(stateDir, { recursive: true });
  const ledger = createSession({ stateDir, threadId: owner, cwd: fixture.cwd });
  const route = { from: { kind: 'codex', id: owner }, to: { kind: 'claude', id: recipient } };
  const reserved = recordMessage(ledger, { id: 'message', direction: 'to_claude', message: text, route });
  finishMessage(ledger, reserved.message.id, { status: 'submitted', route });
  return ledger;
}

function replaceWithLink(fixture, selected, target, backupName) {
  const workspace = path.resolve(fixture.root);
  const original = path.resolve(selected);
  const destination = path.resolve(target);
  const backup = path.join(path.dirname(original), backupName);
  for (const candidate of [original, destination, backup]) {
    const relative = path.relative(workspace, candidate);
    assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative),
      'every fixture move/link stays inside this exact test workspace');
  }
  fs.renameSync(original, backup);
  fs.symlinkSync(destination, original, directoryLink);
}

test('bridge history rejects a state root replaced by a junction during directory listing', async t => {
  const fixture = await nativeFixture(t);
  const owner = 'root-race-owner';
  const sessionId = randomUUID();
  save(fixture, fixture.stateDir, owner, sessionId, 'Original safe exchange');
  const outside = path.join(fixture.root, 'outside-state');
  save(fixture, outside, owner, sessionId, 'EXTERNAL_PAIRED_CONTENT');
  const readdir = fsp.readdir;
  let changed = false;
  t.mock.method(fsp, 'readdir', async (directory, options) => {
    if (path.resolve(directory) === path.resolve(fixture.stateDir) && !changed) {
      changed = true;
      replaceWithLink(fixture, fixture.stateDir, outside, 'original-state');
    }
    return readdir(directory, options);
  });
  const result = await getBridgeConversation({ stateDir: fixture.stateDir, ownerThreadId: owner, sessionId });
  assert.equal(changed, true);
  assert.deepEqual(result.messages, []);
  assert.ok(result.warnings.some(warning => /state directory changed/.test(warning)));
  assert.doesNotMatch(JSON.stringify(result), /EXTERNAL_PAIRED_CONTENT|Original safe exchange/);
});

test('bridge history discards collected records if the root changes after a bounded ledger read', async t => {
  const fixture = await nativeFixture(t);
  const owner = 'read-race-owner';
  const sessionId = randomUUID();
  const ledger = save(fixture, fixture.stateDir, owner, sessionId, 'Already read safe exchange');
  const outside = path.join(fixture.root, 'outside-state');
  save(fixture, outside, owner, sessionId, 'EXTERNAL_AFTER_READ');
  const open = fsp.open;
  let changed = false;
  t.mock.method(fsp, 'open', async (...args) => {
    const handle = await open(...args);
    if (path.resolve(args[0]) === path.resolve(ledger.stateFile)) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => {
        const result = await close();
        if (!changed) {
          replaceWithLink(fixture, fixture.stateDir, outside, 'original-state');
          changed = true;
        }
        return result;
      });
    }
    return handle;
  });
  const result = await scanBridgeExchange({ stateDir: fixture.stateDir, ownerThreadId: owner, sessionId });
  assert.equal(changed, true);
  assert.deepEqual(result.records, []);
  assert.ok(result.warnings.some(warning => /state directory changed/.test(warning)));
  assert.doesNotMatch(JSON.stringify(result), /EXTERNAL_AFTER_READ|Already read safe exchange/);
});

test('bridge history rejects a leaf ledger replaced by a junction before opening its file', async t => {
  const fixture = await nativeFixture(t);
  const owner = 'leaf-race-owner';
  const sessionId = randomUUID();
  const ledger = save(fixture, fixture.stateDir, owner, sessionId, 'Original leaf');
  const outside = path.join(fixture.root, 'outside-state');
  const outsideLedger = save(fixture, outside, owner, sessionId, 'EXTERNAL_LEAF_CONTENT');
  const open = fsp.open;
  let changed = false;
  t.mock.method(fsp, 'open', async (...args) => {
    if (path.resolve(args[0]) === path.resolve(ledger.stateFile) && !changed) {
      changed = true;
      replaceWithLink(fixture, ledger.dir, outsideLedger.dir, `${hash(owner)}-original`);
    }
    return open(...args);
  });
  const result = await getBridgeConversation({ stateDir: fixture.stateDir, ownerThreadId: owner, sessionId });
  assert.equal(changed, true);
  assert.deepEqual(result.messages, []);
  assert.ok(result.warnings.length);
  assert.doesNotMatch(JSON.stringify(result), /EXTERNAL_LEAF_CONTENT|Original leaf/);
});
