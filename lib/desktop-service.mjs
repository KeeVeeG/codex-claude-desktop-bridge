import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverClaudeSessions, resolveClaudeSession, resolveClaudeCaller, sendToClaude, probeClaudeInbox, canonicalClaudeSocket } from './claude-desktop.mjs';
import { listCodexTools, listCodexChats, sendToCodex } from './codex-desktop.mjs';
import { publishCodexHost, getCodexHosts } from './codex-host.mjs';
import { defaultStateDir, createSession, getSession, recordMessage, finishMessage, getMessages } from './store.mjs';
import { readComposerEnterBehavior } from './codex-settings.mjs';

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

function checkCancellation(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Bridge request was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function identifyCaller(context, config) {
  const meta = context.metadata || {};
  const hasCodexMetadata = ['x-codex-turn-metadata', 'openai/threadId', 'openai/thread_id',
    'codex/threadId', 'codexThreadId', 'codex_thread_id', 'threadId', 'thread_id', 'thread'].some(key => Object.hasOwn(meta, key));
  const isCodex = !config.env.CLAUDE_CODE_MESSAGING_SOCKET && config.env.CODEX_APP_TOOLS_PIPE_PATH && hasCodexMetadata;
  if (isCodex) {
    const identity = codexIdentity(meta, config.env);
    return { kind: 'codex', ...identity };
  }
  const endpoint = resolveClaudeCaller({ registryDir: config.registryDir, parentPid: context.parentPid ?? process.ppid,
    socketPath: config.env.CLAUDE_CODE_MESSAGING_SOCKET });
  return { kind: 'claude', endpoint };
}

function caller(context, config, { publish = false } = {}) {
  const who = identifyCaller(context, config);
  // Host publication is needed for outbound routing from Codex to Claude and
  // for Claude's later send_to_codex discovery. Read-only catalog, history,
  // and status calls must not persist a registry record behind their hints.
  if (publish && who.kind === 'codex') {
    publishCodexHost({ stateDir: config.stateDir, pipePath: who.pipePath, threadId: who.threadId });
  }
  return who;
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

async function hostFor(who, config, signal) {
  checkCancellation(signal);
  if (who.kind === 'codex') return { pipePath: who.pipePath, threadId: who.threadId };
  const hosts = getCodexHosts({ stateDir: config.stateDir });
  if (hosts.length === 0) throw new Error('Codex Desktop has not registered its bridge endpoint yet. Open Codex with the plugin enabled, or run the installer from an open Codex task.');
  let lastError;
  for (const host of hosts) {
    try {
      await listCodexChats({ pipePath: host.pipePath, contextThreadId: host.threadId, limit: 1, signal });
      return host;
    } catch (error) { checkCancellation(signal); lastError = error; }
  }
  throw new Error(`No registered Codex Desktop endpoint accepted a task context. Ask an open Codex task to call bridge_status, then retry.${lastError ? ` Last error: ${lastError.message}` : ''}`);
}

function inspectStateDirectory(stateDir) {
  const directory = path.resolve(stateDir);
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid state directory');
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    return { status: 'pass', detail: 'The shared state directory is readable and writable.' };
  } catch (error) {
    if (error.code !== 'ENOENT') return { status: 'fail', detail: 'The shared state location must be a readable, writable real directory. Check its configuration and permissions.' };
  }
  let ancestor = path.dirname(directory);
  for (;;) {
    try {
      const stat = fs.lstatSync(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid state parent');
      fs.accessSync(ancestor, fs.constants.R_OK | fs.constants.W_OK);
      return { status: 'warning', detail: 'The state directory does not exist yet. Its parent is accessible; an authorized send or host registration will create it.' };
    } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) {
        return { status: 'fail', detail: 'The shared state directory cannot be created under its configured parent. Check the location and permissions.' };
      }
      ancestor = path.dirname(ancestor);
    }
  }
}

/** Diagnose only local configuration and read-only endpoints. Do not register
 * hosts, create state, send prompts, or return credentials and local addresses.
 */
