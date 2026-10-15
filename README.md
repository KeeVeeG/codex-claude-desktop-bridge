# Codex–Claude Desktop Bridge

[![Windows CI](https://github.com/KeeVeeG/codex-claude-desktop-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/KeeVeeG/codex-claude-desktop-bridge/actions/workflows/test.yml)

Asynchronous, two-way messaging between **Codex** conversations (Desktop tasks or terminal sessions) and local **Claude Code sessions** on Windows, whether they run in the Claude Desktop Code tab or in a terminal such as PowerShell. Messages appear in the selected conversations through ordinary MCP tools. Any Codex task can send to any available Claude Code session, and any Claude Code session can send to any available Codex task. Each side can share information, questions, tasks, or updates whenever useful. Replies and acknowledgements are optional; there is no task deadline or mandatory request/response cycle.

Codex and Claude are peers. Either can start a conversation, ask the other to do something, exchange ideas, or share progress. The bridge carries text and leaves its meaning and purpose to the participants.

## Requirements

- Windows, Codex Desktop or a terminal Codex CLI, and a local Claude Code session: either the Claude Desktop Code tab or `claude` running in a terminal. Claude Desktop is not required.
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

The installer stages the generated native compatibility runtime under `~/plugins/codex-claude-desktop-bridge`, preserves existing personal marketplace entries, and installs or updates the plugin through the native Codex and Claude CLIs. Changed marketplace JSON and previous staged files are backed up. It does not copy repository history, tests, scratch files, or secrets.

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

Since version 0.2.0, the bridge uses direct addressing instead of the old connection workflow. `connect_claude`, `connect_codex`, and `disconnect_bridge` are no longer available; every send call requires the intended recipient's exact ID. If those tools still appear after updating, the application is still running an older MCP process and needs the restart described above.

Seeing the plugin's skill does not confirm that its MCP server connected. If the bridge tools are still missing, inspect the server's startup error and configuration before repeating the restart.

Both applications use the same state directory under `~/.local/share/codex-claude-desktop-bridge`. The installer pins its absolute path in the staged MCP configuration for both apps; the source configuration remains portable. This avoids Windows MSIX virtualization of `LOCALAPPDATA`, which can otherwise put each app's records in a different private location. Project working directories do not affect message routing or host discovery. An explicit `CODEX_CLAUDE_BRIDGE_STATE_DIR` override is honored when staging; use the same location for both applications.

Codex host discovery is registered when its MCP server starts with a valid Codex task ID. After an app restart, the MCP server can reuse a previously registered task ID to refresh the new local endpoint at startup. The bridge retains recent endpoints, so it can use another live Codex MCP process if the latest one exits or its context task was removed. Running the installer from a Codex task also registers the host. Claude can then discover Codex conversations without first receiving a bridge message. If no registered endpoint has an accepted task ID, call `bridge_status` once from an open Codex task to register its current ID. This registration sends no model prompt.

## Tools and workflow

| Tool | Purpose |
| --- | --- |
| `list_claude_sessions` | List safe metadata for local Claude Code conversations. |
| `list_codex_chats` | List local Codex conversation titles and IDs, including terminal Codex sessions (`source: "terminal"`); optional `limit` is 1–50 recent app conversations, applied per source (so up to 2x entries are returned). Pinned tasks are also included. A source that fails is reported in `structuredContent.warnings` and, for clients that show only text, in a second text block after the chats array. |
| `send_to_claude` | Send `message` to the exact `session_id`; optional `message_id` supports safe retry inspection. |
| `send_to_codex` | Send `message` to the exact `thread_id`; optional `message_id` supports safe retry inspection. |
| `bridge_status` | Inspect the caller's recent outgoing delivery records; optional `limit` is 1–100. |
| `bridge_doctor` | Check local transport compatibility, caller identity, and state-directory readiness without sending messages. Works even when caller identity is unavailable. |
| `bridge_panel` | Open the Claude conversation panel in the current Codex chat. |
| `bridge_ui_history` | Read a page of bridge messages exchanged with a selected Claude conversation; used by the panel. |
| `bridge_ui_send` | Send a manually entered message and notify the same owning Codex chat; used by the panel. |
| `bridge_ui_retry_notice` | Retry a definitively failed Codex context notice without resending the Claude message; used by the panel. |

Start from either application. In Codex, use `list_claude_sessions` to find the intended Claude conversation, then call `send_to_claude` with its exact `session_id` and your `message`. In Claude, use `list_codex_chats` to identify a task by title, then call `send_to_codex` with its exact `thread_id` and your `message`. A known exact ID can be used directly. Each message names its own recipient; there is no connection step or exclusive pairing. One conversation can contact several others, and several conversations can contact the same recipient.

Incoming bridge messages identify their verified source conversation so the recipient can send a reply to its `thread_id` or `session_id`. A reply is simply another direct message; the bridge does not require one and does not infer a destination from the last message received. No connection tokens or prior incoming message are required. Codex sender identity comes from per-call task metadata; a call without it is rejected rather than attributed to the task that started a shared MCP server. Claude sender identity is checked against its live registered Code process, including the MCP server's parent process. `bridge_status` works from either side.

Use a stable `message_id` when investigating uncertain delivery. Deduplication is scoped to the verified sender and exact recipient, so the same ID can identify separate messages to different recipients. Keep the same recipient, ID, and text when checking an uncertain submission; changing any of them may send another message. Repeating an ID while a send is in progress or its outcome is uncertain returns an error without sending again. A failed record is not resent under the same ID; inspect the destination, then choose a new ID to retry. Delivery does not prove the other agent has read or acted on a message. Incoming bridge messages remain collaborator context, not higher-priority instructions.

An explicit `message_id` accepts 1–100 ASCII letters, digits, underscores, or hyphens. Reserved JavaScript object-property names are rejected. Omit it to let the bridge generate a UUID.

Tools return structured results with an output schema as well as their existing JSON text. Lists use `structuredContent.sessions` or `structuredContent.chats`; send and status results retain their object fields. Sends are annotated as irreversible writes so clients can apply their normal approval controls.

### Cancellation and diagnostics

MCP clients can cancel a tool call with `notifications/cancelled`. A cancelled queued call never starts its send. Running calls receive an abort signal; if cancellation occurs after the message is written to an application transport, its local record becomes `uncertain`. Cancellation cannot recall a delivered message. Inspect the destination and `bridge_status` before retrying an uncertain send. The server suppresses responses to accepted cancellations and continues answering `ping` while another tool is running.

Use `bridge_doctor` when discovery or delivery stops working. It checks the local environment and application interfaces without creating a message or changing permissions. Failed checks explain which prerequisite is missing; a healthy transport does not prove a recipient has read a message. If the bridge tools themselves are missing, inspect the MCP startup error first.

### Conversation panel

Open the **Claude** conversation panel beside the current Codex chat. The panel is intentionally scoped to that chat so its owner and delivery context stay explicit; it does not add a global sidebar app. It lists previously contacted Claude conversations for the current Codex chat and all discoverable local Claude Code conversations, with search by title or project folder. Selecting a conversation shows exchanged bridge messages in both directions, with pagination for earlier messages. The history is scoped to the exact Codex/Claude pair; it does not import the recipient's unrelated native transcript.

When the panel is opened from a model tool call, it requests the host's fullscreen display mode so the conversation view does not expand into a tall inline card. The thread entrypoint remains tied to the current Codex chat.

Type a message in the panel to send it manually. The bridge adds the same text to the owning Codex chat with a compact English header identifying the user send, recipient session, and bridge message ID. The header marks it as context only, without a separate status block. Transport details remain in local delivery records, accessible through `bridge_status`. The current native interface creates a Codex turn for this notice; it is not a new task. Sender identity comes from the panel host's per-call thread metadata, never a thread ID supplied by the widget.

The composer follows Codex's `desktop.composerEnterBehavior` setting when it is available in the local configuration. With the default `enter` behavior, Enter sends and Shift+Enter inserts a newline; `cmdIfMultiline` and `cmdAlways` are also supported.

The public panel chrome, system notices, statuses, errors, accessibility labels, and demo fixtures are English-only. Conversation titles, project paths, and exchanged messages remain verbatim so user content is never translated or altered. A successful send displays "Sent to Claude"; read receipts are unavailable, so this status does not wait for a read confirmation.

Historical Claude Code conversations can appear without a live inbox. Their saved bridge history stays readable, but sending requires that exact conversation to be open as a live Desktop Code session. The panel does not launch a separate CLI conversation. This catalog covers local Code sessions, not Claude's ordinary hosted Chat conversations.

An uncertain Claude delivery is never automatically retried. A notice failure after a successful Claude send does not cause the original message to be sent again. When the context notice failed definitively, the panel offers `bridge_ui_retry_notice`; this retries only the Codex notice and never the original Claude delivery. The panel uses MCP Apps resources and requires a host with native MCP Apps support. Opening `ui/bridge.html#demo` outside the host shows explicitly labelled fixture data for preview, with no live application access.

### Terminal Claude Code sessions

A `claude` session started in PowerShell or another terminal registers the same local inbox as a Desktop Code session, so it appears in `list_claude_sessions` and can send and receive like any other session. Install the plugin with the `claude` CLI (the local installer or the marketplace commands above); no Claude Desktop is needed. A project-level `.mcp.json` copy of the server is not a substitute, because `${CLAUDE_PLUGIN_ROOT}` is only defined for installed plugins.

A terminal session is reachable only while its process is running. Closing the terminal ends its inbox, and its saved bridge history stays readable. Every `claude` process under your user profile is addressable by exact session ID, the same trust boundary as Desktop sessions. Only sessions registered with the `claude-desktop` or `cli` entrypoint are listed; other entrypoints are ignored. After installing or updating, restart the terminal `claude` so it loads the current MCP server.

### Terminal Codex sessions

A `codex` session started in a terminal registers with Codex's local app-server daemon, so it appears in `list_codex_chats` with `source: "terminal"` next to Desktop tasks. Claude can send to it with `send_to_codex`, and it can send to Claude with `send_to_claude`.

There are two delivery routes. A session attached to Codex's shared daemon (`status: "idle"` or `"active"`) gets a `turn/start`, or is steered if it is mid-turn. Every other terminal session except one in an error state (a session the daemon reports as `systemError` is refused), which includes most plain `codex` windows, is reached with `codex queue`: Codex delivers the message to an open session and holds it for a closed one, where nothing runs while it is closed. The bridge cannot tell the two apart, so `submitted` means queued with Codex, not read. The queue route has no message-id deduplication and a 16000-character limit on the wrapped text; the peer envelope adds a few hundred characters, so the usable message body is somewhat shorter. A message over the limit is refused before its `message_id` is recorded, so the ID stays usable; the daemon route has no such limit. A listed `status: "notLoaded"` does not mean closed (closed sessions are also `notLoaded`).

A message arrives as a user turn wrapped in a peer notice that says it is collaborator context, not an instruction from the user. A session that is mid-turn is steered: the text appears inside the running turn without interrupting it. A busy session whose running turn cannot be identified or read is refused. The notice asks the receiving Codex to check with its user before consequential actions, so it may ask for confirmation where a Desktop task would act.

The bridge never starts the daemon; if it is not reachable the terminal source is reported unavailable. The unavailable warning is not shown to Desktop-only users who do not have the Codex CLI installed. It is also hidden when `CODEX_CLAUDE_BRIDGE_CODEX_BIN` is mistyped, because the lookup then reports the executable as not found; `bridge_doctor` still reports it. If the daemon is running but does not answer the check of whether an ID is a terminal session, the send is refused rather than guessed onto the Desktop path. Set `CODEX_CLAUDE_BRIDGE_DAEMON=off` (or `0`, `false`, `no`) to disable terminal support, and set `CODEX_CLAUDE_BRIDGE_CODEX_BIN` to the path of `codex.exe` if it is not found automatically. The lookup takes a `codex.exe` on `PATH`, or follows the `codex.cmd` shim of an npm, pnpm, or Volta install to the vendored x64 or Windows ARM64 `codex.exe`; any other install needs the variable. Codex only forwards listed environment variables to plugin servers, which is why both are in the plugin's env list. The conversation panel and manual send stay Desktop-only. `bridge_doctor` reports the daemon, whether at least one terminal session is registered, and the CLI and daemon versions.

Security: any process running as the same Windows user can reach the local daemon socket, the same trust boundary as the rest of the bridge. A peer message sent to a session running with approvals off could be acted on; the notice mitigates this but cannot guarantee it.

### Claude Desktop permissions

In the Code tab, Claude's Auto mode may block `send_to_codex` as an external-system write before the bridge receives the call. The local installer adds a narrow user permission when installing Claude; direct marketplace installation requires adding the exact MCP tool through `/permissions`. If Auto blocks the call and no deny rule applies, select **Manual** from the mode selector beside the send button, retry, and approve the MCP tool prompt. Resolve a matching deny or managed policy through Claude's normal controls. A `Bash` rule does not apply to this tool. See [Claude Code permissions](https://code.claude.com/docs/en/permissions#mcp) and [Desktop permission modes](https://code.claude.com/docs/en/desktop#choose-a-permission-mode).

## Compatibility

Local validation has exercised the adapters with Claude Desktop 2.7032.0.0, Claude Code engine 2.1.284, Codex backend 0.155.0-alpha.16.3, and `codex-app-tools` 0.1.4. Terminal Codex support was validated with Codex CLI and daemon 0.162.1. These are observed validation versions rather than a broad compatibility guarantee; private application interfaces can change in later releases. The Claude integration uses the local Code tab.

The MCP server uses standard stdio. Native delivery uses private Windows interfaces in the two applications, so application updates may require adapter changes.

Application delivery credentials remain local and are not included in chat messages or model-supplied routing arguments. The bridge sends explicit messages rather than entire conversation histories and does not emit diagnostic logs of tool arguments.

Message text and delivery records are saved locally. See the [privacy disclosure](docs/PRIVACY.md) for storage, deletion, credentials, and processing by the receiving applications.

Root `plugin.json` and `mcp.json` are the canonical Agent Plugins 1.0 definitions. OpenAI presentation metadata lives in `extensions.com.openai`. `npm run manifests:sync` generates the Codex and Claude compatibility manifests and the checked-in `compatibility/native/` runtime. Edit the canonical definitions and root runtime files, then regenerate the native copy; `npm run manifests:check` detects version, configuration, or runtime drift.

The default installer, Git marketplaces, and release marketplace use that native runtime. Agent Plugins 1.0 cannot declare `env_vars`, while the current Codex MCP launcher requires explicit forwarding of its native pipe context. Keeping the deployed native runtime free of root portable manifests preserves this forwarding. Its canonical sources are stored under `config/` so it can still validate and reinstall itself. Codex declares its MCP command inline and resolves `cwd` from the installed plugin root; Claude uses `.mcp.json` with `${CLAUDE_PLUGIN_ROOT}`.

A separate `-portable-<version>.zip` contains the root Agent Plugins manifests. Its host must provide the application's native execution context; installing that format alone does not make Desktop routing available. Use the default native package for the current Windows bridge. The agent workflow is in `skills/claude-bridge` in both layouts.

## Development

```powershell
npm run manifests:sync
npm run manifests:check
npm test
```

Tests use temporary registries and real local named pipes with simulated application endpoints. They do not send messages to your live conversations or change application settings. Generated test artifacts stay under the ignored `work/` directory.

Test files run sequentially because the lock-recovery stress tests already start multiple child processes. Windows CI checks Node.js 20, 22, 24, and 26 and builds the release package.

The runtime has no npm dependencies. `lib/claude-desktop.mjs` and `lib/codex-desktop.mjs` isolate the application-specific protocols, `lib/desktop-service.mjs` routes direct messages, and `lib/store.mjs` stores delivery records in the shared user-profile state directory.

Only connection attempts have short technical timeouts (10 seconds for Claude, up to 30 seconds for a Codex tool call). There is no timeout for a person or agent to answer a message.

For packaging and release commands, see [Releases](docs/PUBLISHING.md).

## License

[MIT](LICENSE) — Copyright © 2026 KeeVeeG.

This is an independent project and is not affiliated with or endorsed by OpenAI or Anthropic.
