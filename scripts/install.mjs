#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultStateDir, withStateLock } from '../lib/store.mjs';

export const PLUGIN_NAME = 'codex-claude-desktop-bridge';
export const CLAUDE_MARKETPLACE = 'codex-claude-desktop-local';
// Claude scopes plugin MCP tools by plugin name and server name. Marketplace
// names and cache versions are not part of this permission identifier.
export const CLAUDE_SEND_PERMISSION = `mcp__plugin_${PLUGIN_NAME}_${PLUGIN_NAME}__send_to_codex`;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeFiles = [
  '.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.mcp.json',
  'lib/store.mjs', 'lib/claude-desktop.mjs', 'lib/codex-desktop.mjs',
  'lib/desktop-service.mjs', 'lib/codex-host.mjs', 'scripts/mcp.mjs',
  'skills/claude-bridge/SKILL.md', 'package.json', 'README.md', 'LICENSE', 'SECURITY.md',
  'docs/PRIVACY.md', 'docs/PUBLISHING.md',
];
export { runtimeFiles as RUNTIME_FILES };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const jsonText = value => `${JSON.stringify(value, null, 2)}\n`;
const timestamp = () => new Date().toISOString().replace(/[-:.TZ]/g, '');

function readRawIfPresent(filename) {
  try { return fs.readFileSync(filename, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
}

function optionalJson(filename) {
  try { return readJson(filename); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read valid JSON from ${filename}: ${error.message}`);
  }
}

function contained(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function refuseLink(filename) {
  try {
    if (fs.lstatSync(filename).isSymbolicLink()) throw new Error(`Refusing to replace a symbolic link: ${filename}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function writeNewFile(filename, content) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content, { flag: 'wx' });
}

/** Preserve the prior JSON as a sibling backup, then atomically replace its contents. */
export function writeJsonAtomic(filename, value, { expectedPrevious, label = 'marketplace' } = {}) {
  refuseLink(filename);
  const next = jsonText(value);
  const previous = readRawIfPresent(filename);
  if (expectedPrevious !== undefined && previous !== expectedPrevious) {
    throw new Error(`The ${label} changed during installation. No replacement was made; retry from the updated file.`);
  }
  if (previous === next) return null;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const suffix = `${timestamp()}-${randomUUID()}`;
  const temporary = `${filename}.tmp-${suffix}`;
  const backup = previous === null ? null : `${filename}.backup-${suffix}`;
  try {
    writeNewFile(temporary, next);
    if (backup) {
      const backupTemporary = `${backup}.tmp`;
      writeNewFile(backupTemporary, previous);
      fs.renameSync(backupTemporary, backup);
    }
    if (readRawIfPresent(filename) !== previous) {
      throw new Error(`The ${label} changed before replacement. The newer file was preserved; retry installation.`);
    }
    if (previous === null) {
      // Same-directory hard linking creates a complete new file without overwriting
      // a catalog concurrently created by a writer that does not use our lock.
      fs.linkSync(temporary, filename);
    } else {
      fs.renameSync(temporary, filename);
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return backup;
}

function permissionRuleMatches(rule, toolName) {
  if (typeof rule !== 'string' || rule.includes('(')) return false;
  if (rule === toolName || toolName.startsWith(`${rule}__`)) return true;
  if (!rule.includes('*')) return false;
  const pattern = rule.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${pattern}$`).test(toolName);
}

/** Explicit, narrow user-level grant for Claude's outbound bridge tool. */
export function grantClaudeSendPermission({ homeDir = os.homedir(), env = process.env } = {}) {
  const configDir = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'));
  const settingsPath = path.join(configDir, 'settings.json');
  const lockDirectory = path.join(configDir, '.codex-claude-desktop-bridge-permissions-lock');
  return withStateLock(lockDirectory, () => {
    const previous = readRawIfPresent(settingsPath);
    let settings;
    try { settings = previous === null ? {} : JSON.parse(previous.replace(/^\uFEFF/, '')); }
    catch { throw new Error('Claude settings.json is not valid JSON. No permission was added.'); }
    if (!object(settings) || (settings.permissions !== undefined && !object(settings.permissions))) {
      throw new Error('Claude settings.json must contain an object with optional object permissions. No permission was added.');
    }
    const permissions = settings.permissions || {};
    for (const field of ['allow', 'ask', 'deny']) {
      if (permissions[field] !== undefined && (!Array.isArray(permissions[field]) ||
          permissions[field].some(rule => typeof rule !== 'string'))) {
        throw new Error(`Claude permissions.${field} must be an array of strings. No permission was added.`);
      }
    }
    for (const field of ['deny', 'ask']) {
      if (permissions[field]?.some(rule => permissionRuleMatches(rule, CLAUDE_SEND_PERMISSION))) {
        throw new Error(`Claude permissions.${field} already matches the outbound bridge tool. Resolve that rule in Claude before granting access.`);
      }
    }
    if (permissions.allow?.includes(CLAUDE_SEND_PERMISSION)) {
      return { settingsPath, rule: CLAUDE_SEND_PERMISSION, added: false, backup: null };
    }
    settings.permissions = { ...permissions, allow: [...(permissions.allow || []), CLAUDE_SEND_PERMISSION] };
    const backup = writeJsonAtomic(settingsPath, settings, { expectedPrevious: previous, label: 'Claude settings' });
    return { settingsPath, rule: CLAUDE_SEND_PERMISSION, added: true, backup };
  });
}

function codexMarketplacePlan(filename, content = readRawIfPresent(filename)) {
  const marketplace = (content === null ? null : JSON.parse(content.replace(/^\uFEFF/, ''))) ?? {
    name: 'personal', interface: { displayName: 'Personal' }, plugins: [],
  };
  if (!object(marketplace) || typeof marketplace.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(marketplace.name) || !Array.isArray(marketplace.plugins)) {
    throw new Error('The existing personal marketplace must have a valid name and plugins array.');
  }
  const matches = marketplace.plugins.filter(entry => entry?.name === PLUGIN_NAME);
  if (matches.length > 1) throw new Error('The personal marketplace contains duplicate entries for this plugin.');
  const source = { source: 'local', path: `./plugins/${PLUGIN_NAME}` };
  if (matches.length) {
    if (matches[0].source?.source !== source.source || matches[0].source?.path !== source.path) {
      throw new Error('The personal marketplace already has this plugin name with a different source. Resolve the conflict before installing.');
    }
    // Preserve existing policy choices, metadata, order, and unrelated entries.
    matches[0].policy = { installation: 'AVAILABLE', authentication: 'ON_INSTALL', ...(matches[0].policy ?? {}) };
    matches[0].category ??= 'Productivity';
  } else {
    marketplace.plugins.push({ name: PLUGIN_NAME, source,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' });
  }
  return marketplace;
}

function checkedSource(root, relative) {
  const filename = path.join(root, relative);
  if (!contained(root, filename) || !contained(root, fs.realpathSync(filename)) || !fs.lstatSync(filename).isFile()) {
    throw new Error(`Runtime file must be a regular file inside the source tree: ${relative}`);
  }
  return filename;
}

/** Prepare local files only. This function never runs an application command. */
export function prepareInstallation({ sourceRoot = projectRoot, homeDir = os.homedir(), env = process.env, codex = true, claude = true } = {}) {
  if (!codex && !claude) throw new Error('Select Codex, Claude, or both.');
  const root = fs.realpathSync(sourceRoot);
  const pluginsDir = path.resolve(homeDir, 'plugins');
  const destination = path.join(pluginsDir, PLUGIN_NAME);
  const stateDir = path.resolve(defaultStateDir({ homeDir, env }));
  const marketplacePath = path.resolve(homeDir, '.agents', 'plugins', 'marketplace.json');
  let marketplace = codex ? codexMarketplacePlan(marketplacePath) : null;
  const sourceManifests = ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json'].map(relative => {
    const manifest = readJson(checkedSource(root, relative));
    if (manifest.name !== PLUGIN_NAME || typeof manifest.version !== 'string' || !manifest.version.trim()) {
      throw new Error(`Unexpected plugin name or version in ${relative}.`);
    }
    return { relative, manifest };
  });
  const publisherName = sourceManifests.find(item => item.relative === '.claude-plugin/plugin.json').manifest.author?.name;
  if (typeof publisherName !== 'string' || !publisherName.trim()) {
    throw new Error('The Claude plugin manifest must declare the actual publisher name before installation.');
  }
  const mcpConfig = readJson(checkedSource(root, '.mcp.json'));
  const mcpServer = mcpConfig.mcpServers?.[PLUGIN_NAME];
  if (!object(mcpServer) || (mcpServer.env !== undefined && !object(mcpServer.env))) {
    throw new Error('The source MCP configuration must declare this plugin server with an object environment.');
  }
  // Pin the same profile path in each application's staged MCP configuration:
  // MSIX can give each application a different LOCALAPPDATA.
  mcpServer.env = { ...(mcpServer.env ?? {}), CODEX_CLAUDE_BRIDGE_STATE_DIR: stateDir };
  // Codex resolves a relative cwd against the installed plugin root. Its legacy
  // MCP loader does not expand Claude's plugin-root macro in command arguments.
  const codexMcpServer = sourceManifests.find(item => item.relative === '.codex-plugin/plugin.json')
    .manifest.mcpServers?.[PLUGIN_NAME];
  if (!object(codexMcpServer) || (codexMcpServer.env !== undefined && !object(codexMcpServer.env))) {
    throw new Error('The Codex manifest must declare this plugin server with an object environment.');
  }
  codexMcpServer.env = { ...(codexMcpServer.env ?? {}), CODEX_CLAUDE_BRIDGE_STATE_DIR: stateDir };
  const sources = runtimeFiles.map(relative => ({ relative, filename: checkedSource(root, relative) }));
  refuseLink(pluginsDir);
  refuseLink(destination);
  fs.mkdirSync(pluginsDir, { recursive: true });
  if (!contained(pluginsDir, destination) || path.resolve(destination) === path.resolve(root)) {
    throw new Error('The staging destination must be separate from the source repository.');
  }
  if (fs.existsSync(destination)) {
    const existing = optionalJson(path.join(destination, '.codex-plugin', 'plugin.json'));
    if (!existing || existing.name !== PLUGIN_NAME) throw new Error('The staging destination belongs to another directory or plugin.');
  }
  const build = timestamp();
  const temporary = path.join(pluginsDir, `.${PLUGIN_NAME}.stage-${build}-${randomUUID()}`);
  let backupDirectory = null;
  try {
    fs.mkdirSync(temporary);
    for (const { relative, filename } of sources) {
      const target = path.join(temporary, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(filename, target, fs.constants.COPYFILE_EXCL);
    }
    for (const { relative, manifest } of sourceManifests) {
      manifest.version = `${manifest.version.split('+')[0]}+codex.${build}`;
      fs.writeFileSync(path.join(temporary, relative), jsonText(manifest));
    }
    fs.writeFileSync(path.join(temporary, '.mcp.json'), jsonText(mcpConfig));
    fs.writeFileSync(path.join(temporary, '.claude-plugin', 'marketplace.json'), jsonText({
      name: CLAUDE_MARKETPLACE,
      owner: { name: publisherName },
      plugins: [{ name: PLUGIN_NAME, source: './', description: 'Asynchronous native messages between paired Codex Desktop and Claude Desktop Code conversations.' }],
    }));
    if (fs.existsSync(destination)) {
      backupDirectory = path.join(pluginsDir, `.${PLUGIN_NAME}.backup-${build}-${randomUUID()}`);
      // Both move targets are resolved, fixed children of this installer-owned plugins directory.
      if (!contained(pluginsDir, backupDirectory)) throw new Error('Invalid staging backup path.');
      fs.renameSync(destination, backupDirectory);
    }
    try { fs.renameSync(temporary, destination); } catch (error) {
      if (backupDirectory && !fs.existsSync(destination)) fs.renameSync(backupDirectory, destination);
      throw error;
    }
  } finally {
    if (fs.existsSync(temporary)) {
      const resolved = fs.realpathSync(temporary);
      if (!contained(fs.realpathSync(pluginsDir), resolved) || path.basename(temporary).indexOf(`.${PLUGIN_NAME}.stage-`) !== 0) {
        throw new Error('Refusing cleanup outside the staging directory.');
      }
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  let marketplaceBackup = null;
  if (codex) {
    const lockDirectory = path.join(path.dirname(marketplacePath), '.codex-claude-desktop-bridge-marketplace-lock');
    withStateLock(lockDirectory, () => {
      // Staging may take time: merge into the latest catalog under a short lock.
      // The final comparison also detects changes from non-cooperating writers
      // before the replacement, rather than reusing the pre-staging snapshot.
      const expectedPrevious = readRawIfPresent(marketplacePath);
      marketplace = codexMarketplacePlan(marketplacePath, expectedPrevious);
      marketplaceBackup = writeJsonAtomic(marketplacePath, marketplace, { expectedPrevious });
    });
  }
  return { destination, stateDir, marketplacePath: marketplace ? marketplacePath : null,
    marketplaceName: marketplace?.name ?? null, claudeMarketplace: CLAUDE_MARKETPLACE,
    build, backupDirectory, marketplaceBackup, codex, claude };
}

function run(command, args) {
  const executable = process.platform === 'win32' ? `${command}.exe` : command;
  const result = spawnSync(executable, args, {
    shell: false, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 6000);
    throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed (${result.status ?? result.signal}).${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function readList(output, key) {
  const parsed = JSON.parse(output);
  const list = Array.isArray(parsed) ? parsed : parsed?.[key];
  if (!Array.isArray(list)) throw new Error(`The Claude CLI returned an unsupported ${key} listing.`);
  return list;
}

function registeredPath(entry) {
  const source = entry?.source;
  if (object(source) && !['directory', 'local', undefined].includes(source.source)) return null;
  const candidates = [source?.path, typeof source === 'string' ? source : null,
    entry?.path, entry?.installLocation, entry?.location];
  return candidates.find(value => typeof value === 'string' && path.isAbsolute(value)) ?? null;
}

function samePath(left, right) {
  const normalize = filename => {
    let resolved = path.resolve(filename);
    try { resolved = fs.realpathSync(resolved); } catch {}
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export function installApplications(prepared, { execute = run, homeDir = os.homedir(), env = process.env,
  log = console.log, grantPermission = grantClaudeSendPermission } = {}) {
  if (prepared.codex) {
    execute('codex', ['plugin', 'add', `${PLUGIN_NAME}@${prepared.marketplaceName}`, '--json']);
    log('Codex plugin installed or updated.');
  }
  if (prepared.claude) {
    const marketplaces = readList(execute('claude', ['plugin', 'marketplace', 'list', '--json']), 'marketplaces');
    const registered = marketplaces.filter(entry => entry.name === CLAUDE_MARKETPLACE);
    if (registered.length > 1) throw new Error('Claude reports duplicate local bridge marketplaces.');
    if (registered.length) {
      let location = registeredPath(registered[0]);
      if (!location) {
        const registry = optionalJson(path.join(env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'), 'plugins', 'known_marketplaces.json'));
        location = registeredPath(registry?.[CLAUDE_MARKETPLACE]);
      }
      if (!location || !samePath(location, prepared.destination)) {
        throw new Error('Claude already has this marketplace name with a different or unverifiable source. Resolve the conflict before installing.');
      }
    } else {
      execute('claude', ['plugin', 'marketplace', 'add', prepared.destination, '--scope', 'user']);
    }
    const selector = `${PLUGIN_NAME}@${CLAUDE_MARKETPLACE}`;
    const plugins = readList(execute('claude', ['plugin', 'list', '--json']), 'plugins');
    const installed = plugins.some(entry => (entry.id === selector || entry.name === selector ||
      (entry.name === PLUGIN_NAME && entry.marketplace === CLAUDE_MARKETPLACE)) &&
      (entry.scope === undefined || entry.scope === 'user'));
    execute('claude', ['plugin', installed ? 'update' : 'install', selector, '--scope', 'user', '--json']);
    log(`Claude plugin ${installed ? 'updated' : 'installed'}.`);
    const granted = grantPermission({ homeDir, env });
    log(granted.added ? `Allowed Claude outbound bridge tool: ${granted.rule}` : `Claude outbound bridge tool was already allowed: ${granted.rule}`);
    if (granted.backup) log(`Previous Claude settings backup: ${granted.backup}`);
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/install.mjs [--all | --codex | --claude] [--prepare-only]\nDefault: install for both apps. A normal Claude installation grants only its send_to_codex MCP tool in user permissions.allow. --prepare-only stages files and local catalogs without invoking either app CLI or changing tool permissions.');
    return;
  }
  for (const arg of args) if (!['--all', '--codex', '--claude', '--prepare-only'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
  const selected = args.filter(arg => ['--all', '--codex', '--claude'].includes(arg));
  if (selected.length > 1) throw new Error('Choose exactly one of --all, --codex, or --claude.');
  const target = selected[0] ?? '--all';
  const prepared = prepareInstallation({ codex: target !== '--claude', claude: target !== '--codex' });
  console.log(`Prepared ${PLUGIN_NAME} in ${prepared.destination}`);
  if (prepared.backupDirectory) console.log(`Previous staged files: ${prepared.backupDirectory}`);
  if (prepared.marketplaceBackup) console.log(`Personal marketplace backup: ${prepared.marketplaceBackup}`);
  if (args.includes('--prepare-only')) {
    console.log('Preparation complete. No application plugin commands were run.');
    return prepared;
  }
  installApplications(prepared);
  if (process.env.CODEX_APP_TOOLS_PIPE_PATH && process.env.CODEX_THREAD_ID) {
    const { publishCodexHost } = await import('../lib/codex-host.mjs');
    publishCodexHost({ stateDir: prepared.stateDir,
      pipePath: process.env.CODEX_APP_TOOLS_PIPE_PATH, threadId: process.env.CODEX_THREAD_ID });
    console.log('Registered this Codex Desktop host for local conversation discovery.');
  }
  console.log(`Fully quit and reopen Claude Desktop when convenient so its MCP process loads this version. In Codex, start a new task or restart the app to load updated tools. Apps were not restarted.${prepared.claude ? ' Only the exact Claude send_to_codex tool received a user-level allow rule.' : ' Claude tool permissions were not changed.'}`);
  return prepared;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    console.error(`Installation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
