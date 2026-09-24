# Releases

## Build

Run these commands from a source checkout:

```powershell
npm test
npm run package
```

The packager writes these artifacts under `dist/`:

- `codex-claude-desktop-bridge-<version>.zip`: the installable plugin and local installer.
- `codex-claude-desktop-bridge-marketplace-<version>.zip`: a self-contained marketplace for both applications.
- `marketplace/`: the same marketplace unpacked for inspection.
- `SHA256SUMS`: SHA-256 checksums for both archives.

The archives include runtime code, documentation, and the MIT license. They exclude Git history, test fixtures, local state, credentials, and installer backups. ZIP entry timestamps are fixed for reproducible builds.

## Validate

```powershell
claude plugin validate .claude-plugin/plugin.json
claude plugin validate dist/marketplace
```

Keep `package.json`, `.codex-plugin/plugin.json`, and `.claude-plugin/plugin.json` on the same release version. The local installer adds cache-specific build suffixes only to its staged copies.

## Local marketplace

```powershell
codex plugin marketplace add ./dist/marketplace
codex plugin add codex-claude-desktop-bridge@keeveeg-desktop-bridge --json
claude plugin marketplace add ./dist/marketplace
claude plugin install codex-claude-desktop-bridge@keeveeg-desktop-bridge --scope user --json
```

The generated catalogs use `./plugins/codex-claude-desktop-bridge`. Keep that directory and both catalogs together.

## Git marketplace

```powershell
codex plugin marketplace add https://github.com/KeeVeeG/codex-claude-desktop-bridge.git
codex plugin add codex-claude-desktop-bridge@keeveeg-desktop-bridge --json
claude plugin marketplace add https://github.com/KeeVeeG/codex-claude-desktop-bridge.git
claude plugin install codex-claude-desktop-bridge@keeveeg-desktop-bridge --scope user --json
```

The public catalog is named `keeveeg-desktop-bridge`. The source Claude catalog points to the root plugin. The source Codex catalog uses the Git repository URL. The local installer's separate Claude catalog is named `codex-claude-desktop-local`.

## Directory submission references

- [OpenAI plugin submission](https://developers.openai.com/plugins/deploy/submission)
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [Claude plugin submission](https://claude.com/docs/plugins/submit)
- [Claude marketplace distribution](https://code.claude.com/docs/en/plugin-marketplaces)
