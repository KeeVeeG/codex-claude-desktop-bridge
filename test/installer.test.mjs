import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareInstallation, installApplications, writeJsonAtomic, PLUGIN_NAME, RUNTIME_FILES, CLAUDE_SEND_PERMISSION, grantClaudeSendPermission } from '../scripts/install.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(root, 'work');

function fixture(t) {
  fs.mkdirSync(work, { recursive: true });
  const homeDir = fs.mkdtempSync(path.join(work, 'installer-concurrency-'));
  t.after(() => {
    const resolved = fs.realpathSync(homeDir);
    const relative = path.relative(fs.realpathSync(work), resolved);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok(path.basename(resolved).startsWith('installer-concurrency-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const marketplacePath = path.join(homeDir, '.agents', 'plugins', 'marketplace.json');
  fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
  return { homeDir, marketplacePath };
}

function stagedServer(destination, manifestDirectory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(destination, manifestDirectory, 'plugin.json'), 'utf8'));
  if (typeof manifest.mcpServers === 'string') {
    const config = JSON.parse(fs.readFileSync(path.resolve(destination, manifest.mcpServers), 'utf8'));
    return config.mcpServers[PLUGIN_NAME];
  }
  return manifest.mcpServers[PLUGIN_NAME];
}

async function probeMcpStartup(server, cwd, env) {
  const child = spawn(server.command, server.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  return await new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    let initialize;
    let tools;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`Staged MCP startup timed out: ${stderr}`)), 10_000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) { child.kill(); reject(error); }
      else resolve({ initialize, tools });
    }
    function send(message) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); });
    child.on('error', finish);
    child.stdin.on('error', finish);
    child.once('spawn', () => send({ id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'staged-plugin-startup-test', version: '1.0.0' },
    } }));
    child.stdout.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { finish(new Error('Staged MCP stdout was not protocol JSON.')); return; }
        if (message.error) { finish(new Error(`Staged MCP protocol error: ${JSON.stringify(message.error)}`)); return; }
        if (message.id === 1) {
          initialize = message.result;
          send({ method: 'notifications/initialized', params: {} });
          send({ id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          tools = message.result?.tools;
          child.stdin.end();
        }
      }
    });
    child.once('close', code => {
      if (code !== 0) finish(new Error(`Staged MCP exited with ${code}: ${stderr}`));
      else if (!initialize || !Array.isArray(tools)) finish(new Error(`Staged MCP exited without completing initialization and tools/list: ${stderr}`));
      else finish();
    });
  });
}

test('installer merges a marketplace entry added while runtime files are staging', t => {
  const { homeDir, marketplacePath } = fixture(t);
  const original = { name: 'keep-this-marketplace', interface: { displayName: 'Keep this name' }, plugins: [] };
  fs.writeFileSync(marketplacePath, JSON.stringify(original));
  const added = { name: 'concurrent-plugin', source: { source: 'local', path: './plugins/concurrent-plugin' }, category: 'Custom' };
  const copy = fs.copyFileSync;
  let injected = false;
  fs.copyFileSync = (...args) => {
    const result = copy(...args);
    if (!injected) {
      injected = true;
      fs.writeFileSync(marketplacePath, JSON.stringify({ ...original, plugins: [added] }));
    }
    return result;
  };
  try {
    prepareInstallation({ sourceRoot: root, homeDir, codex: true, claude: false });
  } finally {
    fs.copyFileSync = copy;
  }
  const saved = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
  assert.ok(injected);
  assert.equal(saved.name, original.name);
  assert.deepEqual(saved.interface, original.interface);
  assert.deepEqual(saved.plugins[0], added);
  assert.equal(saved.plugins[1].name, PLUGIN_NAME);
});

test('atomic JSON writer preserves an external catalog change made before replacement', t => {
  const { marketplacePath } = fixture(t);
  const previous = '{"name":"before","plugins":[]}\n';
  const newer = '{"name":"external-writer","plugins":[]}\n';
  fs.writeFileSync(marketplacePath, previous);
  const write = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = (filename, ...args) => {
    const result = write(filename, ...args);
    if (!injected && String(filename).startsWith(`${marketplacePath}.tmp-`)) {
      injected = true;
      write(marketplacePath, newer);
    }
    return result;
  };
  try {
    assert.throws(() => writeJsonAtomic(marketplacePath, { name: 'installer', plugins: [] }, { expectedPrevious: previous }), /changed before replacement/);
  } finally {
    fs.writeFileSync = write;
  }
  assert.ok(injected);
  assert.equal(fs.readFileSync(marketplacePath, 'utf8'), newer);
  assert.ok(!fs.readdirSync(path.dirname(marketplacePath)).some(name => name.includes('.tmp-')));
});

