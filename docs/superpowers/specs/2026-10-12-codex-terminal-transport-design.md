# Codex terminal transport: design

Status: draft for review. Not committed. Date: 2026-10-12.

## Purpose

The bridge today connects **Codex Desktop** tasks and **Claude Code** sessions. A companion change (already implemented, uncommitted) lets a terminal `claude` session join as a Claude peer. This spec covers the other side: letting a **terminal Codex CLI session** (`codex` in PowerShell, originator `codex-tui`) be a bridge peer, alongside Codex Desktop tasks.

Success: a terminal Codex session and a Claude Code session (Desktop or terminal) can message each other by exact ID, with today's semantics: direct addressing, no pairing, no mandatory reply, no deadline, delivery records kept locally.

Out of scope: Codex Cloud tasks, `codex exec` (non-interactive, originator `codex_exec`) sessions, macOS/Linux, any change to how Codex Desktop is reached.

## Evidence this design rests on

Established by probes on this machine (Codex CLI 0.162.1, daemon 0.162.1):

- A shared app-server daemon listens on `~/.codex/app-server-control/app-server-control.sock`. It speaks WebSocket (HTTP Upgrade, masked text frames of JSON-RPC) through `codex app-server proxy` over stdio. The unix socket has no auth, and its directory ACL restricts it to the owning user. Node cannot `lstat` it (EACCES); access is through the proxy only.
- A terminal `codex` session registers with the daemon: it appears in `thread/loaded/list` and `thread/list`.
- `thread/list` thread objects carry `originator`: `codex-tui` (terminal), `Codex Desktop`, `codex_exec`. `source` is `"vscode"` for both terminal and Desktop and must not be used to discriminate. The daemon rejects an `originators` filter (-32602), so filtering is client-side.
- A bare `turn/start` over the WebSocket to an idle loaded terminal thread starts a turn immediately, with no `thread/resume`, and the turn completes. `clientUserMessageId` is accepted. `codex queue` produces an indistinguishable rollout.
- The same route cannot reach a Codex Desktop thread: `turn/start` returns "thread not found" and `thread/resume` returns "already has an active writer". Desktop runs its own app-server and holds the writer lock. `codex queue` does reach a Desktop thread (mechanism unknown).
- Codex CLI sends `_meta["x-codex-turn-metadata"]` (JSON with `thread_id`) on MCP tool calls. MCP server environments contain no `CODEX_*` variables and in particular no `CODEX_APP_TOOLS_PIPE_PATH`.

Not established (see "Open items"): how the terminal UI displays an externally started turn, busy-thread behavior, daemon lifetime after the last terminal exits, non-yolo approval prompt wording.

## Decisions (user-approved)

1. **Two transports behind one interface.** The Desktop app-tools pipe stays as is. A new daemon transport serves terminal sessions. Routing is by `originator`.
2. **Busy threads: allow steering.** A send to a mid-turn terminal thread is delivered by `turn/steer` instead of being refused. This is unverified; see "Steering" and the mandatory probe.
3. **Terminal Claude sessions are addressable by default** (no opt-in), same trust boundary as Desktop sessions.

## Architecture

```
Codex tools (list_codex_chats, send_to_codex, bridge_*)
        |
  desktop-service.mjs  --- routes by target kind ---+
        |                                           |
 CodexTransport (interface)                         |
   list({limit,signal}) -> chats[]                  |
   send({threadId, text, messageId, signal}) -> receipt
        |                         |
 pipe transport              daemon transport
 lib/codex-desktop.mjs       lib/codex-daemon.mjs  (new)
 (unchanged behavior)        WebSocket over `codex app-server proxy`
```

### Units

