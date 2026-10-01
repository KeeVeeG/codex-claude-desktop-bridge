import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPackages, zipEntries } from '../scripts/package.mjs';
import { PLUGIN_NAME, PLUGIN_SCHEMA, MCP_SCHEMA, PORTABLE_RUNTIME_FILES, NATIVE_RUNTIME_FILES,
  checkManifests, syncManifests, validateCanonical } from '../scripts/manifests.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(root, 'work');
const json = value => JSON.stringify(value, null, 2) + '\n';

function fixture(t) {
  fs.mkdirSync(work, { recursive: true });
  const directory = fs.mkdtempSync(path.join(work, 'packaging-'));
  t.after(() => {
    const actual = fs.realpathSync(directory);
    assert.equal(path.dirname(actual), fs.realpathSync(work));
    assert.ok(path.basename(actual).startsWith('packaging-'));
    fs.rmSync(actual, { recursive: true, force: true });
  });
  return directory;
}

function copySource(t) {
  const directory = fixture(t);
  const source = path.join(directory, 'source');
  for (const relative of PORTABLE_RUNTIME_FILES) {
    const target = path.join(source, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relative), target);
  }
  syncManifests(source);
  return { directory, source };
}

function unzipStored(buffer) {
  const files = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset + 8), 0, 'release ZIP entries use stored data');
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    assert.ok(!files.has(name), 'ZIP must not contain duplicate names');
    const start = offset + 30 + nameLength + extraLength;
    files.set(name, buffer.subarray(start, start + size));
    offset = start + size;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'local entries must be followed by a central directory');
  return files;
}

test('canonical Agent Plugins metadata generates the checked-in native adapters and exact runtime subtree', () => {
  const bundle = checkManifests(root);
  assert.equal(bundle.manifest.$schema, PLUGIN_SCHEMA);
  assert.equal(bundle.mcp.$schema, MCP_SCHEMA);
  assert.equal(bundle.files['.codex-plugin/plugin.json'].name, bundle.manifest.name);
  assert.equal(bundle.files['.claude-plugin/plugin.json'].version, bundle.manifest.version);
  assert.deepEqual(bundle.files['.codex-plugin/plugin.json'].interface, bundle.manifest.extensions['com.openai'].interface);
  assert.deepEqual(bundle.manifest.extensions['com.openai'].interface.capabilities, ['Read', 'Write']);
  assert.ok(bundle.files['.codex-plugin/plugin.json'].mcpServers[PLUGIN_NAME].env_vars.includes('CODEX_APP_TOOLS_PIPE_PATH'));
  assert.equal(bundle.mcp.mcpServers[PLUGIN_NAME].env_vars, undefined, 'portable 1.0 rejects native env_vars');
  const catalog = JSON.parse(fs.readFileSync(path.join(root, '.agents/plugins/marketplace.json'), 'utf8'));
  assert.equal(catalog.plugins[0].source.source, 'git-subdir');
  assert.equal(catalog.plugins[0].source.path, './compatibility/native');
  const claude = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(claude.plugins[0].source, './compatibility/native');
});

test('portable configuration rejects native-only fields, unknown schemas, and reserved environment overrides', () => {
  const bundle = checkManifests(root);
  for (const mutate of [
    (manifest, mcp) => { mcp.mcpServers[PLUGIN_NAME].env_vars = ['CODEX_APP_TOOLS_PIPE_PATH']; },
    (manifest, mcp) => { mcp.$schema = 'https://agent-plugins.org/schemas/2.0.0/mcp.schema.json'; },
    (manifest, mcp) => { mcp.mcpServers[PLUGIN_NAME].env = { plugin_root: 'override' }; },
    (manifest, mcp) => { mcp.mcpServers[PLUGIN_NAME].cwd = '../outside'; },
    manifest => { manifest.skills = './skills'; },
  ]) {
    const manifest = structuredClone(bundle.manifest), mcp = structuredClone(bundle.mcp);
    mutate(manifest, mcp);
    assert.throws(() => validateCanonical(manifest, mcp), /Invalid|requires/);
  }
});

test('packaging stops on manifest identity/version drift or generated native runtime drift', async t => {
  for (const [name, relative, mutate] of [
    ['package version', 'package.json', value => { value.version = '99.0.0'; }],
    ['Claude identity', '.claude-plugin/plugin.json', value => { value.name = 'another-plugin'; }],
    ['Codex command', '.codex-plugin/plugin.json', value => { value.mcpServers[PLUGIN_NAME].args = ['./unreviewed.mjs']; }],
    ['Claude command', '.mcp.json', value => { value.mcpServers[PLUGIN_NAME].command = 'unreviewed'; }],
  ]) {
    await t.test(name, sub => {
      const { directory, source } = copySource(sub);
      const filename = path.join(source, relative);
      const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
      mutate(value); fs.writeFileSync(filename, json(value));
      const outputDir = path.join(directory, 'output');
      assert.throws(() => buildPackages({ sourceRoot: source, outputDir }), /differs/);
      assert.equal(fs.existsSync(outputDir), false, 'drift must fail before release artifacts are written');
    });
  }
  await t.test('native source drift', sub => {
    const { directory, source } = copySource(sub);
    fs.appendFileSync(path.join(source, 'compatibility/native/lib/codex-desktop.mjs'), '\n// stale copy\n');
    assert.throws(() => buildPackages({ sourceRoot: source, outputDir: path.join(directory, 'output') }), /differs/);
  });
});

