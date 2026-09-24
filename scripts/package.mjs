#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { RUNTIME_FILES, PLUGIN_NAME } from './install.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogName = 'keeveeg-desktop-bridge';
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
const crc32 = data => {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
};
const json = value => JSON.stringify(value, null, 2) + '\n';

function safeChild(parent, relative) {
  const result = path.resolve(parent, relative);
  const rel = path.relative(parent, result);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Package path escapes its root');
  return result;
}

function put(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function entriesFrom(directory, prefix = '') {
  const entries = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw new Error('Release packages cannot contain symbolic links');
    if (item.isDirectory()) entries.push(...entriesFrom(path.join(directory, item.name), relative));
    else if (item.isFile()) entries.push({ name: relative, data: fs.readFileSync(path.join(directory, item.name)) });
    else throw new Error('Unsupported package entry');
  }
  return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

// Deterministic ZIP32 with stored entries. No external archiver or package is required.
export function zipEntries(entries) {
  const localParts = [], directoryParts = [];
  let offset = 0;
  if (entries.length > 65535) throw new Error('Too many ZIP entries');
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    if (name.length > 65535 || data.length >= 0xffffffff) throw new Error('ZIP entry is too large');
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(33, 12); // 1980-01-01, a fixed reproducible timestamp.
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    localParts.push(header, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directoryParts.push(central, name);
    offset += header.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(directoryParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function buildPackages({ sourceRoot = root, outputDir = path.join(root, 'dist') } = {}) {
  const source = fs.realpathSync(sourceRoot);
  const destination = path.resolve(outputDir);
  fs.mkdirSync(destination, { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Release version must not contain a local build suffix');
  const temp = safeChild(destination, `.package-${randomUUID()}`);
  const plugin = path.join(temp, 'plugins', PLUGIN_NAME);
  fs.mkdirSync(plugin, { recursive: true });
  try {
    for (const relative of [...RUNTIME_FILES, 'scripts/install.mjs']) {
      const filename = safeChild(source, relative);
      const real = fs.realpathSync(filename);
      const realRelative = path.relative(source, real);
      if (!fs.lstatSync(filename).isFile() || !realRelative || realRelative === '..' ||
          realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error(`Invalid runtime entry: ${relative}`);
      put(safeChild(plugin, relative), fs.readFileSync(filename));
    }
    const codexCatalog = { name: catalogName, interface: { displayName: 'KeeVeeG Desktop Bridge' }, plugins: [{
      name: PLUGIN_NAME, source: { source: 'local', path: `./plugins/${PLUGIN_NAME}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity',
    }] };
    const claudeCatalog = { name: catalogName, owner: { name: 'KeeVeeG' },
      description: 'Asynchronous messages between Codex Desktop and Claude Desktop Code.',
      plugins: [{ name: PLUGIN_NAME, source: `./plugins/${PLUGIN_NAME}` }],
    };
    put(path.join(temp, '.agents', 'plugins', 'marketplace.json'), json(codexCatalog));
    put(path.join(temp, '.claude-plugin', 'marketplace.json'), json(claudeCatalog));
    const pluginName = `${PLUGIN_NAME}-${version}.zip`;
    const marketplaceName = `${PLUGIN_NAME}-marketplace-${version}.zip`;
    const pluginEntries = entriesFrom(plugin);
    const archives = [
      { name: pluginName, data: zipEntries(pluginEntries) },
      { name: marketplaceName, data: zipEntries(entriesFrom(temp)) },
    ];
    for (const archive of archives) put(path.join(destination, archive.name), archive.data);
    put(path.join(destination, 'SHA256SUMS'), archives.map(a => `${createHash('sha256').update(a.data).digest('hex')}  ${a.name}`).join('\n') + '\n');
    // Keep an unpacked, immediately inspectable marketplace; preserve any previous build.
    const marketplace = path.join(destination, 'marketplace');
    if (fs.existsSync(marketplace)) {
      if (fs.lstatSync(marketplace).isSymbolicLink()) throw new Error('Refusing to replace a linked output directory');
      fs.renameSync(marketplace, safeChild(destination, `.previous-marketplace-${randomUUID()}`));
    }
    fs.renameSync(temp, marketplace);
    return { version, archives: archives.map(a => path.join(destination, a.name)), marketplace,
      sha256: path.join(destination, 'SHA256SUMS'), entries: pluginEntries.length };
  } finally {
    if (fs.existsSync(temp)) {
      const resolved = fs.realpathSync(temp);
      if (path.dirname(resolved) !== fs.realpathSync(destination) || !path.basename(resolved).startsWith('.package-')) throw new Error('Unsafe package cleanup target');
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(buildPackages(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
