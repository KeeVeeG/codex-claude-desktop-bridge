import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { executeBridgeTool } from '../lib/desktop-service.mjs';
import { fakeDaemon } from './codex-daemon-helpers.mjs';

const terminalMeta = threadId => ({ 'x-codex-turn-metadata': JSON.stringify({ thread_id: threadId }), threadId });

async function terminalSetup(t, extra = {}) {
  const threadId = randomUUID();
  const setup = await fakeDaemon(t, { threads: [{ id: threadId, originator: 'codex-tui', name: 'My terminal' }], ...extra });
  const context = { env: { CODEX_CLAUDE_BRIDGE_STATE_DIR: setup.stateDir }, stateDir: setup.stateDir,
    daemon: setup.daemon, metadata: terminalMeta(threadId) };
  return { ...setup, threadId, context };
}

test('a terminal Codex caller without the Desktop pipe is identified through the daemon', async t => {
  const setup = await terminalSetup(t);
  const status = await executeBridgeTool('bridge_status', {}, setup.context);
  assert.equal(status.application, 'codex');
  assert.equal(status.sender_id, setup.threadId);
});

test('a caller the daemon does not know as a terminal session is rejected', async t => {
  const setup = await terminalSetup(t);
  const stranger = { ...setup.context, metadata: terminalMeta(randomUUID()) };
  await assert.rejects(() => executeBridgeTool('bridge_status', {}, stranger), /not a terminal session known to the Codex daemon/);
  const desktop = await fakeDaemon(t, { threads: [{ id: 'desk', originator: 'Codex Desktop' }] });
  await assert.rejects(() => executeBridgeTool('bridge_status', {}, { ...setup.context, daemon: desktop.daemon, metadata: terminalMeta('desk') }),
    /not a terminal session known to the Codex daemon/);
});

test('with the daemon down a call lacking the Desktop pipe is rejected with a clear reason', async t => {
  const down = await fakeDaemon(t, { unreachable: true });
  await assert.rejects(() => executeBridgeTool('bridge_status', {}, { env: { CODEX_CLAUDE_BRIDGE_STATE_DIR: down.stateDir },
    stateDir: down.stateDir, daemon: down.daemon, metadata: terminalMeta(randomUUID()) }),
  /could not verify it as a terminal session.*not reachable/s);
});

test('the conversation panel and manual send are refused for terminal callers before any mutation', async t => {
  const setup = await terminalSetup(t);
  for (const name of ['bridge_panel', 'bridge_ui_history', 'bridge_ui_send', 'bridge_ui_retry_notice']) {
    await assert.rejects(() => executeBridgeTool(name, { session_id: 'x', message: 'x', message_id: 'm' }, setup.context),
      /available only from a Codex Desktop chat/, name);
  }
});
