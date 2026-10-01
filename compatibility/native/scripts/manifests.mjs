#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const PLUGIN_NAME = 'codex-claude-desktop-bridge';
export const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
export const NATIVE_DIRECTORY = 'compatibility/native';
export const COMMON_RUNTIME_FILES = [
  '.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.mcp.json',
  'lib/store.mjs', 'lib/claude-desktop.mjs', 'lib/codex-desktop.mjs',
  'lib/desktop-service.mjs', 'lib/codex-host.mjs', 'scripts/mcp.mjs',
  'lib/claude-history.mjs', 'lib/bridge-history.mjs', 'lib/manual-service.mjs', 'lib/codex-settings.mjs', 'ui/bridge.html',
  'scripts/manifests.mjs', 'scripts/install.mjs', 'skills/claude-bridge/SKILL.md',
  'package.json', 'README.md', 'LICENSE', 'SECURITY.md', 'docs/PRIVACY.md', 'docs/PUBLISHING.md', 'docs/TERMS.md',
  'assets/bridge.svg', 'assets/bridge-dark.svg',
];
export const NATIVE_RUNTIME_FILES = ['config/plugin-source.json', 'config/mcp-source.json', ...COMMON_RUNTIME_FILES];
export const PORTABLE_RUNTIME_FILES = ['plugin.json', 'mcp.json', ...COMMON_RUNTIME_FILES];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const json = value => JSON.stringify(value, null, 2) + '\n';
export const CODEX_CONTEXT_ENV_VARS = ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_THREAD_ID', 'CODEX_HOME', 'USERPROFILE', 'HOME', 'PATH',
  'CLAUDE_CONFIG_DIR', 'CODEX_CLAUDE_BRIDGE_STATE_DIR', 'CODEX_CLAUDE_BRIDGE_REGISTRY_DIR'];
export const CLAUDE_CONTEXT_ENV_VARS = ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_THREAD_ID', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'PATH', 'CLAUDE_CONFIG_DIR', 'CODEX_CLAUDE_BRIDGE_STATE_DIR', 'CODEX_CLAUDE_BRIDGE_REGISTRY_DIR'];

