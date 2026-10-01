import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = fs.readFileSync(new URL('../ui/bridge.html', import.meta.url), 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'The self-contained panel must contain its application script.');

class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {};
    this.style = { values: new Map(), setProperty(name, value) { this.values.set(name, value); }, getPropertyValue(name) { return this.values.get(name) || ''; } };
    this.className = ''; this.value = ''; this.hidden = false; this.disabled = false; this.listeners = new Map();
    this.scrollTop = 0; this.scrollHeight = 500; this.clientHeight = 200; this._text = ''; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  set innerHTML(value) { throw new Error('Transcript rendering must not use innerHTML.'); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; this.scrollHeight = nodes.length * 90; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  dispatch(type, props = {}) { for (const listener of this.listeners.get(type) || []) listener({ preventDefault() {}, key: '', isComposing: false, ...props }); }
  focus() { this.focused = true; }
  get classList() {
    const change = (name, on) => { const classes = new Set(this.className.split(/\s+/).filter(Boolean)); on ? classes.add(name) : classes.delete(name); this.className = [...classes].join(' '); };
    return { add: name => change(name, true), remove: name => change(name, false), toggle: (name, on) => change(name, on) };
  }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const flush = async () => { for (let index = 0; index < 18; index++) await Promise.resolve(); };

function harness(hash = '') {
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Node()]));
  const parent = {}; const outgoing = []; const listeners = new Map(); const timers = new Map(); const intervals = [];
  let timerId = 0; let uuid = 0;
  parent.postMessage = (message, origin) => outgoing.push({ message: JSON.parse(JSON.stringify(message)), origin });
  const window = { parent, addEventListener(type, listener) { listeners.set(type, listener); } };
  const document = { getElementById: id => nodes.get(id), createElement: tag => new Node(tag), documentElement: new Node('html'), visibilityState: 'visible' };
  const context = vm.createContext({ window, document, location: { hash }, TextEncoder, console,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: callback => intervals.push(callback),
  });
  const bootstrap = new vm.Script(`(async () => { ${script}\n })()`).runInContext(context);
  const emit = (message, { source = parent, origin = 'https://desktop.example' } = {}) => listeners.get('message')?.({ source, origin, data: message });
  const reply = (request, data, options = {}) => emit({ jsonrpc: '2.0', id: request.message.id, result: { structuredContent: data } }, options);
  const requests = name => outgoing.filter(entry => entry.message.method === 'tools/call' && entry.message.params.name === name);
  return { nodes, outgoing, parent, emit, reply, requests, bootstrap, document, intervals,
    node: id => nodes.get(id), uuidCount: () => uuid,
    async choose(sessionId, messages = [], page = {}) {
      const button = nodes.get('chat-list').children.find(child => child.dataset.sessionId === sessionId);
      assert.ok(button, `Conversation ${sessionId} must be visible.`); button.dispatch('click'); await flush();
      const request = requests('bridge_ui_history').at(-1);
      if (request?.message.params.arguments.session_id === sessionId) { reply(request, { session_id: sessionId, messages, has_more: false, next_cursor: null, ...page }); await flush(); }
    },
  };
}

const panel = {
  owner_thread_id: 'codex-owner', application: 'codex', chats: [
    { session_id: 'a', title: 'Bridge interface', cwd: 'C:/projects/bridge', live: true, last_contact_at: 1000, last_activity_at: 4000 },
    { session_id: 'b', title: 'Test review', cwd: 'C:/projects/tests', live: true, last_contact_at: 2000, last_activity_at: 3000 },
    { session_id: 'c', title: 'Archive', cwd: 'C:/projects/history', live: false, last_contact_at: 1000, last_activity_at: 2000 },
    { session_id: 'd', title: 'New session', cwd: 'C:/projects/prototype', live: true, last_contact_at: null, last_activity_at: 1000 },
  ],
};
async function live(h = harness()) {
  const request = h.outgoing[0];
  h.emit({ jsonrpc: '2.0', id: request.message.id, result: { protocolVersion: '2026-01-26', hostContext: { theme: 'dark' } } });
  await flush(); h.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: panel } }); await flush(); await h.bootstrap; return h;
}
const record = (id, text, extra = {}) => ({ id, message: text, direction: 'to_claude', created_at: 1000, status: 'submitted', ...extra });