test('atomic JSON writer refuses a snapshot that was already replaced', t => {
  const { marketplacePath } = fixture(t);
  const latest = '{"name":"latest","plugins":[]}\n';
  fs.writeFileSync(marketplacePath, latest);
  assert.throws(() => writeJsonAtomic(marketplacePath, { name: 'installer' }, { expectedPrevious: null }), /changed during installation/);
  assert.equal(fs.readFileSync(marketplacePath, 'utf8'), latest);
});

test('both staged plugins share a profile state path despite different MSIX LOCALAPPDATA values', t => {
  const { homeDir } = fixture(t);
  const sourceFile = path.join(root, '.mcp.json');
  const sourceBefore = fs.readFileSync(sourceFile, 'utf8');
  const expected = path.join(homeDir, '.local', 'share', PLUGIN_NAME);
  const statePaths = [];
  for (const application of ['Codex', 'Claude']) {
    const localAppData = path.join(homeDir, 'Packages', application, 'LocalCache', 'Local');
    const prepared = prepareInstallation({ sourceRoot: root, homeDir, env: { LOCALAPPDATA: localAppData } });
    assert.equal(prepared.stateDir, expected);
    assert.ok(path.isAbsolute(prepared.stateDir));
    assert.ok(!prepared.stateDir.startsWith(localAppData));
    for (const manifestDirectory of ['.codex-plugin', '.claude-plugin']) {
      statePaths.push(stagedServer(prepared.destination, manifestDirectory).env.CODEX_CLAUDE_BRIDGE_STATE_DIR);
    }
  }
  assert.deepEqual(statePaths, [expected, expected, expected, expected]);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), sourceBefore);
});

test('installer pins an explicit shared state override without changing portable source config', t => {
  const { homeDir } = fixture(t);
  const sourceFile = path.join(root, '.mcp.json');
  const sourceBefore = fs.readFileSync(sourceFile, 'utf8');
  const override = path.join(homeDir, 'chosen-shared-state');
  const prepared = prepareInstallation({ sourceRoot: root, homeDir, codex: false, claude: true,
    env: { CODEX_CLAUDE_BRIDGE_STATE_DIR: override, LOCALAPPDATA: path.join(homeDir, 'app-private') } });
  const config = JSON.parse(fs.readFileSync(path.join(prepared.destination, '.mcp.json'), 'utf8'));
  assert.equal(prepared.stateDir, override);
  assert.equal(config.mcpServers[PLUGIN_NAME].env.CODEX_CLAUDE_BRIDGE_STATE_DIR, override);
  assert.equal(stagedServer(prepared.destination, '.codex-plugin').env.CODEX_CLAUDE_BRIDGE_STATE_DIR, override);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), sourceBefore);
});

