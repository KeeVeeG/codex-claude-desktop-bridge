import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { discoverClaudeSessions, resolveClaudeSession, resolveClaudeCaller, sendToClaude } from './claude-desktop.mjs';
import { MAX_CODEX_CHAT_LIMIT, listCodexTools, listCodexChats, sendToCodex } from './codex-desktop.mjs';
import { publishCodexHost, getCodexHost } from './codex-host.mjs';
import { defaultStateDir, createSession, getSession, loadSession, readSession, updateSession,
  withStateLock, recordMessage, finishMessage, getMessages } from './store.mjs';

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
  const threadId = identities[0] || env.CODEX_THREAD_ID;
  if (!threadId) throw new Error('The calling Codex Desktop task identity is unavailable.');
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

function allSessions(config) {
  if (!fs.existsSync(config.stateDir)) return [];
  const sessions = [];
  for (const entry of fs.readdirSync(config.stateDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    try { sessions.push(loadSession({ stateDir: config.stateDir, sessionKey: entry.name })); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return sessions;
}

function ownSession(who, config, required = true) {
  const matches = who.kind === 'codex'
    ? [getSession({ stateDir: config.stateDir, threadId: who.threadId })].filter(Boolean)
    : allSessions(config).filter(session => readSession(session).desktop?.claudeSessionId === who.endpoint.sessionId);
  const connected = matches.filter(session => readSession(session).desktop);
  if (connected.length > 1) throw new Error('Ambiguous pairing; inspect the local bridge state before proceeding.');
  if (!connected.length && required) throw new Error(`This conversation is not connected. Use ${who.kind === 'codex' ? 'connect_claude' : 'connect_codex'} first.`);
  const session = connected[0] || null;
  if (session && !readSession(session).desktop.pairId) {
    updateSession(session, state => {
      if (!state.desktop) throw new Error('The pairing changed; inspect bridge_status again.');
      state.desktop.pairId ||= randomUUID();
    });
  }
  return session;
}

function summary(session) {
  const target = readSession(session).desktop;
  return { connected: true, connection: session.key, thread_id: session.threadId,
    codex_title: target.codexTitle || null, claude_session_id: target.claudeSessionId, claude_name: target.claudeName };
}

function withConnection(who, config, required, action) {
  return withStateLock(path.join(config.stateDir, 'desktop-bindings'), () => {
    const session = ownSession(who, config, required);
    return action(session, session ? readSession(session).desktop : null);
  });
}

function hostFor(who, config) {
  if (who.kind === 'codex') return { pipePath: who.pipePath, threadId: who.threadId };
  const host = getCodexHost({ stateDir: config.stateDir });
  if (!host) throw new Error('Codex Desktop has not registered its bridge endpoint yet. Open Codex with the plugin enabled, or run the installer from an open Codex task.');
  return host;
}

async function pair(who, args, config) {
  let endpoint, threadId, codexTitle, pipePath;
  if (who.kind === 'codex') {
    endpoint = resolveClaudeSession(args.session_id, { registryDir: config.registryDir });
    threadId = who.threadId;
    pipePath = who.pipePath;
    const catalog = await listCodexTools(pipePath);
    if (!catalog.some(tool => tool.name === 'send_message_to_thread')) throw new Error('This Codex version does not expose native chat messaging.');
  } else {
    endpoint = who.endpoint;
    const host = hostFor(who, config);
    const chats = await listCodexChats({ pipePath: host.pipePath, contextThreadId: host.threadId, limit: MAX_CODEX_CHAT_LIMIT });
    const chosen = chats.find(chat => chat.thread_id === args.thread_id);
    if (!chosen) throw new Error('The selected local Codex chat is not available. Choose an exact ID from list_codex_chats.');
    threadId = chosen.thread_id;
    codexTitle = chosen.title;
    pipePath = host.pipePath;
  }
  const session = getSession({ stateDir: config.stateDir, threadId }) || createSession({ stateDir: config.stateDir, threadId, cwd: process.cwd() });
  return withStateLock(path.join(config.stateDir, 'desktop-bindings'), () => {
    for (const other of allSessions(config)) {
      if (other.key !== session.key && readSession(other).desktop?.claudeSessionId === endpoint.sessionId) {
        throw new Error('This Claude conversation is already paired with a different Codex chat. Disconnect that pairing first.');
      }
    }
    updateSession(session, state => {
      if (state.desktop && state.desktop.claudeSessionId !== endpoint.sessionId) throw new Error('This Codex chat is already paired with a different Claude conversation. Disconnect that pairing first.');
      state.desktop = { threadId, pairId: state.desktop?.pairId || randomUUID(), codexTitle: codexTitle || state.desktop?.codexTitle || null,
        claudeSessionId: endpoint.sessionId, claudeName: endpoint.name || endpoint.sessionId,
        registryDir: config.registryDir || null, codexPipePath: pipePath, connectedAt: state.desktop?.connectedAt || Date.now() };
    });
    return summary(session);
  });
}

export async function executeBridgeTool(name, args = {}, context = {}) {
  const config = settings(context);
  if (name === 'list_claude_sessions') return discoverClaudeSessions({ registryDir: config.registryDir });
  const who = caller(context, config);
  if (name === 'list_codex_chats') {
    const host = hostFor(who, config);
    return listCodexChats({ pipePath: host.pipePath, contextThreadId: host.threadId, limit: args.limit || 30 });
  }
  if (name === 'connect_claude' || name === 'connect_codex') {
    if ((name === 'connect_claude') !== (who.kind === 'codex')) throw new Error(`Use ${who.kind === 'codex' ? 'connect_claude' : 'connect_codex'} from this application.`);
    return pair(who, args, config);
  }
  if (name === 'bridge_status') {
    return withConnection(who, config, false, (session, current) => {
      if (!session) return { connected: false, application: who.kind, state_directory: config.stateDir };
      return { ...summary(session), application: who.kind, state_directory: config.stateDir,
        messages: getMessages(session, args.limit || 20, current.pairId),
        note: 'Messages are independent. Submitted means handed to the app transport, not read by the other model.' };
    });
  }
  if (name === 'disconnect_bridge') {
    const session = ownSession(who, config, false);
    if (!session) return { disconnected: true };
    return withStateLock(path.join(config.stateDir, 'desktop-bindings'), () => updateSession(session, state => {
      // A concurrent reconnect must never let an old caller disconnect another pair.
      if (who.kind === 'claude' && state.desktop?.claudeSessionId !== who.endpoint.sessionId) throw new Error('The pairing changed; inspect bridge_status again.');
      state.desktop = null;
      return { disconnected: true, note: 'Already submitted messages and running work are not withdrawn.' };
    }));
  }
  if (name !== 'send_to_claude' && name !== 'send_to_codex') throw new Error('Unknown bridge tool');
  if ((name === 'send_to_claude') !== (who.kind === 'codex')) throw new Error(`Use ${who.kind === 'codex' ? 'send_to_claude' : 'send_to_codex'} from this application.`);
  const snapshot = withConnection(who, config, true, (session, target) => ({ session, target }));
  const { session, target } = snapshot;
  const direction = who.kind === 'codex' ? 'to_claude' : 'to_codex';
  const endpoint = direction === 'to_claude' ? resolveClaudeSession(target.claudeSessionId, { registryDir: target.registryDir }) : null;
  const host = direction === 'to_codex' ? hostFor(who, config) : null;
  const reserved = withConnection(who, config, true, (current, currentTarget) => {
    if (current.key !== session.key || currentTarget.pairId !== target.pairId) throw new Error('The pairing changed before submission. Inspect bridge_status before sending again.');
    return recordMessage(session, { id: args.message_id, direction, message: args.message, pairId: target.pairId });
  });
  if (!reserved.created) return { message: reserved.message, retransmitted: false };
  let receipt;
  try {
    if (direction === 'to_claude') {
      // Attribution is part of Claude's native envelope; the message body stays unchanged.
      receipt = await sendToClaude({ ...endpoint, message: args.message, senderName: 'Codex Desktop bridge' });
    } else {
      const notice = `[Claude Desktop message ${reserved.message.id}; ${target.claudeName}]\n\n${args.message}`;
      await sendToCodex({ pipePath: host.pipePath, threadId: target.threadId, message: notice, callId: `desktop-bridge-${reserved.message.id}` });
    }
  } catch (error) {
    try { finishMessage(session, reserved.message.id, { status: error.deliveryUnknown ? 'uncertain' : 'failed', pairId: target.pairId, error: error.message }); }
    catch { error.message += ' The transport outcome could not be saved; inspect the receiving conversation before retrying.'; }
    throw error;
  }
  try {
    return { message: finishMessage(session, reserved.message.id, { status: 'submitted', pairId: target.pairId, ...(receipt ? { receipt } : {}) }) };
  } catch {
    const error = new Error('The message was submitted, but its receipt could not be saved. Do not resend it without inspecting the receiving conversation.');
    error.deliveryUnknown = true;
    throw error;
  }
}
