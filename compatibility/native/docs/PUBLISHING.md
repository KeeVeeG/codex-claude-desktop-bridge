# Releases

## Build

Run these commands from a source checkout:

```powershell
npm run manifests:sync
npm run manifests:check
npm test
npm run package
```

The packager writes these artifacts under `dist/`:

- `codex-claude-desktop-bridge-<version>.zip`: the native compatibility plugin and local installer; use this for the current Windows applications.
- `codex-claude-desktop-bridge-marketplace-<version>.zip`: a self-contained marketplace for both applications.
- `codex-claude-desktop-bridge-portable-<version>.zip`: the Agent Plugins 1.0 package for hosts that provide the required native application context.
- `marketplace/`: the same marketplace unpacked for inspection.
- `SHA256SUMS`: SHA-256 checksums for all three archives.

The archives include runtime code, documentation, and the MIT license. They exclude Git history, test fixtures, local state, credentials, and installer backups. ZIP entry timestamps are fixed for reproducible builds.

## Validate

```powershell
claude plugin validate .claude-plugin/plugin.json
claude plugin validate dist/marketplace
```

Edit release identity, version, and presentation in root `plugin.json`, and the portable stdio command in root `mcp.json`. Run `npm run manifests:sync` to update `package.json`, the legacy adapters, and the generated `compatibility/native/` tree. Commit that generated tree together with the root changes: the Git marketplaces install it. The packager refuses mismatched versions, modified adapters, unexpected native files, or stale runtime copies.

The installer adds cache-specific build suffixes to all staged manifests and `package.json` together. Canonical sources in the native package live in `config/plugin-source.json` and `config/mcp-source.json`; they are kept outside the root portable discovery paths deliberately.

Agent Plugins 1.0 stdio configuration has no `env_vars` forwarding field. The default native deployment preserves the context required by Codex's current filtered MCP launcher; placing portable manifests in its root would change which server definition Codex loads. The separate portable archive uses `${PLUGIN_ROOT}` and requires a host that supplies the application's native context. It does not replace the default native deployment yet.

## GitHub release

After the validation commands pass, commit the source and generated compatibility tree, push the branch, and create the matching tag and release. The release should attach the native plugin archive, marketplace archive, portable archive, and `SHA256SUMS` produced by the same `npm run package` run:

```powershell
$version = node -p "JSON.parse(require('fs').readFileSync('plugin.json', 'utf8')).version"
$tag = "v$version"
git diff --check
git add -A
git commit -m "Release $version"
git push origin main
git tag -a $tag -m "Release $tag"
git push origin $tag
npm run package
gh release create $tag `
  "dist/codex-claude-desktop-bridge-$version.zip" `
  "dist/codex-claude-desktop-bridge-marketplace-$version.zip" `
  "dist/codex-claude-desktop-bridge-portable-$version.zip" `
  dist/SHA256SUMS `
  --title $tag `
  --generate-notes
```

Do not commit `dist/`; it is ignored and is regenerated for each release. Keep the tag, package version, manifests, and checksums aligned. If a tag or release already exists, inspect it before replacing assets so an older package is not silently published under the same version. The Windows CI workflow also runs `npm test` and `npm run package` for pushes and pull requests; the local `npm run package` above is needed to create the files uploaded to the release.

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

The Git catalog is named `keeveeg-desktop-bridge`. Both source catalogs select the generated `compatibility/native/` directory; Codex uses a Git subdirectory source. The local installer's separate Claude catalog is named `codex-claude-desktop-local`.

## Directory submission references

Git and local marketplaces are separate from OpenAI's universal public directory. The current bridge depends on Windows-only local application interfaces and a stdio server. The standard public MCP submission path requires a production HTTPS endpoint, and the plugin guidelines restrict unofficial third-party connectors. A portable ZIP does not remove those architecture and review constraints. Consult OpenAI about local application support before planning public submission.

The current OpenAI submission guide starts with a plugin ZIP, automated metadata/skill checks, MCP connection and review, followed by publication. Some companion pages still describe earlier submission forms; use the submission guide below for the current flow. Keep reviewer credentials in the submission portal, outside release archives.

- [OpenAI plugin submission](https://developers.openai.com/plugins/deploy/submission)
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [OpenAI plugin extensions](https://developers.openai.com/plugins/build/extensions)
- [OpenAI plugin UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines)
- [MCP Apps overview and lifecycle](https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html)
- [Claude Desktop local MCP servers and extensions](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
- [Claude plugin submission](https://claude.com/docs/plugins/submit)
- [Claude marketplace distribution](https://code.claude.com/docs/en/plugin-marketplaces)

## Upstream compatibility check

Checked 2026-10-01 against the current OpenAI Plugins documentation and changelog:

- [Package your plugin](https://developers.openai.com/plugins/build/plugins) defines root `plugin.json` and `mcp.json` as the portable Agent Plugins layout. It says `extensions.com.openai` replaces the complete `.codex-plugin/plugin.json` compatibility overlay when present; the objects are not merged. This repository therefore keeps presentation metadata in the canonical root manifest and generates the legacy Codex overlay from it.
- The same guide documents `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` for plugin execution. The portable archive uses `${PLUGIN_ROOT}`; the Windows native deployment uses the generated compatibility manifest because it must forward Codex's application pipe environment through `env_vars`.
- [Plugin Extensions](https://developers.openai.com/plugins/build/extensions) and the [Plugin UI changelog](https://developers.openai.com/plugins/changelog) describe MCP Apps resources, `outputSchema`, server instructions, host theme variables, entrypoint display modes, and sidebar or conversation-panel surfaces. The bridge deliberately registers only the conversation-panel entrypoint because delivery is scoped to the current Codex chat. The panel reads host theme variables with fallbacks, requests fullscreen for model-invoked rendering so it does not become a tall inline card, and the server declares output schemas and initialization instructions for these hosts.
- [Upload and submit your plugin](https://developers.openai.com/plugins/deploy/submission) currently requires a hosted, domain-verified MCP URL for public directory connection and does not accept ZIPs containing `apps`/`.app.json` references or lifecycle hooks. The bridge's local Windows stdio transport is consequently documented as a local/Git marketplace integration, and the portable ZIP is not advertised as a public-directory submission.

These links are evidence for the packaging decisions above, not a promise that private Windows application protocols remain stable. Recheck this section when OpenAI changes the plugin manifest, MCP Apps, or submission requirements.