function readBytes(rootDirectory, relative) {
  const filename = path.join(rootDirectory, relative);
  const actual = fs.realpathSync(filename);
  const rel = path.relative(rootDirectory, actual);
  if (!fs.lstatSync(filename).isFile() || !rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Manifest must be a regular file inside the source root: ${relative}`);
  }
  return fs.readFileSync(filename);
}

const read = (directory, relative) => JSON.parse(readBytes(directory, relative).toString('utf8').replace(/^\uFEFF/, ''));

// Validate the closed Agent Plugins 1.0 envelopes and this bridge's stdio entry.
// Canonical schemas: https://github.com/agentplugins/agent-plugins-spec/tree/main/schemas/1.0.0
export function validateCanonical(manifest, mcp) {
  const fields = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];
  if (!object(manifest) || Object.keys(manifest).some(key => !fields.includes(key)) || manifest.$schema !== PLUGIN_SCHEMA ||
      manifest.name !== PLUGIN_NAME || !/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(manifest.name) ||
      manifest.name.length > 64) throw new Error('Invalid canonical Agent Plugins manifest identity or schema.');
  for (const field of ['version', 'description', 'homepage', 'repository', 'license']) {
    if (manifest[field] !== undefined && typeof manifest[field] !== 'string') throw new Error(`plugin.json ${field} must be a string.`);
  }
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) throw new Error('plugin.json requires a release version.');
  if (manifest.author !== undefined && (!object(manifest.author) || Object.entries(manifest.author)
    .some(([key, value]) => !['name', 'email', 'url'].includes(key) || typeof value !== 'string'))) throw new Error('Invalid plugin.json author.');
  if (manifest.keywords !== undefined && !stringArray(manifest.keywords)) throw new Error('Invalid plugin.json keywords.');
  if (manifest.extensions !== undefined && (!object(manifest.extensions) || Object.values(manifest.extensions).some(value => !object(value)))) {
    throw new Error('Invalid plugin.json extensions.');
  }
  if (!object(manifest.extensions?.['com.openai']?.interface)) throw new Error('This bridge requires extensions.com.openai.interface.');
  if (!object(mcp) || mcp.$schema !== MCP_SCHEMA || Object.keys(mcp).some(key => !['$schema', 'mcpServers'].includes(key)) ||
      !object(mcp.mcpServers) || Object.keys(mcp.mcpServers).length !== 1 || !object(mcp.mcpServers[PLUGIN_NAME])) {
    throw new Error('Invalid canonical mcp.json envelope or server name.');
  }
  const server = mcp.mcpServers[PLUGIN_NAME];
  if (Object.keys(server).some(key => !['type', 'command', 'args', 'env', 'cwd'].includes(key)) ||
      server.type !== 'stdio' || server.command !== 'node' || !isDeepStrictEqual(server.args, ['${PLUGIN_ROOT}/scripts/mcp.mjs']) ||
      server.cwd !== '${PLUGIN_ROOT}') throw new Error('This bridge requires the canonical portable Node stdio launch configuration.');
  if (server.env !== undefined && (!object(server.env) || Object.entries(server.env).some(([key, value]) =>
    ['PLUGIN_ROOT', 'PLUGIN_DATA'].includes(key.toUpperCase()) || typeof value !== 'string'))) throw new Error('Invalid portable MCP environment.');
  return { manifest, mcp };
}

/** Legacy adapters deliberately preserve native context forwarding that the
 * portable v1 schema cannot express with env_vars. No ambient values are copied.
 */
export function compatibilityFiles(manifest, mcp) {
  validateCanonical(manifest, mcp);
  const metadata = Object.fromEntries(['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']
    .filter(key => manifest[key] !== undefined).map(key => [key, manifest[key]]));
  const portable = mcp.mcpServers[PLUGIN_NAME];
  const env = portable.env === undefined ? {} : { env: structuredClone(portable.env) };
  const codexServer = { command: portable.command, cwd: './', args: ['./scripts/mcp.mjs'], ...env, env_vars: [...CODEX_CONTEXT_ENV_VARS] };
  const claudeServer = { command: portable.command, args: ['${CLAUDE_PLUGIN_ROOT}/scripts/mcp.mjs'], ...env, env_vars: [...CLAUDE_CONTEXT_ENV_VARS] };
  return {
    '.codex-plugin/plugin.json': { ...metadata, skills: './skills/', mcpServers: { [PLUGIN_NAME]: codexServer },
      ...structuredClone(manifest.extensions['com.openai']) },
    '.claude-plugin/plugin.json': { ...metadata, skills: './skills/', mcpServers: './.mcp.json' },
    '.mcp.json': { mcpServers: { [PLUGIN_NAME]: claudeServer } },
  };
}

export function readCanonicalBundle(sourceRoot = root) {
  const source = fs.realpathSync(sourceRoot);
  const native = !fs.existsSync(path.join(source, 'plugin.json'));
  const manifestPath = native ? 'config/plugin-source.json' : 'plugin.json';
  const mcpPath = native ? 'config/mcp-source.json' : 'mcp.json';
  return { source, native, manifestPath, mcpPath,
    ...validateCanonical(read(source, manifestPath), read(source, mcpPath)), packageJson: read(source, 'package.json') };
}

export function checkManifests(sourceRoot = root, { checkNative = true } = {}) {
  const bundle = readCanonicalBundle(sourceRoot);
  if (bundle.packageJson.name !== bundle.manifest.name || bundle.packageJson.version !== bundle.manifest.version) {
    throw new Error('package.json name/version differs from canonical plugin.json. Run npm run manifests:sync.');
  }
  const files = compatibilityFiles(bundle.manifest, bundle.mcp);
  for (const [relative, expected] of Object.entries(files)) {
    if (!isDeepStrictEqual(read(bundle.source, relative), expected)) {
      throw new Error(`${relative} differs from the canonical plugin.json/mcp.json. Run npm run manifests:sync.`);
    }
  }
  const checked = { ...bundle, files };
  if (checkNative && !bundle.native) checkNativeDeployment(checked);
  return checked;
}

export function nativeBundleEntries(bundle) {
  return [
    { name: 'config/plugin-source.json', data: Buffer.from(json(bundle.manifest)) },
    { name: 'config/mcp-source.json', data: Buffer.from(json(bundle.mcp)) },
    ...COMMON_RUNTIME_FILES.map(name => ({ name, data: readBytes(bundle.source, name) })),
  ].sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

function fileList(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw new Error(`Generated native deployment contains a link: ${name}`);
    if (item.isDirectory()) return fileList(path.join(directory, item.name), name);
    if (!item.isFile()) throw new Error(`Invalid generated native entry: ${name}`);
    return [name];
  }).sort();
}

function checkNativeDeployment(bundle) {
  const destination = path.join(bundle.source, NATIVE_DIRECTORY);
  const expected = nativeBundleEntries(bundle);
  if (!fs.existsSync(destination) || !isDeepStrictEqual(fileList(destination), expected.map(entry => entry.name).sort())) {
    throw new Error('Generated compatibility/native file list differs from the native runtime allowlist. Run npm run manifests:sync.');
  }
  for (const entry of expected) {
    if (!readBytes(destination, entry.name).equals(entry.data)) {
      throw new Error(`Generated compatibility/native/${entry.name} differs from its canonical source. Run npm run manifests:sync.`);
    }
  }
}

function syncNativeDeployment(bundle) {
  const destination = path.join(bundle.source, NATIVE_DIRECTORY);
  const expected = nativeBundleEntries(bundle);
  if (fs.existsSync(destination)) {
    const extra = fileList(destination).filter(name => !expected.some(entry => entry.name === name));
    if (extra.length) throw new Error(`Refusing to remove unexpected generated native files: ${extra.join(', ')}.`);
  }
  for (const entry of expected) {
    const target = path.join(destination, entry.name);
    let directory = path.dirname(target);
    while (directory !== bundle.source) {
      try { if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Refusing to write through a linked generated native directory.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      directory = path.dirname(directory);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Refusing to replace a linked generated native file.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.writeFileSync(target, entry.data);
  }
}

export function syncManifests(sourceRoot = root) {
  const bundle = readCanonicalBundle(sourceRoot);
  const files = compatibilityFiles(bundle.manifest, bundle.mcp);
  for (const [relative, value] of Object.entries(files)) fs.writeFileSync(path.join(bundle.source, relative), json(value));
  fs.writeFileSync(path.join(bundle.source, 'package.json'), json({ ...bundle.packageJson, name: bundle.manifest.name, version: bundle.manifest.version }));
  if (!bundle.native) syncNativeDeployment(bundle);
  return checkManifests(bundle.source);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--check', '--sync'].includes(args[0])) throw new Error('Usage: node scripts/manifests.mjs --check | --sync');
    const result = args[0] === '--sync' ? syncManifests() : checkManifests();
    console.log(`${result.manifest.name} ${result.manifest.version}: canonical and compatibility manifests are aligned.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