test('panel negotiates the MCP Apps bridge and pins both parent source and origin', async () => {
  const h = harness(); const init = h.outgoing[0];
  assert.equal(init.message.method, 'ui/initialize'); assert.equal(init.origin, '*');
  h.emit({ jsonrpc: '2.0', id: init.message.id, result: { protocolVersion: '2026-01-26' } }, { source: {} });
  await flush(); assert.equal(h.requests('bridge_panel').length, 0);
  h.emit({ jsonrpc: '2.0', id: init.message.id, result: { protocolVersion: '2026-01-26', hostContext: { theme: 'dark' } } });
  await flush(); assert.equal(h.document.documentElement.dataset.theme, 'dark');
  assert.ok(h.outgoing.some(entry => entry.message.method === 'ui/notifications/initialized'));
  h.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: panel } }, { origin: 'https://untrusted.example' }); await flush(); assert.equal(h.node('chat-count').textContent, '0');
  h.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: panel } }); await flush(); await h.bootstrap; assert.equal(h.node('chat-count').textContent, '3 / 4');
  assert.equal(h.requests('bridge_ui_history').length, 0, 'No destination may be selected implicitly.');
  assert.equal(h.requests('bridge_ui_send').length, 0);
});

test('unsupported UI protocol fails visibly without loading tools', async () => {
  const h = harness(); h.emit({ jsonrpc: '2.0', id: h.outgoing[0].message.id, result: { protocolVersion: 'unsupported' } });
  await flush(); await h.bootstrap;
  assert.equal(h.node('connection-error').hidden, false); assert.match(h.node('connection-error').textContent, /supported UI version/);
  assert.equal(h.requests('bridge_panel').length, 0);
});

test('history errors replace the loading placeholder with a retryable state', async () => {
  const h = await live();
  const button = h.node('chat-list').children.find(child => child.dataset.sessionId === 'a');
  button.dispatch('click'); await flush();
  const request = h.requests('bridge_ui_history').at(-1);
  h.emit({ jsonrpc: '2.0', id: request.message.id, error: { message: 'History unavailable.' } }); await flush();
  assert.match(h.node('timeline').textContent, /History unavailable/);
  assert.doesNotMatch(h.node('timeline').textContent, /Loading history/);
  assert.match(h.node('alert-text').textContent, /History unavailable/);
});