test('staged Codex and Claude configurations start five MCP tools from Unicode paths and an unrelated working directory', async t => {
  const { homeDir } = fixture(t);
  const sourceCodexPath = path.join(root, '.codex-plugin', 'plugin.json');
  const sourceClaudeConfigPath = path.join(root, '.mcp.json');
  const originalCodex = fs.readFileSync(sourceCodexPath, 'utf8');
  const originalClaude = fs.readFileSync(sourceClaudeConfigPath, 'utf8');
  const prepared = prepareInstallation({ sourceRoot: root, homeDir });
  const copiedRoot = path.join(homeDir, 'installed copy with spaces', 'плагин Claude Codex');
  // Node 22 on Windows may omit dot-prefixed plugin directories in a recursive
  // copy. Copy the staged runtime allowlist explicitly for this launch probe.
  for (const relative of RUNTIME_FILES) {
    const destination = path.join(copiedRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(prepared.destination, relative), destination);
  }
  const unrelatedCwd = path.join(homeDir, 'unrelated project directory');
  fs.mkdirSync(unrelatedCwd);
  const codexManifest = JSON.parse(fs.readFileSync(path.join(copiedRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(typeof codexManifest.mcpServers, 'object', 'Codex needs inline config because its legacy file loader does not expand the Claude macro');
  const codex = stagedServer(copiedRoot, '.codex-plugin');
  const claude = stagedServer(copiedRoot, '.claude-plugin');
  assert.equal(codex.cwd, './');
  assert.ok(codex.args.every(value => !value.includes('${CLAUDE_PLUGIN_ROOT}')));
  assert.ok(claude.args.some(value => value.includes('${CLAUDE_PLUGIN_ROOT}')));
  const expectedTools = ['bridge_status', 'list_claude_sessions', 'list_codex_chats', 'send_to_claude', 'send_to_codex'];
  for (const [application, config] of [['Codex', codex], ['Claude', claude]]) {
    assert.equal(config.env.CODEX_CLAUDE_BRIDGE_STATE_DIR, prepared.stateDir);
    const env = { ...process.env, ...config.env, HOME: homeDir, USERPROFILE: homeDir, LOCALAPPDATA: path.join(homeDir, `${application} app cache`) };
    for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_APP_TOOLS_PIPE_PATH',
      'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']) delete env[key];
    const expandClaude = value => value.replaceAll('${CLAUDE_PLUGIN_ROOT}', copiedRoot);
    const launch = application === 'Codex'
      ? { command: config.command, args: config.args }
      : { command: expandClaude(config.command), args: config.args.map(expandClaude) };
    // Codex anchors the inline relative cwd to its installed plugin root.
    // Claude expands its root macro and can retain the unrelated project cwd.
    const launchCwd = application === 'Codex' ? path.resolve(copiedRoot, config.cwd) : unrelatedCwd;
    assert.notEqual(copiedRoot, unrelatedCwd);
    const result = await probeMcpStartup(launch, launchCwd, env);
    assert.deepEqual(result.initialize.capabilities.tools, {});
    assert.deepEqual(result.tools.map(tool => tool.name).sort(), expectedTools, `${application} startup must expose the complete catalog without a tool call`);
  }
  assert.equal(fs.readFileSync(sourceCodexPath, 'utf8'), originalCodex);
  assert.equal(fs.readFileSync(sourceClaudeConfigPath, 'utf8'), originalClaude);
  assert.equal(fs.existsSync(path.join(prepared.stateDir, 'codex-host.json')), false, 'startup tests must not publish a live app endpoint');
});

test('explicit Claude permission grant creates only the exact send_to_codex allow rule', t => {
  const { homeDir } = fixture(t);
  const settingsFile = path.join(homeDir, '.claude', 'settings.json');
  assert.equal(CLAUDE_SEND_PERMISSION, 'mcp__plugin_codex-claude-desktop-bridge_codex-claude-desktop-bridge__send_to_codex');
  grantClaudeSendPermission({ homeDir, env: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), {
    permissions: { allow: [CLAUDE_SEND_PERMISSION] },
  });
  assert.ok(!fs.readdirSync(path.dirname(settingsFile)).some(name => name.startsWith('settings.json.backup-')));
});

test('Claude permission grant preserves settings, backs up exact previous bytes, and is idempotent', t => {
  const { homeDir } = fixture(t);
  const settingsFile = path.join(homeDir, '.claude', 'settings.json');
  const existing = {
    model: 'existing-model', env: { KEEP_THIS: 'unchanged' },
    enabledPlugins: { 'existing@marketplace': true },
    permissions: {
      allow: ['Read', `${CLAUDE_SEND_PERMISSION}_other_tool`],
      deny: ['Bash(rm *)'], ask: ['Write'], defaultMode: 'auto',
      additionalDirectories: ['C:/existing/project'],
    },
  };
  const original = `${JSON.stringify(existing, null, 4)}\r\n`;
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, original);
  grantClaudeSendPermission({ homeDir, env: {} });
  const written = fs.readFileSync(settingsFile, 'utf8');
  assert.deepEqual(JSON.parse(written), {
    ...existing, permissions: { ...existing.permissions, allow: [...existing.permissions.allow, CLAUDE_SEND_PERMISSION] },
  });
  const backups = fs.readdirSync(path.dirname(settingsFile)).filter(name => name.startsWith('settings.json.backup-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(settingsFile), backups[0]), 'utf8'), original);
  const beforeRepeat = fs.statSync(settingsFile).mtimeMs;
  grantClaudeSendPermission({ homeDir, env: {} });
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), written);
  assert.equal(fs.statSync(settingsFile).mtimeMs, beforeRepeat);
  assert.deepEqual(fs.readdirSync(path.dirname(settingsFile)).filter(name => name.startsWith('settings.json.backup-')), backups);
});