test('release ZIPs contain exactly the native or portable allowlist and reproducible bytes with verified checksums', t => {
  const { directory, source } = copySource(t);
  fs.writeFileSync(path.join(source, 'credentials.key'), 'not-a-real-secret');
  fs.writeFileSync(path.join(source, 'state.json'), '{"local":"not-for-release"}');
  const first = buildPackages({ sourceRoot: source, outputDir: path.join(directory, 'first') });
  const second = buildPackages({ sourceRoot: source, outputDir: path.join(directory, 'second') });
  assert.equal(first.archives.length, 3);
  for (let index = 0; index < first.archives.length; index++) {
    assert.deepEqual(fs.readFileSync(first.archives[index]), fs.readFileSync(second.archives[index]));
  }
  const native = unzipStored(fs.readFileSync(first.archives[0]));
  assert.deepEqual([...native.keys()].sort(), [...NATIVE_RUNTIME_FILES].sort());
  assert.equal(native.has('plugin.json'), false);
  assert.equal(native.has('mcp.json'), false);
  assert.equal(JSON.parse(native.get('config/plugin-source.json').toString()).version, first.version);
  const marketplace = unzipStored(fs.readFileSync(first.archives[1]));
  assert.deepEqual([...marketplace.keys()].sort(), [
    '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json',
    ...NATIVE_RUNTIME_FILES.map(relative => `plugins/${PLUGIN_NAME}/${relative}`),
  ].sort());
  const codexCatalog = JSON.parse(marketplace.get('.agents/plugins/marketplace.json').toString());
  assert.equal(codexCatalog.plugins[0].source.path, `./plugins/${PLUGIN_NAME}`);
  const portable = unzipStored(fs.readFileSync(first.archives[2]));
  assert.deepEqual([...portable.keys()].sort(), [...PORTABLE_RUNTIME_FILES].sort());
  assert.equal(JSON.parse(portable.get('plugin.json').toString()).version, first.version);
  assert.equal(JSON.parse(portable.get('mcp.json').toString()).mcpServers[PLUGIN_NAME].type, 'stdio');
  const sums = fs.readFileSync(first.sha256, 'utf8').trim().split('\n');
  assert.deepEqual(sums, first.archives.map(filename => `${createHash('sha256').update(fs.readFileSync(filename)).digest('hex')}  ${path.basename(filename)}`));
});

test('ZIP writer rejects duplicate names and paths that escape the archive root', () => {
  for (const name of ['../escape', '/absolute', 'C:/drive', 'dir/../escape', 'dir\\file', './file', 'double//separator', 'nul\0file']) {
    assert.throws(() => zipEntries([{ name, data: Buffer.from('hello') }]), /safe relative paths/);
  }
  assert.throws(() => zipEntries([{ name: 'file', data: 'a' }, { name: 'file', data: 'b' }]), /unique/);
  const zip = zipEntries([{ name: 'file', data: Buffer.from('hello') }]);
  assert.equal(zip.readUInt32LE(14), 0x3610a686, 'known CRC-32 for hello');
});

test('portable archive expands PLUGIN_ROOT to a cached Unicode installation and starts MCP from an unrelated cwd', async t => {
  const { directory, source } = copySource(t);
  const built = buildPackages({ sourceRoot: source, outputDir: path.join(directory, 'output') });
  const cache = path.join(directory, 'cached plugin copy', 'plugin café');
  for (const [relative, data] of unzipStored(fs.readFileSync(built.archives[2]))) {
    const target = path.join(cache, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data);
  }
  const config = JSON.parse(fs.readFileSync(path.join(cache, 'mcp.json'), 'utf8')).mcpServers[PLUGIN_NAME];
  const dataDirectory = path.join(directory, 'plugin-data');
  const unrelated = path.join(directory, 'unrelated project');
  fs.mkdirSync(unrelated); fs.mkdirSync(dataDirectory);
  const expand = value => value.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_, name) => name === 'ROOT' ? cache : dataDirectory);
  assert.equal(expand(config.cwd), cache);
  const env = { ...process.env, PLUGIN_ROOT: cache, PLUGIN_DATA: dataDirectory, USERPROFILE: directory, HOME: directory };
  for (const key of ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN', 'CODEX_CLAUDE_BRIDGE_STATE_DIR', 'CODEX_CLAUDE_BRIDGE_REGISTRY_DIR']) delete env[key];
  const child = spawn(config.command, config.args.map(expand), { cwd: unrelated, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const result = await new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Portable MCP startup timeout')); }, 10_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve(stdout) : reject(new Error(stderr)); });
    child.stdin.end([
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'portable-startup-test', version: '1' } } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
    ].map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n');
  });
  const replies = result.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.find(reply => reply.id === 1).result.serverInfo.version, built.version);
  assert.deepEqual(replies.find(reply => reply.id === 2).result.tools.map(tool => tool.name).sort(),
    ['bridge_doctor', 'bridge_panel', 'bridge_status', 'bridge_ui_history', 'bridge_ui_retry_notice', 'bridge_ui_send', 'list_claude_sessions', 'list_codex_chats', 'send_to_claude', 'send_to_codex']);
  assert.equal(fs.existsSync(path.join(directory, '.local/share', PLUGIN_NAME)), false, 'probe must not register a real app endpoint');
});
