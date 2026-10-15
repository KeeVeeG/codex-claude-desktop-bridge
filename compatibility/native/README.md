# Codex–Claude Desktop Bridge

[![Windows CI](https://github.com/KeeVeeG/codex-claude-desktop-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/KeeVeeG/codex-claude-desktop-bridge/actions/workflows/test.yml)

Asynchronous, two-way messaging between **Codex** conversations (Desktop tasks or terminal sessions) and local **Claude Code CLI or Claude Desktop Code sessions** on native Windows. Messages appear in the selected conversations through ordinary MCP tools. Any Codex task can send to any available Claude Code session, and any Claude Code session can send to any available Codex task. Each side can share information, questions, tasks, or updates whenever useful. Replies and acknowledgements are optional; there is no task deadline or mandatory request/response cycle.

On macOS, `send_to_codex` can use a configured SSH-host app-server connection. This route requires an explicit SSH alias and a loaded, idle chat on that host. Local Claude Code inboxes use Unix sockets with process-identity checks. The SSH route does not use Codex's protected local app-tools socket. Windows retains its Desktop, daemon, and terminal queue transports. The merged macOS implementation still needs a live smoke test; see [Compatibility](#compatibility).

Codex and Claude are peers. Either can start a conversation, ask the other to do something, exchange ideas, or share progress. The bridge carries text and leaves its meaning and purpose to the participants.

## Requirements

- **Windows:** native Windows, Codex Desktop or a terminal Codex CLI, and a local Claude Code session in the terminal or Claude Desktop Code tab with a live messaging inbox. Claude Desktop is not required.
- **macOS:** a local Claude Code session with a live Unix inbox and verifiable process registration; outbound Codex delivery requires the configured SSH route below and an already-loaded idle target.
- Node.js 20+ available on `PATH`.
- The plugin's MCP server enabled and authorized normally in both applications.

No npm dependencies, additional agent, Channels, or Stop hooks are needed. The selected Claude session and Codex start their own Node MCP servers; agents use named tools without invoking a shell script for each message. The local installer grants one documented Claude tool permission when it installs Claude; the MCP server never changes its own permissions or bypasses a denied action. WSL, Linux end-to-end operation, remote Claude sessions, and Claude's ordinary hosted Chat conversations are outside this bridge's scope. Linux sends fail closed because its native process-identity contract is not yet supported.

### macOS SSH-host setup

1. Configure an authenticated SSH alias in `~/.ssh/config`. Codex must be installed and authenticated in that host's login shell. A loopback alias on the same Mac also works when a local SSH service is available.
2. In Codex Desktop, connect through **Settings > Connections > SSH** and open the destination chat on that connection. A chat running under **This computer** is owned by a different server even when both connections use the same filesystem.
3. Install or update with the chosen alias:

   ```sh
   CODEX_CLAUDE_BRIDGE_SSH_HOST=my-codex-host node scripts/install.mjs
   ```

   The installer validates and pins this alias into both staged MCP configurations. Use the same alias on later updates. Direct marketplace installations must forward or configure `CODEX_CLAUDE_BRIDGE_SSH_HOST` themselves.
4. Reload the plugin in local Claude Code using the client-specific instructions below. In Claude Desktop, use the local **Code** session; cloud Chat cannot use these local tools. Use normal MCP permissions; the adapter does not change approval mode.
5. `list_codex_chats` lists only chats already loaded by this SSH server, with `source: "ssh"`. `send_to_codex` with `transport: "auto"` or `"ssh"` uses only the pinned alias. `desktop` and `terminal` are rejected while SSH is configured, even if a local conversation has the same ID.
6. The target must already be loaded and idle. Open it on the configured connection and wait for active work to finish before sending. The bridge never calls `thread/resume`, creates a replacement thread, starts a server, changes thread permissions, or retries a submitted turn.

The SSH transport uses `/usr/bin/ssh` with batch authentication and strict host-key verification, then speaks the WebSocket app-server protocol through `codex app-server proxy`. An unavailable or invalid configured route stops delivery; it does not fall back to a local endpoint or queue. Submitted receipts include the accepted Codex `turnId`; they do not mean the model has read or completed the turn. A lost reply after a write is uncertain and must be inspected before another submission. User-owned SSH services and credentials remain outside the bridge installer.

## Installation

The local installer needs the `codex` and `claude` management CLIs on `PATH` for the applications you select. These commands register the plugin; they do not launch separate AI conversations. For Windows Desktop routing, run the first installation from a Codex Desktop task when possible so the installer can also register the running Desktop host. Otherwise, use a bridge tool once in Codex Desktop to register that host before Claude tries Desktop discovery. The configured macOS SSH route uses its pinned alias independently of this local host registry.

To install from the public source repository:

```powershell
git clone https://github.com/KeeVeeG/codex-claude-desktop-bridge.git
Set-Location codex-claude-desktop-bridge
node scripts/install.mjs
```

On macOS, use `cd codex-claude-desktop-bridge` instead of PowerShell's `Set-Location`, and run the installer with the SSH alias as shown above.

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

After installation or an update, load the new tools in each client:

- **Claude Code CLI:** the same `--claude` installation applies to terminal sessions using that Claude profile. Run `/reload-plugins`, then check the server in `/mcp`. If old tools remain, exit and resume the exact conversation with `claude --resume <session_id>`. See [Claude plugin loading](https://code.claude.com/docs/en/plugins/loading#check-which-stage-a-plugin-reached).
- **Claude Desktop Code:** fully quit Claude Desktop, including any background instance, and reopen it when convenient. Plugin reload alone can leave its old MCP process running from the previous cache version.
- **Codex Desktop:** start a new task or restart the app to load updated tools.
- **Codex CLI:** restart terminal Codex sessions when convenient to load updated tools.

Authorize the MCP server through the normal prompts. The installer does not stop applications. `--prepare-only` and `--codex` leave Claude tool permissions unchanged. Run the installer again after updating this checkout; local build versions refresh both plugin caches without changing the source version.

Since version 0.2.0, the bridge uses direct addressing instead of the old connection workflow. `connect_claude`, `connect_codex`, and `disconnect_bridge` are no longer available; every send call requires the intended recipient's exact ID. If those tools still appear after updating, the application is still running an older MCP process and needs the restart described above.

Seeing the plugin's skill does not confirm that its MCP server connected. If the bridge tools are still missing, inspect the server's startup error and configuration before repeating the restart.

Both applications use the same state directory under `~/.local/share/codex-claude-desktop-bridge`. The installer pins its absolute path in the staged MCP configuration for both apps; the source configuration remains portable. This avoids Windows MSIX virtualization of `LOCALAPPDATA`, which can otherwise put each app's records in a different private location. Project working directories do not affect message routing or host discovery. An explicit `CODEX_CLAUDE_BRIDGE_STATE_DIR` override is honored when staging; use the same location for both applications.

Windows Codex Desktop host discovery is registered when its MCP server starts with a valid Codex task ID. After an app restart, the MCP server can reuse a previously registered task ID to refresh the new local endpoint at startup. The bridge retains recent endpoints, so it can use another live Codex MCP process if the latest one exits or its context task was removed. Running the installer from a Codex Desktop task also registers the host. Claude can then discover Desktop conversations without first receiving a bridge message. If no registered endpoint has an accepted task ID, call `bridge_status` once from an open Codex Desktop task to register its current ID. This registration sends no model prompt. Terminal discovery uses the local Codex daemon independently; configured macOS SSH discovery lists only its selected server.

## Tools and workflow

| Tool | Purpose |
| --- | --- |
| `list_claude_sessions` | List safe metadata for local Claude Code conversations. |
| `list_codex_chats` | List Codex titles and IDs. Windows combines Desktop and terminal-daemon discovery; configured macOS SSH lists only that server's loaded chats (`source: "ssh"`). `source` identifies discovery transport, not the current client. Optional `limit` is 1–50 conversations per source. Windows also includes pinned Desktop tasks and retains Desktop entries for duplicate IDs. Source failures appear in `structuredContent.warnings` and a second text block after the chats array. |
| `send_to_claude` | Send `message` to the exact `session_id`; optional `message_id` supports safe retry inspection. |
| `send_to_codex` | Send `message` to the exact `thread_id`; optional `transport` is `auto` (default), `desktop`, `terminal`, or `ssh`. Configured macOS SSH accepts only `auto`/`ssh` and pins both to its selected host. Optional `message_id` supports safe retry inspection. |
| `bridge_status` | Inspect the caller's recent outgoing delivery records; optional `limit` is 1–100. |
| `bridge_doctor` | Check local transport compatibility, caller identity, and state-directory readiness without sending messages. Works even when caller identity is unavailable. |
| `bridge_panel` | Open the Claude conversation panel in the current Codex chat. |
| `bridge_ui_history` | Read a page of bridge messages exchanged with a selected Claude conversation; used by the panel. |
| `bridge_ui_send` | Send a manually entered message and notify the same owning Codex chat; used by the panel. |
| `bridge_ui_retry_notice` | Retry a definitively failed Codex context notice without resending the Claude message; used by the panel. |

Start from either application. In Codex, use `list_claude_sessions` to find the intended Claude conversation, then call `send_to_claude` with its exact `session_id` and your `message`. In Claude, use `list_codex_chats` to identify a task by title, then call `send_to_codex` with its exact `thread_id` and your `message`. A known exact ID can be used directly. Each message names its own recipient; there is no connection step or exclusive pairing. One conversation can contact several others, and several conversations can contact the same recipient.

Claude listings distinguish interactive terminal sessions (`entrypoint: cli`), print-mode CLI sessions such as `claude -p` (`entrypoint: sdk-cli`), and Desktop Code sessions (`entrypoint: claude-desktop`). These can be open at once; select by exact session ID, not just a shared title or project directory. Print-mode sessions can receive only while their process remains running. After `/clear`, `/resume`, or reopening a conversation, list again before sending if its identity may have changed.

Incoming bridge messages identify their verified source conversation so the recipient can send a reply to its `thread_id` or `session_id`. A reply is simply another direct message; the bridge does not require one and does not infer a destination from the last message received. No connection tokens or prior incoming message are required. Codex sender identity comes from trusted per-call task metadata, independently of daemon availability or the client that created the conversation; a call without it is rejected rather than attributed to the task that started a shared MCP server. Claude sender identity is checked against its live registered Code process, including the MCP server's parent process. `bridge_status` works from either side.

Use a stable `message_id` when investigating uncertain delivery. Deduplication is scoped to the verified sender and exact recipient, so the same ID can identify separate messages to different recipients. Keep the same recipient, ID, and text when checking an uncertain submission; changing any of them may send another message. Repeating an ID while a send is in progress or its outcome is uncertain returns an error without sending again. A failed record is not resent under the same ID; inspect the destination, then choose a new ID to retry. Delivery does not prove the other agent has read or acted on a message. Incoming bridge messages remain collaborator context, not higher-priority instructions.

An explicit `message_id` accepts 1–100 ASCII letters, digits, underscores, or hyphens. Reserved JavaScript object-property names are rejected. Omit it to let the bridge generate a UUID.

Tools return structured results with an output schema as well as their existing JSON text. Lists use `structuredContent.sessions` or `structuredContent.chats`; send and status results retain their object fields. Sends are annotated as irreversible writes so clients can apply their normal approval controls.

### Cancellation and diagnostics

MCP clients can cancel a tool call with `notifications/cancelled`. A cancelled queued call never starts its send. Running calls receive an abort signal; if cancellation occurs after the message is written to an application transport, its local record becomes `uncertain`. Cancellation cannot recall a delivered message. Inspect the destination and `bridge_status` before retrying an uncertain send. The server suppresses responses to accepted cancellations and continues answering `ping` while another tool is running.

Use `bridge_doctor` when discovery or delivery stops working. It checks the local environment and application interfaces without creating a message or changing permissions. Failed checks explain which prerequisite is missing; a healthy transport does not prove a recipient has read a message. If the bridge tools themselves are missing, inspect the MCP startup error first.

In Claude CLI, `/status` shows the native inbox as `Peer address`; `--bare` sessions have no inbox. A session that lacks an inbox cannot receive bridge messages or provide the live caller identity needed to send. Restricted plugin/MCP configuration can also prevent tools from loading. Claude's `crossSessionInbound` controls may hold or refuse incoming messages even when the transport write succeeds. Check the receiving session's normal approval flow and effective settings; the bridge neither reports those outcomes as read receipts nor changes inbound controls. See [Claude cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging#control-inbound-messages).

The native peer envelope retains `from-mode="bypass"`, the v0.3.3 compatibility fix for [issue #1](https://github.com/KeeVeeG/codex-claude-desktop-bridge/issues/1). Removing it makes Bypass recipients hold bridge messages by default, often silently in Desktop. This wire classification is shared by Desktop and CLI on every supported platform; it does not detect the sending Codex task's permission mode or change the receiving Claude session's tool permissions. A prompting receiver (including CLI Manual) may instead hold a bypass-class message for approval. Explicit `crossSessionInbound: hold` or `refuse` still applies; the bridge never changes those settings.

### Conversation panel

Open the **Claude** conversation panel beside the current Codex chat. The panel is intentionally scoped to that chat so its owner and delivery context stay explicit; it does not add a global sidebar app. It lists previously contacted Claude conversations for the current Codex chat and all discoverable local Claude Code conversations, with search by title or project folder. Selecting a conversation shows exchanged bridge messages in both directions, with pagination for earlier messages. The history is scoped to the exact Codex/Claude pair; it does not import the recipient's unrelated native transcript.

When the panel is opened from a model tool call, it requests the host's fullscreen display mode so the conversation view does not expand into a tall inline card. The thread entrypoint remains tied to the current Codex chat.

Type a message in the panel to send it manually. The bridge adds the same text to the owning Codex chat with a compact English header identifying the user send, recipient session, and bridge message ID. The header marks it as context only, without a separate status block. Transport details remain in local delivery records, accessible through `bridge_status`. The current native interface creates a Codex turn for this notice; it is not a new task. Sender identity comes from the panel host's per-call thread metadata, never a thread ID supplied by the widget.

The composer follows Codex's `desktop.composerEnterBehavior` setting when it is available in the local configuration. With the default `enter` behavior, Enter sends and Shift+Enter inserts a newline; `cmdIfMultiline` and `cmdAlways` are also supported.

The public panel chrome, system notices, statuses, errors, accessibility labels, and demo fixtures are English-only. Conversation titles, project paths, and exchanged messages remain verbatim so user content is never translated or altered. A successful send displays "Sent to Claude"; read receipts are unavailable, so this status does not wait for a read confirmation.

Historical Claude Code conversations can appear without a live inbox. Their saved bridge history stays readable, but sending requires that exact conversation to be open as a supported local CLI or Desktop Code session with a verified live inbox. The panel does not launch a conversation. This catalog covers local Code sessions, not Claude's ordinary hosted Chat conversations. The new macOS SSH route does not establish support for the Desktop conversation panel or its context notices.

An uncertain Claude delivery is never automatically retried. A notice failure after a successful Claude send does not cause the original message to be sent again. When the context notice failed definitively, the panel offers `bridge_ui_retry_notice`; this retries only the Codex notice and never the original Claude delivery. The panel uses MCP Apps resources and requires a host with native MCP Apps support. Opening `ui/bridge.html#demo` outside the host shows explicitly labelled fixture data for preview, with no live application access.

### Terminal Claude Code sessions

A `claude` session started in PowerShell or another terminal registers the same local inbox as a Desktop Code session, so it appears in `list_claude_sessions` and can send and receive like any other session. Install the plugin with the `claude` CLI (the local installer or the marketplace commands above); no Claude Desktop is needed. A project-level `.mcp.json` copy of the server is not a substitute, because `${CLAUDE_PLUGIN_ROOT}` is only defined for installed plugins.

A terminal session is reachable only while its process is running. Closing the terminal ends its inbox, and its saved bridge history stays readable. Supported sessions under your user profile are addressable by exact session ID, the same trust boundary as Desktop sessions. The bridge accepts the `claude-desktop`, `cli`, and `sdk-cli` entrypoints; print-mode sessions such as `claude -p` must still be running. After installing or updating, use `/reload-plugins` and check `/mcp`; if old tools remain, exit and resume the exact conversation.

### Windows terminal Codex sessions

`list_codex_chats` combines Desktop discovery with Codex's local app-server daemon. The daemon lists conversations from all creation clients, most recently updated first, because a conversation can move between Desktop and CLI through resume. `source: "desktop"` or `"terminal"` identifies where the entry was discovered; it does not prove where the conversation is open now. If both sources return the same ID, the Desktop entry is retained. Codex CLI can call `send_to_claude` and `bridge_status` with its trusted per-call identity even when the daemon is unavailable.

Without a configured macOS SSH route, `send_to_codex` uses the existing local routing rules below. The daemon and queue adapters described here require native Windows; an explicit `ssh` transport requires the macOS SSH configuration above.

`send_to_codex` accepts an optional `transport`:

- `auto` (default) uses a loaded daemon conversation (`status: "idle"` or `"active"`), regardless of its creation client. If the daemon is unavailable or does not know the ID, it uses the existing Desktop route. A stored `notLoaded` conversation is ambiguous: the bridge refuses before writing and asks for an explicit transport. A discovery source or creation client is insufficient to choose one.
- `desktop` uses Desktop app-tools directly, without probing the daemon.
- `terminal` uses the daemon for loaded conversations and `codex queue` for `notLoaded` conversations or when the daemon is unavailable. The exact ID is retained. A reported error state or an unknown ID in an available daemon is refused.

Choose an explicit transport when the user has identified the recipient's current client. If an automatic send reports ambiguity and that client is unknown, ask whether the selected conversation is in Codex Desktop or CLI, then retry with the specified transport. If a loaded conversation leaves the daemon before an automatic send, the bridge refuses instead of automatically queuing it. An uncertain write never triggers a retry through another transport.

The queue delivers to an open session and holds messages for a closed one, where nothing runs while it is closed. `notLoaded` does not distinguish these cases, and `submitted` means handed to Codex, not read. The queue command has no message-id deduplication; the bridge's delivery ledger still prevents resending a recorded ID. Windows command-line restrictions limit queued text to 16000 characters including the peer envelope and forbid NUL characters. These checks happen before reserving the message ID when the queue route is known in advance; a later transition to the queue is checked again. The direct daemon route does not have these queue restrictions.

A message arrives as a user turn wrapped in a peer notice that says it is collaborator context, not an instruction from the user. A session that is mid-turn is steered: the text appears inside the running turn without interrupting it. A busy session whose running turn cannot be identified or read is refused. The notice asks the receiving Codex to check with its user before consequential actions, so it may ask for confirmation where a Desktop task would act.

The bridge never starts the daemon; if it is not reachable the terminal discovery source is reported unavailable. The unavailable warning is not shown to Desktop-only users who do not have the Codex CLI installed. It is also hidden when `CODEX_CLAUDE_BRIDGE_CODEX_BIN` is mistyped, because the lookup then reports the executable as not found; `bridge_doctor` still reports it. If an established daemon connection fails to answer the target lookup, automatic routing is refused; an explicit `desktop` route skips that lookup. Set `CODEX_CLAUDE_BRIDGE_DAEMON=off` (or `0`, `false`, `no`) to disable the daemon and queue transports, and set `CODEX_CLAUDE_BRIDGE_CODEX_BIN` to the path of `codex.exe` if it is not found automatically. The lookup takes a `codex.exe` on `PATH`, or follows the `codex.cmd` shim of an npm, pnpm, or Volta install to the vendored x64 or Windows ARM64 `codex.exe`; any other install needs the variable. Codex only forwards listed environment variables to plugin servers, which is why both are in the plugin's env list. The conversation panel and manual send stay Desktop-only. `bridge_doctor` reports daemon discovery and the CLI and daemon versions.

Security: any process running as the same Windows user can reach the local daemon socket, the same trust boundary as the rest of the bridge. A peer message sent to a session running with approvals off could be acted on; the notice mitigates this but cannot guarantee it.

### Claude permissions

In the Code tab, Claude's Auto mode may block `send_to_codex` as an external-system write before the bridge receives the call. The local installer adds a narrow user permission when installing Claude; direct marketplace installation requires adding the exact MCP tool through `/permissions`. If Auto blocks the call and no deny rule applies, select **Manual** from the mode selector beside the send button, retry, and approve the MCP tool prompt. Resolve a matching deny or managed policy through Claude's normal controls. A `Bash` rule does not apply to this tool. See [Claude Code permissions](https://code.claude.com/docs/en/permissions#mcp) and [Desktop permission modes](https://code.claude.com/docs/en/desktop#choose-a-permission-mode).

Terminal sessions use their own MCP permission prompts and `/permissions`; the Desktop mode selector does not apply there. The outbound tool permission and Claude's inbound message controls are separate. Do not broaden permissions merely to make a transport check pass.

## Compatibility

Local validation has exercised the adapters with Claude Desktop 2.7032.0.0, Claude Code engine 2.1.284, Codex backend 0.155.0-alpha.16.3, and `codex-app-tools` 0.1.4. Terminal Codex support was validated with Codex CLI and daemon 0.162.1. Interactive Claude CLI registration and inbox compatibility were inspected with Claude Code 2.1.296.

A real Claude Code 2.1.299 print-mode session in Bypass permissions received an authenticated native inbox message and replied through the bridge MCP server to a simulated Codex endpoint, preserving the exact source, recipient, and test nonce without changing the receiver's mode. That smoke test validates the live Claude side; it is not an end-to-end run against the real Codex Desktop UI or evidence that every inbound policy permits delivery. These are observed validation versions rather than a broad compatibility guarantee; private application interfaces can change in later releases.

The author of [PR #2](https://github.com/KeeVeeG/codex-claude-desktop-bridge/pull/2) reported a live macOS smoke test of the original contribution. The merged code changes SSH routing, loaded-thread handling, endpoint validation, and process-identity checks; no new live macOS smoke test has validated this merged implementation. Simulated transport tests do not establish end-to-end macOS compatibility.

The MCP server uses standard stdio. Native Claude inboxes and local Desktop delivery depend on application interfaces that can change. macOS Unix socket paths must be absolute, normalized, and no longer than 103 UTF-8 bytes. Darwin process registration is checked against `ps` process-start output with UTC and C locale settings; unverifiable identities are refused. Linux process identity and end-to-end delivery remain unsupported.

Application delivery credentials remain local and are not included in chat messages or model-supplied routing arguments. The bridge sends explicit messages rather than entire conversation histories and does not emit diagnostic logs of tool arguments.

Message text and delivery records are saved locally. See the [privacy disclosure](docs/PRIVACY.md) for storage, deletion, credentials, and processing by the receiving applications.

Root `plugin.json` and `mcp.json` are the canonical Agent Plugins 1.0 definitions. OpenAI presentation metadata lives in `extensions.com.openai`. `npm run manifests:sync` generates the Codex and Claude compatibility manifests and the checked-in `compatibility/native/` runtime. Edit the canonical definitions and root runtime files, then regenerate the native copy; `npm run manifests:check` detects version, configuration, or runtime drift.

The default installer, Git marketplaces, and release marketplace use that native runtime. Agent Plugins 1.0 cannot declare `env_vars`, while the current Codex MCP launcher requires explicit forwarding of its native pipe context. Keeping the deployed native runtime free of root portable manifests preserves this forwarding. Its canonical sources are stored under `config/` so it can still validate and reinstall itself. Codex declares its MCP command inline and resolves `cwd` from the installed plugin root; Claude uses `.mcp.json` with `${CLAUDE_PLUGIN_ROOT}`.

A separate `-portable-<version>.zip` contains the root Agent Plugins manifests. Its host must provide the application's native execution context; installing that format alone does not make Desktop routing available. Use the default native package for Windows or the configured macOS SSH route. The agent workflow is in `skills/claude-bridge` in both layouts.

## Development

```powershell
npm run manifests:sync
npm run manifests:check
npm test
```

Tests use temporary registries, local IPC, and simulated application/SSH endpoints. They do not send messages to your live conversations or change application settings. Generated test artifacts stay under the ignored `work/` directory.

Test files run sequentially because the lock-recovery stress tests already start multiple child processes. Windows and macOS CI check Node.js 20, 22, 24, and 26 and build the release package. Platform-specific tests are skipped only on the other operating system; CI uses simulated application endpoints, not live Claude or Codex accounts.

The runtime has no npm dependencies. `lib/claude-desktop.mjs`, `lib/codex-desktop.mjs`, `lib/codex-daemon.mjs`, and `lib/codex-ssh.mjs` isolate the application-specific protocols, `lib/desktop-service.mjs` routes direct messages, and `lib/store.mjs` stores delivery records in the shared user-profile state directory.

Only connection attempts have short technical timeouts (10 seconds for Claude, up to 30 seconds for a Codex tool call). There is no timeout for a person or agent to answer a message.

For packaging and release commands, see [Releases](docs/PUBLISHING.md).

## License

[MIT](LICENSE) — Copyright © 2026 KeeVeeG.

This is an independent project and is not affiliated with or endorsed by OpenAI or Anthropic.