**`lib/codex-daemon.mjs` (new).** One purpose: speak the app-server protocol to the local daemon.
- `connect()`: spawn the proxy, upgrade to WebSocket, `initialize` + `initialized`. Spawns the resolved native `codex.exe`, never `shell:true`. The executable path is resolved from `codex` on `PATH` and its npm vendor layout; if resolution fails, the transport reports unavailable with that reason.
- `listTerminalThreads({limit})`: `thread/list` (default interactive sources) plus `thread/loaded/list`; keep `originator === 'codex-tui'`; return id, title (`name` or `preview`), `cwd`, `status`, `updatedAt`.
- `sendToThread({threadId, text, messageId})`: see "Send path".
- Frame limit: reject outbound messages above 8 MiB (the daemon allows 16 MiB).
- No unauthenticated start of anything: if the proxy cannot connect, the result is "daemon unavailable". The bridge never runs `codex app-server daemon start`.

**Transport interface and router (`lib/desktop-service.mjs`).** Routing is by positive identification, not by list membership. An ID the daemon positively identifies as originator `codex-tui` (via `thread/read`, independent of any list limit) is routed to the daemon transport. **Every other ID goes to the Desktop pipe exactly as today**, so an exact older Desktop task ID that is absent from the recent list stays addressable (`test/mcp.test.mjs:559-563` must keep passing). If the daemon is unreachable, all IDs take the Desktop path. If an ID is claimed by both, the daemon's originator decides; the rule and a test for ownership change are specified in the implementation plan.

**Host registry (`lib/codex-host.mjs`).** Records gain a `kind` (`desktop` | `terminal`). `pipePath` is required only for `desktop`. Existing records without `kind` are read as `desktop`. A `terminal` caller needs no registry record because its thread ID comes from per-call metadata and the daemon needs no per-session endpoint.

**Caller identity (`codexIdentity`).** Accept a thread ID from `x-codex-turn-metadata.thread_id` (as today) without requiring `CODEX_APP_TOOLS_PIPE_PATH`. A call with no thread metadata is still rejected. The caller's kind is determined by looking up its thread ID's `originator` in the daemon listing; if the daemon is unreachable, a caller with a pipe variable is `desktop`, and one without is rejected with a clear error.

**Listing.** `list_codex_chats` returns Desktop chats (pipe) merged with terminal chats (daemon), each carrying a `source` field (`desktop` | `terminal`). If one source is down, the other is returned and the unavailability is reported without failing the call. Today the service returns a plain array that `scripts/mcp.mjs:203-204` wraps as `{chats: value}`. The implementation defines one normalized listing result and updates the wrapper, the `codexChat`/output schema (`source`, optional per-source status) and the contract test in `test/mcp.test.mjs` together; the array contract is not silently changed. Terminal discovery paginates `thread/list` until enough `codex-tui` threads are collected or the cursor ends, and hydrates `thread/loaded/list` IDs via `thread/read`.

## Send path (terminal)

1. Precondition: target thread is in the merged listing as `terminal`.
2. `thread/read` (no turns) to get `status.type`.
3. `idle`: `turn/start` with `threadId`, `input: [{type:"text", text}]`, `clientUserMessageId = bridge message id`. **No** per-turn overrides (they persist into later turns).
4. `active`: steering path (below).
5. `notLoaded`/`systemError`: refuse with a clear error. Never call `thread/resume`; the daemon enforces one writer per thread and resuming risks fighting the owner.
6. Outcome classification follows the existing conservative rule in `lib/codex-desktop.mjs:110`, where a rejected mutating call is `deliveryUnknown` unless it is a proven pre-acceptance rejection. For the daemon: an allowlist of proven pre-acceptance errors (for example "thread not found" and invalid-params validation errors, matched by code and text and recorded during the probe) is recorded `failed`. Every other JSON-RPC error, and any connection loss after the request was written, is recorded `uncertain` and never auto-retried. Accepting `clientUserMessageId` is not treated as proof of deduplication. This matches today's store semantics (`lib/store.mjs`).

### Message framing