test('Claude permission grant respects a custom config directory and leaves the default profile untouched', t => {
  const { homeDir } = fixture(t);
  const defaultFile = path.join(homeDir, '.claude', 'settings.json');
  const customDir = path.join(homeDir, 'custom Claude config', 'профиль');
  fs.mkdirSync(path.dirname(defaultFile), { recursive: true });
  fs.writeFileSync(defaultFile, '{"model":"default-profile"}\n');
  grantClaudeSendPermission({ homeDir, env: { CLAUDE_CONFIG_DIR: customDir } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(customDir, 'settings.json'), 'utf8')), {
    permissions: { allow: [CLAUDE_SEND_PERMISSION] },
  });
  assert.equal(fs.readFileSync(defaultFile, 'utf8'), '{"model":"default-profile"}\n');
});

test('Claude permission grant refuses exact deny or ask conflicts without removing user rules', async t => {
  for (const conflictKind of ['deny', 'ask']) {
    await t.test(conflictKind, sub => {
      const { homeDir } = fixture(sub);
      const settingsFile = path.join(homeDir, '.claude', 'settings.json');
      const original = JSON.stringify({ permissions: { allow: ['Read'], [conflictKind]: [CLAUDE_SEND_PERMISSION] }, keep: 'unchanged' });
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, original);
      assert.throws(() => grantClaudeSendPermission({ homeDir, env: {} }), /deny|ask|conflict/i);
      assert.equal(fs.readFileSync(settingsFile, 'utf8'), original);
      assert.ok(!fs.readdirSync(path.dirname(settingsFile)).some(name => name.startsWith('settings.json.backup-') || name.includes('.tmp-')));
    });
  }
});

test('Claude permission grant respects wildcard and whole-server deny or ask rules', async t => {
  for (const [name, field, rule] of [
    ['wildcard deny', 'deny', 'mcp__*__send_to_codex'],
    ['wildcard ask', 'ask', `${CLAUDE_SEND_PERMISSION.slice(0, CLAUDE_SEND_PERMISSION.lastIndexOf('__'))}__*`],
    ['whole server deny', 'deny', CLAUDE_SEND_PERMISSION.slice(0, CLAUDE_SEND_PERMISSION.lastIndexOf('__'))],
  ]) {
    await t.test(name, sub => {
      const { homeDir } = fixture(sub);
      const settingsFile = path.join(homeDir, '.claude', 'settings.json');
      const original = JSON.stringify({ permissions: { allow: ['Read'], [field]: [rule] } });
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, original);
      assert.throws(() => grantClaudeSendPermission({ homeDir, env: {} }), /already matches|conflict/i);
      assert.equal(fs.readFileSync(settingsFile, 'utf8'), original);
    });
  }
});

test('Claude permission grant does not overwrite malformed settings or incompatible permission shapes', async t => {
  for (const [name, original] of [
    ['invalid JSON', '{not valid JSON'],
    ['settings array', '[]'],
    ['permissions string', '{"permissions":"do not replace me"}'],
    ['allow object', '{"permissions":{"allow":{"unexpected":true}}}'],
  ]) {
    await t.test(name, sub => {
      const { homeDir } = fixture(sub);
      const settingsFile = path.join(homeDir, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, original);
      assert.throws(() => grantClaudeSendPermission({ homeDir, env: {} }));
      assert.equal(fs.readFileSync(settingsFile, 'utf8'), original);
    });
  }
});

