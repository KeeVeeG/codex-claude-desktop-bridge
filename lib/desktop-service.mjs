import fs from 'node:fs';
import path from 'node:path';
import { discoverClaudeSessions, resolveClaudeSession, resolveClaudeCaller, sendToClaude } from './claude-desktop.mjs';
import { listCodexChats, sendToCodex } from './codex-desktop.mjs';
import { publishCodexHost, getCodexHost } from './codex-host.mjs';
import { defaultStateDir, createSession, getSession, recordMessage, finishMessage, getMessages } from './store.mjs';

export function codexIdentity(metadata = {}, env = process.env) {
  let turn = metadata['x-codex-turn-metadata'];
  if (typeof turn === 'string') {
    try { turn = JSON.parse(turn); } catch { throw new Error('Invalid Codex turn metadata'); }
  }
  if (turn !== undefined && (turn === null || typeof turn !== 'object' || Array.isArray(turn))) throw new Error('Invalid Codex turn metadata');
  const candidates = [turn?.thread_id, metadata['openai/threadId'], metadata['openai/thread_id'],
    metadata['codex/threadId'], metadata.codexThreadId, metadata.codex_thread_id, metadata.threadId,
    metadata.thread_id, metadata.thread?.id].filter(v => v !== undefined);
  if (candidates.some(v => typeof v !== 'string' || !v.trim())) throw new Error('Invalid Codex task identity in MCP metadata');
  const identities = [...new Set(candidates)];
  if (identities.length > 1) throw new Error('Conflicting Codex task identities in MCP metadata');
  // A server can serve multiple tasks. Its startup CODEX_THREAD_ID identifies
  // the host context, not necessarily the task making this particular call.
  const threadId = identities[0];
  if (!threadId) throw new Error('The calling Codex Desktop task identity is unavailable in this tool call.');
  if (!env.CODEX_APP_TOOLS_PIPE_PATH) throw new Error('Codex Desktop did not provide its local app-tools pipe');
  return { threadId, pipePath: env.CODEX_APP_TOOLS_PIPE_PATH };
}

function settings(context) {
  const env = context.env || process.env;
  return { env,
    stateDir: context.stateDir || env.CODEX_CLAUDE_BRIDGE_STATE_DIR || defaultStateDir(),
    registryDir: context.registryDir || env.CODEX_CLAUDE_BRIDGE_REGISTRY_DIR ||
      (env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, 'sessions') : undefined),
  };
}

function caller(context, config) {
  const meta = context.metadata || {};
  const isCodex = config.env.CODEX_THREAD_ID || ['x-codex-turn-metadata', 'openai/threadId', 'openai/thread_id',
    'codex/threadId', 'codexThreadId', 'codex_thread_id', 'threadId', 'thread_id', 'thread'].some(key => Object.hasOwn(meta, key));
  if (isCodex) {
    const identity = codexIdentity(meta, config.env);
    publishCodexHost({ stateDir: config.stateDir, ...identity });
    return { kind: 'codex', ...identity };
  }
  const endpoint = resolveClaudeCaller({ registryDir: config.registryDir, parentPid: context.parentPid ?? process.ppid,
    socketPath: config.env.CLAUDE_CODE_MESSAGING_SOCKET });
  return { kind: 'claude', endpoint };
}

function sender(who) {
  return who.kind === 'codex'
    ? { kind: 'codex', id: who.threadId }
    : { kind: 'claude', id: who.endpoint.sessionId };
}

function senderLabel(id) {
  // Claude's native `from` field is a short, single-line display label. The
  // message notice below carries the complete, escaped reply address.
  return `Codex task ${id.replace(/[\r\n\0]/g, ' ').slice(0, 180)}`;
}

function senderLedgerId(who) {
  // Preserve existing Codex task ledgers. Prefix Claude IDs so their ledgers
  // cannot collide with a Codex task or depend on a prior one-to-one pairing.
  return who.kind === 'codex' ? who.threadId : `claude:${who.endpoint.sessionId}`;
}