The existing Desktop notice (`lib/desktop-service.mjs:315`) only identifies the source session and bridge message ID. It carries no statement that the text is peer context. For terminal sends the implementation specifies an exact envelope (peer notice, verified source ID, bridge message ID, body with any nested closing tag neutralized, mirroring `claudePeerContent` in `lib/claude-desktop.mjs`). A text label cannot enforce reduced authority: both `turn/start` and `turn/steer` submit ordinary user input, and a `--yolo` terminal will act on it. The envelope is a mitigation, not a guarantee, and the test plan includes adversarial cases (a peer message that instructs the receiver to run a command, to edit files, or to impersonate the user).

### Steering results (supervised probe, 2026-10-13)

Run against the user's live terminal Codex session while it executed a long counting task:

- **Active turn lookup:** `thread/read` with `includeTurns: true` returns turns whose `status` is the string `"inProgress"` for the running turn (turn shape: `id, rootTurnId, items, itemsView, status, error, startedAt, completedAt, durationMs`). The rule "last turn with status `inProgress`" found it.
- **Steer accepted:** `turn/steer { threadId, expectedTurnId, input }` with the real turn ID returned `{ turnId }`. User observation: the text appeared inside the running turn, the count continued with no reset, gap, duplicate or interruption and exited successfully, the display looked normal, and the session answered `received`.
- **Wrong turn ID:** rejected with code `-32600`, message ``expected active turn id `<given>` but found `<actual>` `` (a different turn is active).
- **Idle thread:** rejected with code `-32600`, message `no active turn to steer`.

Decision: steering stays in the design. The stale-steer fallback matches code `-32600` and a message beginning `no active turn to steer` or `expected active turn id`. Not tested: steering while the TUI is waiting on an approval prompt, and rapid repeated steers.

### Steering

For an `active` thread the transport reads the active turn ID and calls `turn/steer {threadId, expectedTurnId, input}`.
- If the turn ended in between, `turn/steer` fails with a JSON-RPC error saying the turn is not active or `expectedTurnId` does not match; the exact error code and text are recorded during the probe and matched narrowly. Only that error triggers one retry as `turn/start`. Any other error, or a connection loss, is recorded as `failed` or `uncertain` with no retry. A rejected steer delivered nothing, so the retry cannot double-deliver.
- Mandatory first implementation task: **a supervised probe** on a busy terminal session the user controls, to confirm (a) `turn/steer` delivers text visibly into the running turn, (b) it does not interrupt or corrupt the turn, (c) what the terminal UI shows. If the probe shows interruption, lost input, or confusing display, steering is dropped and sends to busy threads are refused (idle-only), and the user is told before merging.

## Error handling

| Condition | Behavior |
| --- | --- |
| `codex` not on PATH / exe unresolved | terminal source unavailable, reason in `bridge_doctor`; Desktop unaffected |
| Daemon not running (proxy connect error 10061) | terminal source unavailable; never started |
| Target not loaded / not found | clear error naming the thread; no resume |
| Steer race (turn ended) | one retry as `turn/start`; definitive failure recorded |
| Connection lost after write | `uncertain`, no retry, inspect via `bridge_status` |
| Frame over 8 MiB | rejected before sending |

`bridge_doctor` gains checks: codex executable resolved, daemon reachable, version of CLI and daemon, and a note when they differ. Daemon status comes from `codex app-server daemon version`, which reports state without starting anything.

## Security

- Trust boundary: any process running as the same Windows user can use the daemon socket and has always been able to. The bridge adds no network exposure.
- No tokens or credentials are read or logged. Peer text is delivered as plain input with the peer header.
- Terminal Claude and terminal Codex sessions become addressable by exact ID by default (decision 3). An env var opt-out is a possible later addition.
- Do not use `shell:true`; pass arguments as an array.
- A send never resumes, forks, archives or renames a thread.

## Testing