test('Claude permission grant preserves a concurrent settings edit instead of replacing it', t => {
  const { homeDir } = fixture(t);
  const settingsFile = path.join(homeDir, '.claude', 'settings.json');
  const original = '{"permissions":{"allow":["Read"]},"model":"before"}\n';
  const newer = '{"permissions":{"allow":["Read"],"deny":["Bash"]},"model":"concurrent"}\n';
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, original);
  const write = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = (filename, ...args) => {
    const result = write(filename, ...args);
    if (!injected && String(filename).startsWith(`${settingsFile}.tmp-`)) {
      injected = true;
      write(settingsFile, newer);
    }
    return result;
  };
  try {
    assert.throws(() => grantClaudeSendPermission({ homeDir, env: {} }), /changed|conflict/i);
  } finally {
    fs.writeFileSync = write;
  }
  assert.ok(injected, 'the collision must occur while permission settings are being staged');
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), newer);
  assert.ok(!fs.readdirSync(path.dirname(settingsFile)).some(name => name.includes('.tmp-')));
});

test('normal all-app and Claude-only installations grant exactly send_to_codex and preserve existing settings', async t => {
  for (const codex of [true, false]) {
    await t.test(codex ? 'all applications' : 'Claude only', sub => {
      const { homeDir } = fixture(sub);
      const settingsFile = path.join(homeDir, '.claude', 'settings.json');
      const existing = { permissions: { allow: ['Read'], ask: ['Write'], deny: ['Bash(rm *)'], defaultMode: 'auto' }, model: 'keep', enabledPlugins: { 'another@market': true } };
      const original = `${JSON.stringify(existing)}\n`;
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, original);
      const prepared = prepareInstallation({ sourceRoot: root, homeDir, env: {}, codex, claude: true });
      assert.equal(fs.readFileSync(settingsFile, 'utf8'), original, 'staging alone must not grant permissions');
      const applicationCalls = [];
      installApplications(prepared, {
        homeDir, env: {}, log() {},
        execute(command, args) {
          applicationCalls.push([command, args]);
          assert.equal(fs.readFileSync(settingsFile, 'utf8'), original, 'permission grant occurs only after successful application installation');
          return JSON.stringify([]);
        },
      });
      assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), {
        ...existing, permissions: { ...existing.permissions, allow: ['Read', CLAUDE_SEND_PERMISSION] },
      });
      assert.equal(applicationCalls.some(([command]) => command === 'codex'), codex);
      assert.ok(applicationCalls.some(([command, args]) => command === 'claude' && args[0] === 'plugin' && args[1] === 'install'));
      const backups = fs.readdirSync(path.dirname(settingsFile)).filter(name => name.startsWith('settings.json.backup-'));
      assert.equal(backups.length, 1);
      assert.equal(fs.readFileSync(path.join(path.dirname(settingsFile), backups[0]), 'utf8'), original);
    });
  }
});

test('Codex-only installation and preparation-only staging do not grant Claude permissions', t => {
  const { homeDir } = fixture(t);
  const settingsFile = path.join(homeDir, '.claude', 'settings.json');
  for (const existing of [false, true]) {
    const original = '{"permissions":{"allow":["Read"],"ask":["Write"]},"model":"keep"}\n';
    if (existing) {
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, original);
    }
    prepareInstallation({ sourceRoot: root, homeDir, env: {}, codex: true, claude: true });
    const codexOnly = prepareInstallation({ sourceRoot: root, homeDir, env: {}, codex: true, claude: false });
    installApplications(codexOnly, {
      homeDir, env: {}, log() {},
      execute(command) { assert.equal(command, 'codex'); return JSON.stringify({}); },
      grantPermission() { assert.fail('Codex-only installation must not grant a Claude permission'); },
    });
    if (existing) assert.equal(fs.readFileSync(settingsFile, 'utf8'), original);
    else assert.equal(fs.existsSync(settingsFile), false);
  }
  assert.ok(!fs.readdirSync(path.dirname(settingsFile)).some(name => name.startsWith('settings.json.backup-')));
});

test('failed Claude plugin installation does not grant send_to_codex permission', t => {
  const { homeDir } = fixture(t);
  const prepared = prepareInstallation({ sourceRoot: root, homeDir, env: {}, codex: false, claude: true });
  assert.throws(() => installApplications(prepared, {
    homeDir, env: {}, log() {},
    execute(command, args) {
      assert.equal(command, 'claude');
      if (args[0] === 'plugin' && args[1] === 'install') throw new Error('Simulated Claude installation failure');
      return JSON.stringify([]);
    },
    grantPermission() { assert.fail('A failed installation must not grant permission'); },
  }), /Simulated Claude installation failure/);
  assert.equal(fs.existsSync(path.join(homeDir, '.claude', 'settings.json')), false);
});