function senderLedger(who, config, create = false) {
  const threadId = senderLedgerId(who);
  const existing = getSession({ stateDir: config.stateDir, threadId });
  if (existing || !create) return existing;
  fs.mkdirSync(config.stateDir, { recursive: true });
  // A stable user-owned directory avoids binding a conversation's history to
  // the plugin cache or whichever project happened to launch its MCP server.
  return createSession({ stateDir: config.stateDir, threadId, cwd: config.stateDir });
}

function hostFor(who, config) {
  if (who.kind === 'codex') return { pipePath: who.pipePath, threadId: who.threadId };
  const host = getCodexHost({ stateDir: config.stateDir });
  if (!host) throw new Error('Codex Desktop has not registered its bridge endpoint yet. Open Codex with the plugin enabled, or run the installer from an open Codex task.');
  return host;
}

export async function executeBridgeTool(name, args = {}, context = {}) {
  const config = settings(context);
  if (name === 'list_claude_sessions') return discoverClaudeSessions({ registryDir: config.registryDir });
  const who = caller(context, config);
  if (name === 'list_codex_chats') {
    const host = hostFor(who, config);
    return listCodexChats({ pipePath: host.pipePath, contextThreadId: host.threadId, limit: args.limit || 30 });
  }
  if (name === 'bridge_status') {
    const session = senderLedger(who, config);
    return { application: who.kind, sender_id: sender(who).id, state_directory: config.stateDir,
      messages: session ? getMessages(session, args.limit || 20, undefined, sender(who)) : [],
      note: 'Submitted means handed to the app transport, not read by the other model. Replies are independent messages.' };
  }
  if (name !== 'send_to_claude' && name !== 'send_to_codex') throw new Error('Unknown bridge tool');
  if ((name === 'send_to_claude') !== (who.kind === 'codex')) throw new Error(`Use ${who.kind === 'codex' ? 'send_to_claude' : 'send_to_codex'} from this application.`);
  const direction = who.kind === 'codex' ? 'to_claude' : 'to_codex';
  const endpoint = direction === 'to_claude' ? resolveClaudeSession(args.session_id, { registryDir: config.registryDir }) : null;
  const host = direction === 'to_codex' ? hostFor(who, config) : null;
  const route = { from: sender(who), to: direction === 'to_claude'
    ? { kind: 'claude', id: endpoint.sessionId }
    : { kind: 'codex', id: args.thread_id } };
  const session = senderLedger(who, config, true);
  const reserved = recordMessage(session, { id: args.message_id, direction, message: args.message, route });
  if (!reserved.created) return { message: reserved.message, retransmitted: false };
  let receipt;
  try {
    if (direction === 'to_claude') {
      const notice = `[From Codex Desktop task ${JSON.stringify(route.from.id)}; bridge message ${reserved.message.id}]\n\n${args.message}`;
      receipt = await sendToClaude({ ...endpoint, message: notice, senderName: senderLabel(route.from.id) });
    } else {
      const notice = `[From Claude Desktop session ${JSON.stringify(route.from.id)}; bridge message ${reserved.message.id}]\n\n${args.message}`;
      await sendToCodex({ pipePath: host.pipePath, threadId: route.to.id, message: notice });
    }
  } catch (error) {
    try { finishMessage(session, reserved.message.id, { status: error.deliveryUnknown ? 'uncertain' : 'failed', route, error: error.message }); }
    catch { error.message += ' The transport outcome could not be saved; inspect the receiving conversation before retrying.'; }
    throw error;
  }
  try {
    return { message: finishMessage(session, reserved.message.id, { status: 'submitted', route, ...(receipt ? { receipt } : {}) }) };
  } catch {
    const error = new Error('The message was submitted, but its receipt could not be saved. Do not resend it without inspecting the receiving conversation.');
    error.deliveryUnknown = true;
    throw error;
  }
}