- A fake daemon: an in-process WebSocket server behind a stub `codex.exe` shim that the transport spawns (mirrors the existing real-pipe fixtures). It implements `initialize`, `thread/list`, `thread/loaded/list`, `thread/read`, `turn/start`, `turn/steer` with scriptable errors.
- Cases: list filters to `codex-tui`; idle send; active send via steer; steer race falls back to start; not-loaded refusal; JSON-RPC error recorded `failed`; dropped connection recorded `uncertain`; oversize rejected; daemon-down reports unavailable and never starts; caller identity from metadata with no pipe variable; legacy registry record without `kind`.
- Existing Desktop tests must pass unchanged.
- A live smoke test (manual, documented, not in CI) against the author's terminal session.

## Open items (must be resolved or accepted before merge)

1. Display of an externally started turn: **confirmed by the user** that a daemon `turn/start` message (PROBE-1) showed up live in the terminal tab, and a `codex queue` message (PROBE-4) showed up in Codex Desktop. A follow-up test (daemon `turn/start` to an idle terminal thread while the user had a half-typed, unsent prompt in the input box) was **confirmed by the user**: the draft remained intact, the cursor stayed in place, typing could resume immediately, the screen was not scrambled, and nothing collided. Not tested: the same while the user is actively typing at the moment of arrival, and a busy thread (see Steering).
2. Steering behavior (see probe).
3. Daemon lifetime after the last terminal session exits, and whether a fresh `codex` registers with a daemon that is not yet running.
4. Mechanism by which `codex queue` reaches a Desktop-owned thread. Not needed by this design (Desktop stays on the pipe) but it could become a Desktop fallback later.
5. Approval prompt wording for the send tools in a non-yolo terminal session; the plugin's send tools already declare `readOnlyHint:false, destructiveHint:true`.
6. A Desktop thread that Desktop has never opened since launch was not tested against the daemon.
7. Live end-to-end verification of the terminal **Claude** side (separate change) is still pending.

## Review findings still to resolve

From a review by the terminal Codex session itself (sent through the bridge's own delivery path as a test; 11 findings, four verified against the code and applied above). Not yet verified or resolved, to be settled in the implementation plan:

1. **Steering turn ID.** The source of `expectedTurnId` for an active thread is unspecified. A new connection did not observe `turn/started`. The supervised probe must find a non-resuming lookup (for example `thread/read` with turns) that reliably returns the active turn ID.
2. **Steer mismatch is not "idle".** An `expectedTurnId` mismatch can mean a newer turn already started. Distinguish "no active turn" from "mismatch"; recheck state before falling back to `turn/start`. The idle-read to `turn/start` race itself is untested.
3. **Recipient approvals and user-input requests.** An externally started turn in a non-yolo terminal may raise approval or elicitation requests. Verify the owning terminal keeps handling them and that closing the sending connection does not cancel the turn.
4. **Transport-independent caller identity and readiness.** `identifyCaller` (`desktop-service.mjs:47`), `hostFor`, and doctor readiness are Desktop-dependent today. Specify terminal-only integration tests that run with no Desktop registry, Claude-identity precedence, and the Desktop caller fallback when the daemon omits an ID.
5. **`manual-service.mjs:194` and the panel.** Broadening `codexIdentity` affects the manual/panel path, which sends owner notices through the pipe. Keep application identity separate from transport kind, and explicitly support or reject terminal panel operations before any mutation.
6. **Test plan additions.** Concurrent repeated message IDs, the same ID from different senders, accepted-but-response-lost input, receipt-save failure, cancellation before and after the write, malformed responses, bounded inbound frames, proxy shutdown and cleanup, and fixtures validated against the exact wire schema of a supported CLI version.

## Rollout

Ship behind no flag; Desktop behavior is unchanged when no terminal Codex sessions exist. README gains a "Terminal Codex sessions" section; `skills/claude-bridge/SKILL.md` and tool descriptions are updated to say Codex chats may be Desktop or terminal. Version bump and release follow the existing `docs/PUBLISHING.md` process.
