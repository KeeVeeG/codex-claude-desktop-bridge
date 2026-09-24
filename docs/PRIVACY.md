# Privacy and local data

## Data flow

The bridge lists conversation titles/identifiers so a sender can select a destination, then forwards explicitly submitted text to that Desktop conversation. The sender names an exact destination for each message; there is no exclusive pairing. Incoming messages include the verified sender's conversation ID so the recipient can reply. The bridge does not automatically copy entire conversation histories or read project-file contents. A message can itself contain code, paths, personal data, or other information its sender chooses to include.

The plugin communicates with local application endpoints. It provides no public HTTP service, analytics endpoint, or hosted message relay. After delivery, Codex or Claude processes the message through the user's existing application/account. Those applications and their providers can process and retain conversation content under their own account settings and policies. Local transport does not mean the receiving AI application operates offline.

## Local records

By default, state is stored under `~/.local/share/codex-claude-desktop-bridge` in the user's profile, shared by both applications. The local installer writes that absolute location into the staged MCP configuration; the source configuration contains no personal path. `CODEX_CLAUDE_BRIDGE_STATE_DIR` can explicitly select another shared directory. This avoids app-specific MSIX virtualization of `LOCALAPPDATA` and does not depend on the project working directory. Records include:

- Outgoing message text, IDs, sender and destination identifiers, timestamps, fingerprints, delivery status, and available transport receipts/errors.
- Conversation names, registry paths, and local routing addresses.
- A Codex host-discovery record with its local pipe address, context thread ID, and process metadata.

These are ordinary local JSON files, not application-level encrypted storage. The bridge does not implement automatic retention expiry or a message recall operation. Local delivery records remain until the bridge state is removed; messages already delivered to either application remain under that application's controls. Version 0.1.0 also stored one-to-one routing metadata; upgrading does not automatically erase those older local records.

Earlier versions used `LOCALAPPDATA` and may have records in separate application-specific locations. Changing the default does not automatically migrate or erase those older records.

To remove bridge records, stop its MCP processes and remove the intended bridge state directory after checking its resolved path. This also removes host discovery records. Use the respective application's controls for its conversation copies; deleting bridge state does not delete provider-side records or backups. OS backup or sync software may separately copy a configured state directory.

## Credentials and diagnostics

Claude's delivery credential remains in Claude's own registration/key storage. The bridge reads the selected live session's credential when preparing a send, uses it in process memory, and does not intentionally persist it in bridge state or message text. Models do not receive a routing secret to copy between chats.

The MCP server does not write a diagnostic log of tool arguments. Message text is nevertheless retained in the local delivery records described above and is returned by message/status tools. Applications may retain tool inputs, outputs, errors, and conversation history independently.

## Permissions and scope

The bridge uses ordinary application MCP permissions and checks the sender's runtime identity before accepting a message. A sender selects its destination by conversation ID; knowing an ID does not let it impersonate that conversation. It does not grant file access or bypass application denials. A receiving agent can act on a message using its own permitted tools; the bridge is not a file sandbox or a security boundary against other software running as the same OS user.

The local installer changes plugin/catalog files and keeps backups of replaced local catalogs and staged plugin files. When it installs Claude, it also adds only the outbound `send_to_codex` MCP tool to the user's allow rules and backs up the previous settings file. That user-level rule applies to all Claude Code sessions using the profile. `--codex` and `--prepare-only` do not change Claude tool permissions. The installer uses a runtime file allowlist and excludes bridge state, credentials, and backups from release archives.