test('native color, typography, and partial theme updates use host CSS variables', async () => {
  const h = harness(); const init = h.outgoing[0]; const style = h.document.documentElement.style;
  h.emit({ jsonrpc: '2.0', id: init.message.id, result: { protocolVersion: '2026-01-26', hostContext: { theme: 'dark', styles: { variables: {
    '--color-background-primary': '#181818', '--color-background-secondary': '#303030', '--color-background-tertiary': '#1b1b1b',
    '--color-text-primary': '#ffffff', '--color-border-secondary': '#292929', '--font-sans': 'Custom System Font', '--font-weight-normal': '430',
    '--font-text-md-size': '14px', color: 'unexpected',
  } } } } });
  await flush(); h.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: panel } }); await flush(); await h.bootstrap;
  assert.equal(style.getPropertyValue('--font-sans'), 'Custom System Font'); assert.equal(style.getPropertyValue('--font-weight-normal'), '430');
  assert.equal(style.getPropertyValue('--color-background-primary'), '#181818'); assert.equal(style.getPropertyValue('color'), '');
  h.emit({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { styles: { variables: { '--color-background-primary': '#faf7ee', '--color-text-primary': '#181611' } } } });
  await flush(); assert.equal(h.document.documentElement.dataset.theme, 'dark'); assert.equal(style.getPropertyValue('--color-background-primary'), '#faf7ee');
  assert.equal(style.getPropertyValue('--font-sans'), 'Custom System Font', 'A partial update must retain the chosen native font.');
  h.emit({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'light', styles: { variables: { '--color-background-secondary': '#eee8da' } } } });
  await flush(); assert.equal(h.document.documentElement.dataset.theme, 'light'); assert.equal(style.getPropertyValue('--color-background-secondary'), '#eee8da');
  h.emit({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { styles: { variables: { '--font-sans': 'Attacker Font' } } } }, { origin: 'https://untrusted.example' });
  await flush(); assert.equal(style.getPropertyValue('--font-sans'), 'Custom System Font');
  assert.match(html, /background: var\(--bg\)/); assert.match(html, /--bg: var\(--color-background-primary/);
  assert.match(html, /--sidebar: var\(--color-background-tertiary/); assert.match(html, /--composer: var\(--color-background-secondary/);
});

test('composer keeps Codex-like rhythm and a fixed circular send control', () => {
  assert.match(html, /\.composer \{ padding: 13px 14px 10px;/);
  assert.match(html, /\.composer-bottom \{[^}]*justify-content: flex-end/);
  assert.match(html, /\.composer-bottom \{[^}]*min-height: 32px/);
  assert.doesNotMatch(html, /\.composer-target::before/);
  assert.doesNotMatch(html, /<span class="composer-target"/);
  assert.match(html, /\.send-button \{[^}]*flex: 0 0 32px/);
  assert.match(html, /\.send-button \{[^}]*aspect-ratio: 1 \/ 1/);
  assert.match(html, /\.send-button \{[^}]*min-width: 32px/);
  assert.match(html, /\.send-button \{[^}]*max-width: 32px/);
});

test('per-chat drafts survive selection, search finds projects, and inactive history blocks sends', async () => {
  const h = await live(); await h.choose('a');
  h.node('message').value = 'Draft A'; h.node('message').dispatch('input');
  await h.choose('b'); assert.equal(h.node('message').value, ''); h.node('message').value = 'Draft B'; h.node('message').dispatch('input');
  await h.choose('a'); assert.equal(h.node('message').value, 'Draft A');
  await h.choose('c', [record('archive', 'History is available.')]);
  assert.equal(h.node('composer').hidden, true); assert.match(h.node('inactive-title').textContent, /inactive/);
  h.node('message').dispatch('keydown', { key: 'Enter', ctrlKey: true }); await flush(); assert.equal(h.requests('bridge_ui_send').length, 0);
  h.node('tab-all').dispatch('click'); h.node('search').value = 'prototype'; h.node('search').dispatch('input');
  assert.deepEqual(h.node('chat-list').children.map(node => node.dataset.sessionId), ['d']);
});

test('composer follows Codex keyboard behavior: Enter sends and Shift+Enter inserts a newline', async () => {
  const h = await live(); await h.choose('a');
  h.node('message').value = 'Send with Enter'; h.node('message').dispatch('input');
  h.node('message').dispatch('keydown', { key: 'Enter' }); await flush();
  assert.equal(h.requests('bridge_ui_send').length, 1);
  const send = h.requests('bridge_ui_send').at(-1);
  h.reply(send, { message: record(send.message.params.arguments.message_id, 'Send with Enter', { manual: true, notice_status: 'submitted' }), manual: true, notice_status: 'submitted' }); await flush();
  h.reply(h.requests('bridge_ui_history').at(-1), { session_id: 'a', messages: [record('sent', 'Send with Enter')], has_more: false, next_cursor: null }); await flush();

  const second = await live(); await second.choose('a');
  second.node('message').value = 'First line'; second.node('message').dispatch('input');
  second.node('message').dispatch('keydown', { key: 'Enter', shiftKey: true }); await flush();
  assert.equal(second.requests('bridge_ui_send').length, 0);
  assert.equal(second.node('message').value, 'First line');
});

test('uncertain manual delivery keeps one UUID, blocks resend, and recovers only from recorded history', async () => {
  const h = await live(); await h.choose('a'); h.node('message').value = 'Exact text'; h.node('message').dispatch('input');
  h.node('composer').dispatch('submit'); await flush();
  const send = h.requests('bridge_ui_send').at(-1); const args = send.message.params.arguments;
  assert.deepEqual(Object.keys(args).sort(), ['message', 'message_id', 'session_id']); assert.equal(args.session_id, 'a'); assert.equal(args.message, 'Exact text');
  h.emit({ jsonrpc: '2.0', id: send.message.id, result: { isError: true, content: [{ type: 'text', text: 'Transport ended.' }] } }); await flush();
  assert.equal(h.uuidCount(), 1); assert.equal(h.node('composer').hidden, true); assert.match(h.node('inactive-detail').textContent, /message ID were saved/);
  h.node('composer').dispatch('submit'); h.node('message').dispatch('keydown', { key: 'Enter', metaKey: true }); await flush();
  assert.equal(h.requests('bridge_ui_send').length, 1);
  h.node('refresh').dispatch('click'); await flush(); h.reply(h.requests('bridge_panel').at(-1), panel); await flush();
  h.reply(h.requests('bridge_ui_history').at(-1), { session_id: 'a', messages: [record(args.message_id, args.message, { status: 'uncertain', manual: true })], has_more: false, next_cursor: null }); await flush();
  assert.equal(h.node('composer').hidden, true); assert.equal(h.uuidCount(), 1);
  h.node('refresh').dispatch('click'); await flush(); h.reply(h.requests('bridge_panel').at(-1), panel); await flush();
  h.reply(h.requests('bridge_ui_history').at(-1), { session_id: 'a', messages: [record(args.message_id, args.message, { manual: true })], has_more: false, next_cursor: null }); await flush();
  assert.equal(h.node('composer').hidden, false); assert.equal(h.node('message').value, ''); assert.equal(h.requests('bridge_ui_send').length, 1);
});

test('messages remain literal text and pagination prepends without moving the visible anchor', async () => {
  const h = await live(); const text = '<img src=x onerror="steal()"> & <script>run()</script>';
  await h.choose('a', [record('recent', text), record('reply', 'Reply', { direction: 'to_codex', created_at: 2000 })], { has_more: true, next_cursor: 'older-page' });
  const pane = h.node('timeline'); assert.ok(descendants(pane).some(node => node.className === 'bubble' && node.textContent === text));
  pane.scrollTop = 50; const height = pane.scrollHeight;
  descendants(pane).find(node => node.tagName === 'button' && node.textContent === 'Load earlier messages').dispatch('click'); await flush();
  const request = h.requests('bridge_ui_history').at(-1); assert.equal(request.message.params.arguments.cursor, 'older-page');
  h.reply(request, { session_id: 'a', messages: [record('older', 'Earlier message', { created_at: 500 })], has_more: false, next_cursor: null }); await flush();
  assert.deepEqual(descendants(pane).filter(node => node.className === 'bubble').map(node => node.textContent), ['Earlier message', text, 'Reply']);
  assert.equal(pane.scrollTop, 50 + pane.scrollHeight - height);
  assert.ok(descendants(pane).some(node => node.className === 'message-label' && node.textContent === 'Codex'), 'Automatic agent messages must not be attributed to the human.');
});

test('background refresh preserves an earlier reading position while merging new messages', async () => {
  const h = await live(); const messages = [record('one', 'First'), record('two', 'Second', { created_at: 2000 }), record('three', 'Third', { created_at: 3000 })];
  await h.choose('a', messages); const pane = h.node('timeline'); pane.scrollTop = 30;
  h.intervals[0](); await flush(); h.reply(h.requests('bridge_panel').at(-1), panel); await flush();
  assert.equal(pane.scrollTop, 30, 'Refreshing chat metadata must not jump to the latest message.');
  h.reply(h.requests('bridge_ui_history').at(-1), { session_id: 'a', messages: [...messages, record('four', 'New', { created_at: 4000 })], has_more: false, next_cursor: null }); await flush();
  assert.equal(pane.scrollTop, 30); assert.ok(descendants(pane).some(node => node.className === 'bubble' && node.textContent === 'New'));
});

test('Codex notice retry is explicit and available only after definitive failure, without a Claude send', async () => {
  const h = await live(); await h.choose('a', [
    record('safe', 'Already delivered to Claude.', { manual: true, notice_status: 'failed', notice_retryable: true }),
    record('unknown', 'Notice status is uncertain.', { manual: true, notice_status: 'uncertain', notice_retryable: false }),
    record('unsafe', 'Result write failed.', { manual: true, notice_status: 'failed', notice_retryable: false }),
  ]);
  const buttons = descendants(h.node('timeline')).filter(node => node.textContent === 'Retry Codex notification'); assert.equal(buttons.length, 1);
  assert.equal(h.requests('bridge_ui_retry_notice').length, 0); buttons[0].dispatch('click'); buttons[0].dispatch('click'); await flush();
  const retry = h.requests('bridge_ui_retry_notice').at(-1); assert.deepEqual(retry.message.params.arguments, { session_id: 'a', message_id: 'safe' });
  assert.equal(h.requests('bridge_ui_retry_notice').length, 1); assert.equal(h.requests('bridge_ui_send').length, 0);
  h.reply(retry, { message: record('safe', 'Already delivered to Claude.'), manual: true, notice_status: 'submitted', notice_retryable: false }); await flush();
  h.reply(h.requests('bridge_ui_history').at(-1), { session_id: 'a', messages: [record('safe', 'Already delivered to Claude.', { manual: true, notice_status: 'submitted' })], has_more: false, next_cursor: null }); await flush();
  assert.equal(h.requests('bridge_ui_send').length, 0);
});

test('owner-context changes disable sending, and demo never calls a real host', async () => {
  const h = await live(); await h.choose('a'); h.node('message').value = 'Draft'; h.node('message').dispatch('input');
  h.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { ...panel, owner_thread_id: 'different-owner' } } }); await flush();
  assert.equal(h.node('send').disabled, true); assert.match(h.node('connection-error').textContent, /Codex context changed/);
  const d = harness('#demo'); await flush(); await d.bootstrap;
  assert.equal(d.node('demo-banner').hidden, false); assert.match(d.node('demo-banner').textContent || html, /No real messages are sent/);
  d.node('message').value = 'Demo only'; d.node('message').dispatch('input'); d.node('composer').dispatch('submit'); await flush();
  assert.equal(d.outgoing.length, 0); assert.ok(descendants(d.node('timeline')).some(node => node.className === 'bubble' && node.textContent === 'Demo only'));
});
