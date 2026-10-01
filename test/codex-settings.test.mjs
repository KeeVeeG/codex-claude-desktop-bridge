import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readComposerEnterBehavior } from '../lib/codex-settings.mjs';

test('reads Codex desktop composerEnterBehavior without changing config', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-codex-settings-'));
  try {
    const codexHome = path.join(home, '.codex'); fs.mkdirSync(codexHome);
    const config = path.join(codexHome, 'config.toml');
    fs.writeFileSync(config, '[desktop]\ncomposerEnterBehavior = "cmdIfMultiline"\n');
    const before = fs.readFileSync(config);
    assert.equal(readComposerEnterBehavior({ homeDir: home, env: {} }), 'cmdIfMultiline');
    assert.deepEqual(fs.readFileSync(config), before);
    fs.writeFileSync(config, '[desktop]\ncomposerEnterBehavior = "unsupported"\n');
    assert.equal(readComposerEnterBehavior({ homeDir: home, env: {} }), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
