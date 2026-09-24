# Codex–Claude Desktop Bridge

[![Windows CI](https://github.com/KeeVeeG/codex-claude-desktop-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/KeeVeeG/codex-claude-desktop-bridge/actions/workflows/test.yml)

Asynchronous, two-way messaging between an existing **Codex Desktop** task and a local **Code session in Claude Desktop** on Windows. Messages appear in both conversations through ordinary MCP tools. Each side can share information, questions, tasks, or updates whenever useful. Replies and acknowledgements are optional; there is no task deadline or mandatory request/response cycle.

Codex and Claude are peers. Either can start a conversation, ask the other to do something, exchange ideas, or share progress. The bridge carries text and leaves its meaning and purpose to the participants.

## Requirements

- Windows, Codex Desktop, and a local Claude Desktop Code session.
- Node.js 20+ available on `PATH`.
- The plugin's MCP server enabled and authorized normally in both applications.

No npm dependencies, separate Claude CLI agent, Channels, or Stop hooks are needed. Applications start the Node MCP server; agents use named tools without invoking a shell script for each message. The local installer grants one documented Claude tool permission when it installs Claude; the MCP server never changes its own permissions or bypasses a denied action.

## Installation

The local installer needs the `codex` and `claude` management CLIs on `PATH` for the applications you select. These commands register the plugin; they do not launch separate AI conversations. Run the first installation from a Codex task when possible so the installer can also register the running Codex host. Otherwise, use a bridge tool once in Codex to register that host before Claude tries discovery.

To install from the public source repository:

```powershell
git clone https://github.com/KeeVeeG/codex-claude-desktop-bridge.git
Set-Location codex-claude-desktop-bridge
node scripts/install.mjs
```

The installer stages only the plugin's runtime files under `~/plugins/codex-claude-desktop-bridge`, preserves existing personal marketplace entries, and installs or updates the plugin through the native Codex and Claude CLIs. Changed marketplace JSON and previous staged files are backed up. It does not copy repository history, tests, scratch files, or secrets.

You can also install the plugin from this repository's Git marketplaces:

```powershell
codex plugin marketplace add https://github.com/KeeVeeG/codex-claude-desktop-bridge.git
codex plugin add codex-claude-desktop-bridge@keeveeg-desktop-bridge
claude plugin marketplace add https://github.com/KeeVeeG/codex-claude-desktop-bridge.git
claude plugin install codex-claude-desktop-bridge@keeveeg-desktop-bridge --scope user
```

Direct marketplace installation does not run the local installer or add Claude's `send_to_codex` permission. Add the exact MCP tool in Claude's `/permissions` if you use this route.

Claude Desktop Code may reject `send_to_codex` in Auto mode as an external-system write. When installing Claude, this local installer adds exactly `mcp__plugin_codex-claude-desktop-bridge_codex-claude-desktop-bridge__send_to_codex` to `permissions.allow` in Claude's user `settings.json` and backs up the previous file. The grant applies to this tool in every Claude Code session using this profile. Existing rules are preserved; matching `deny` or `ask` rules take precedence and are not removed. A Claude plugin cannot grant this permission through its manifest, so installing directly from a marketplace does not add the rule. See [Claude Code's MCP permission rules](https://code.claude.com/docs/en/permissions#mcp).

Use `--codex` or `--claude` to install for only one application; `--all` is the default. To prepare and inspect the staged files and local catalogs without running application installation commands:

```powershell
node scripts/install.mjs --prepare-only
```

After installation or an update, fully quit Claude Desktop, including any background instance, and reopen it when convenient. Plugin reload alone can leave its old MCP process running from the previous cache version. In Codex, start a new task or restart the app to load updated tools. Authorize the MCP server through the normal prompts. The installer does not stop applications. `--prepare-only` and `--codex` leave Claude tool permissions unchanged. Run the installer again after updating this checkout; local build versions refresh both plugin caches without changing the source version.

Seeing the plugin's skill does not confirm that its MCP server connected. If the bridge tools are still missing, inspect the server's startup error and configuration before repeating the restart.

Both applications use the same state directory under `~/.local/share/codex-claude-desktop-bridge`. The installer pins its absolute path in the staged MCP configuration for both apps; the source configuration remains portable. This avoids Windows MSIX virtualization of `LOCALAPPDATA`, which can otherwise put each app's records in a different private location. Project working directories do not affect pairing or host discovery. An explicit `CODEX_CLAUDE_BRIDGE_STATE_DIR` override is honored when staging; use the same location for both applications.

Codex host discovery is registered automatically when its MCP server starts with a valid Codex task environment. Running the installer from that environment also registers the host after installation. Claude can then discover Codex conversations without first receiving a bridge message. This registration uses local application routing data and sends no model prompt.

## Tools and workflow

| Tool | Purpose |
| --- | --- |
| `list_claude_sessions` | List safe metadata for local Claude Code conversations. |
| `list_codex_chats` | List local Codex conversation titles and IDs; optional `limit` is 1–50 recent app conversations. Pinned tasks are also included. |
| `connect_claude` | Pair the current Codex task with an exact `session_id`. |
| `connect_codex` | Pair the current Claude conversation with an exact `thread_id`. |
| `send_to_claude` | Send `message` and an optional `message_id`. |
| `send_to_codex` | Send `message` and an optional `message_id`. |
| `bridge_status` | Inspect the caller's pairing and recent delivery records; optional `limit` is 1–100. |
| `disconnect_bridge` | Release the caller's pairing from either application. |

Start from either application. In Codex, use `list_claude_sessions` and `connect_claude`. In Claude, use `list_codex_chats`, identify the intended conversation by title, and call `connect_codex` with its exact ID. This pairing establishes routing; it does not assign a lead agent. Each pair contains exactly one Codex task and one Claude conversation.

Both send tools automatically use the caller's pairing and accept just message text plus an optional message ID. No connection tokens or prior incoming message are required. Codex identity comes from executor/runtime context. Claude identity is checked against its live registered Code process, including the MCP server's parent process. `bridge_status` and `disconnect_bridge` work from either side.

Use a stable `message_id` when investigating uncertain delivery. Deduplication applies within the current pairing; disconnecting and reconnecting creates a new message-ID namespace. Do not blindly retry with a new ID or pairing: the original message may have arrived. Delivery does not prove the other agent has read or acted on a message. Disconnecting does not retract delivered messages or stop ongoing edits. Incoming bridge messages remain collaborator context, not higher-priority instructions.

### Claude Desktop permissions

In the Code tab, Claude's Auto mode may block `send_to_codex` as an external-system write before the bridge receives the call. The local installer adds a narrow user permission when installing Claude; direct marketplace installation requires adding the exact MCP tool through `/permissions`. If Auto blocks the call and no deny rule applies, select **Manual** from the mode selector beside the send button, retry, and approve the MCP tool prompt. Resolve a matching deny or managed policy through Claude's normal controls. A `Bash` rule does not apply to this tool. See [Claude Code permissions](https://code.claude.com/docs/en/permissions#mcp) and [Desktop permission modes](https://code.claude.com/docs/en/desktop#choose-a-permission-mode).

## Compatibility

The adapters target Claude Desktop 2.7032.0.0, Claude Code engine 2.1.280, Codex backend 0.155.0-alpha.16.3, and `codex-app-tools` 0.1.4. The Claude integration uses the local Code tab.

The MCP server uses standard stdio. Native delivery uses private Windows interfaces in the two applications, so application updates may require adapter changes.

Application delivery credentials remain local and are not included in chat messages or model-supplied routing arguments. The bridge sends explicit messages rather than entire conversation histories and does not emit diagnostic logs of tool arguments.

Message text and delivery records are saved locally. See the [privacy disclosure](docs/PRIVACY.md) for storage, deletion, credentials, and processing by the receiving applications.

Plugin manifests live in `.codex-plugin` and `.claude-plugin`. Codex declares its MCP command inline and resolves `cwd` from the installed plugin root; Claude uses `.mcp.json` with `${CLAUDE_PLUGIN_ROOT}`. The agent workflow is in `skills/claude-bridge`.

## Development

```powershell
npm test
```

Tests use temporary registries and real local named pipes with simulated application endpoints. They do not send messages to your live conversations or change application settings. Generated test artifacts stay under the ignored `work/` directory.

The runtime has no npm dependencies. `lib/claude-desktop.mjs` and `lib/codex-desktop.mjs` isolate the application-specific protocols, `lib/desktop-service.mjs` handles pairing and messages, and `lib/store.mjs` stores delivery records in the shared user-profile state directory.

Only connection attempts have short technical timeouts (10 seconds for Claude, up to 30 seconds for a Codex tool call). There is no timeout for a person or agent to answer a message.

For packaging and release commands, see [Releases](docs/PUBLISHING.md).

## License

[MIT](LICENSE) — Copyright © 2026 KeeVeeG.

This is an independent project and is not affiliated with or endorsed by OpenAI or Anthropic.