async function bridgeDoctor(context, config) {
  const signal = context.signal;
  checkCancellation(signal);
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  add('platform', process.platform === 'win32' ? 'pass' : 'fail',
    process.platform === 'win32' ? 'Windows Desktop transports are supported.' : 'Native Desktop discovery requires Windows.');
  checks.push({ name: 'state_directory', ...inspectStateDirectory(config.stateDir) });
  let application = config.env.CLAUDE_CODE_MESSAGING_SOCKET ? 'claude'
    : config.env.CODEX_APP_TOOLS_PIPE_PATH ? 'codex' : 'unknown';
  let who;
  try {
    who = identifyCaller(context, config);
    application = who.kind;
    add('caller', 'pass', 'The calling Desktop conversation has a verified runtime identity.');
  } catch {
    add('caller', 'fail', application === 'unknown'
      ? 'No Desktop caller identity is available. Run this tool from the intended Codex task or Claude Desktop Code session.'
      : application === 'codex'
      ? 'This call has no valid Codex task context. Run the tool from an open Codex task with the bridge enabled.'
      : 'The direct Claude parent session could not be verified. Open the bridge in the intended Desktop Code session.');
  }
  checkCancellation(signal);
  let hosts = [];
  try {
    hosts = getCodexHosts({ stateDir: config.stateDir });
    add('codex_registry', hosts.length ? 'pass' : 'warning', hosts.length
      ? 'Saved Codex endpoint records are valid.'
      : 'No saved Codex endpoint is registered. Use a bridge tool in an open Codex task before discovery from Claude.');
  } catch {
    add('codex_registry', 'fail', 'Saved Codex endpoint records are malformed or unreadable. Check the shared state configuration.');
  }
  const current = who?.kind === 'codex' ? { pipePath: who.pipePath, threadId: who.threadId }
    : config.env.CODEX_APP_TOOLS_PIPE_PATH ? { pipePath: config.env.CODEX_APP_TOOLS_PIPE_PATH,
      threadId: config.env.CODEX_THREAD_ID } : null;
  const seen = new Set();
  const candidates = [current, ...hosts].filter(host => {
    if (!host || seen.has(`${host.pipePath}\0${host.threadId}`)) return false;
    seen.add(`${host.pipePath}\0${host.threadId}`);
    return true;
  });
  let compatible = false;
  let acceptedContext = false;
  const codexDeadline = Date.now() + 6000;
  let codexChecked = 0;
  for (const host of candidates) {
    if (Date.now() >= codexDeadline) break;
    codexChecked++;
    try {
      if (process.platform === 'win32' ? !canonicalClaudeSocket(host.pipePath) : !path.isAbsolute(host.pipePath)) continue;
      const tools = await listCodexTools(host.pipePath, { signal, timeoutMs: Math.min(1500, Math.max(1, codexDeadline - Date.now())) });
      const messageTool = tools.find(tool => tool?.name === 'send_message_to_thread');
      const listTool = tools.find(tool => tool?.name === 'list_threads');
      if (typeof messageTool?.namespace !== 'string' || !messageTool.namespace ||
          messageTool.inputSchema?.properties?.threadId?.type !== 'string' ||
          messageTool.inputSchema?.properties?.prompt?.type !== 'string' ||
          typeof listTool?.namespace !== 'string' || !listTool.namespace ||
          !['integer', 'number'].includes(listTool.inputSchema?.properties?.limit?.type)) continue;
      compatible = true;
      if (typeof host.threadId !== 'string' || !host.threadId.trim()) continue;
      await listCodexChats({ pipePath: host.pipePath, contextThreadId: host.threadId, limit: 1, signal,
        timeoutMs: Math.min(1500, Math.max(1, codexDeadline - Date.now())) });
      acceptedContext = true;
      break;
    } catch { checkCancellation(signal); }
  }
  const codexIncomplete = !acceptedContext && codexChecked < candidates.length;
  add('codex_tools', compatible ? 'pass' : codexIncomplete ? 'warning' : 'fail', compatible
    ? 'Codex exposes compatible discovery and message tool schemas.'
    : codexIncomplete ? 'Some saved Codex endpoints were not checked within the diagnostic time budget. Availability is inconclusive.'
    : 'No checked Codex endpoint exposes compatible tools. Enable the bridge in Codex and check the application version.');
  add('codex_context', acceptedContext ? 'pass' : codexIncomplete ? 'warning' : 'fail', acceptedContext
    ? 'Codex accepted a registered context for read-only chat discovery.'
    : codexIncomplete ? 'Some retained Codex contexts were not checked within the diagnostic time budget. Availability is inconclusive.'
    : 'No checked Codex context accepted chat discovery. Run a bridge tool from an open Codex task to refresh registration.');
  let sessions = [];
  try {
    sessions = discoverClaudeSessions({ registryDir: config.registryDir });
    add('claude_registry', sessions.length ? 'pass' : 'fail', sessions.length
      ? 'Live Claude Desktop Code sessions are registered.'
      : 'No live Claude Desktop Code session is registered. Open its Code tab and enable the bridge.');
  } catch {
    add('claude_registry', 'fail', 'The Claude session registry is unreadable or invalid. Check Claude configuration and reopen its Code session.');
  }
  let inboxAvailable = false;
  const claudeDeadline = Date.now() + 4500;
  let claudeChecked = 0;
  for (const session of sessions) {
    if (Date.now() >= claudeDeadline) break;
    claudeChecked++;
    checkCancellation(signal);
    try {
      const endpoint = who?.kind === 'claude' && who.endpoint.sessionId === session.sessionId ? who.endpoint
        : resolveClaudeSession(session.sessionId, { registryDir: config.registryDir });
      await probeClaudeInbox({ socketPath: endpoint.socketPath, signal,
        timeoutMs: Math.min(1500, Math.max(1, claudeDeadline - Date.now())) });
      inboxAvailable = true;
      break;
    } catch { checkCancellation(signal); }
  }
  const claudeIncomplete = !inboxAvailable && claudeChecked < sessions.length;
  add('claude_inbox', inboxAvailable ? 'pass' : claudeIncomplete ? 'warning' : 'fail', inboxAvailable
    ? 'A verified Claude inbox accepts local connections. This check sent no message.'
    : claudeIncomplete ? 'Some Claude inboxes were not checked within the diagnostic time budget. Availability is inconclusive.'
    : 'No checked Claude inbox is available with a valid session key. Reopen the intended Desktop Code session.');
  return { application, ready: acceptedContext && inboxAvailable && checks.every(check => check.status !== 'fail'), checks };
}

export async function executeBridgeTool(name, args = {}, context = {}) {
  checkCancellation(context.signal);
  const config = settings(context);
  if (name === 'bridge_doctor') return bridgeDoctor(context, config);
  if (name === 'list_claude_sessions') return discoverClaudeSessions({ registryDir: config.registryDir });
  const publishesHost = ['send_to_claude', 'send_to_codex', 'bridge_ui_send', 'bridge_ui_retry_notice'].includes(name);
  const who = caller(context, config, { publish: publishesHost });
  if (['bridge_panel', 'bridge_ui_history', 'bridge_ui_send', 'bridge_ui_retry_notice'].includes(name)) {
    if (who.kind !== 'codex') throw new Error('Open the bridge panel from a Codex Desktop chat.');
    if (name === 'bridge_ui_send') {
      const { manualSend } = await import('./manual-service.mjs');
      return manualSend(args, context);
    }
    if (name === 'bridge_ui_retry_notice') {
      const { retryManualNotice } = await import('./manual-service.mjs');
      return retryManualNotice(args, context);
    }
    const { listClaudeConversations } = await import('./claude-history.mjs');
    const { getBridgeConversation } = await import('./bridge-history.mjs');
    if (name === 'bridge_ui_history') return getBridgeConversation({ stateDir: config.stateDir,
      ownerThreadId: who.threadId, sessionId: args.session_id, limit: args.limit, cursor: args.cursor, signal: context.signal });
    const catalog = await listClaudeConversations({ registryDir: config.registryDir,
      projectsDir: path.join(config.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'),
      stateDir: config.stateDir, ownerThreadId: who.threadId, signal: context.signal });
    return { owner_thread_id: who.threadId, application: 'codex', chats: catalog.conversations, warnings: catalog.warnings,
      composer_enter_behavior: readComposerEnterBehavior({ env: config.env }) };
  }
  if (name === 'list_codex_chats') {
    const host = await hostFor(who, config, context.signal);
    return listCodexChats({ pipePath: host.pipePath, contextThreadId: host.threadId, limit: args.limit || 30, signal: context.signal });
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
  const host = direction === 'to_codex' ? await hostFor(who, config, context.signal) : null;
  const route = { from: sender(who), to: direction === 'to_claude'
    ? { kind: 'claude', id: endpoint.sessionId }
    : { kind: 'codex', id: args.thread_id } };
  checkCancellation(context.signal);
  const session = senderLedger(who, config, true);
  checkCancellation(context.signal);
  const reserved = recordMessage(session, { id: args.message_id, direction, message: args.message, route,
    manual: context.manual === true });
  if (!reserved.created) {
    if (reserved.message.status === 'failed') {
      throw new Error('This message_id already has a failed attempt. Inspect the destination before retrying with a new message_id.');
    }
    if (reserved.message.status !== 'submitted') {
      throw new Error(`This message_id has ${reserved.message.status} delivery. No new send was made; inspect the destination and bridge_status before choosing a new message_id.`);
    }
    return { message: reserved.message, retransmitted: false };
  }
  let receipt;
  try {
    checkCancellation(context.signal);
    if (direction === 'to_claude') {
      const source = context.manual === true ? 'User sent from Codex Desktop task' : 'From Codex Desktop task';
      const notice = `[${source} ${JSON.stringify(route.from.id)}; bridge message ${JSON.stringify(reserved.message.id)}]\n\n${args.message}`;
      receipt = await sendToClaude({ ...endpoint, message: notice, senderName: senderLabel(route.from.id), signal: context.signal });
    } else {
      const notice = `[From Claude Desktop session ${JSON.stringify(route.from.id)}; bridge message ${JSON.stringify(reserved.message.id)}]\n\n${args.message}`;
      await sendToCodex({ pipePath: host.pipePath, contextThreadId: host.threadId,
        threadId: route.to.id, message: notice, signal: context.signal });
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
