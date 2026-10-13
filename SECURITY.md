# Security

## macOS outbound SSH route

The optional macOS route uses an operator-selected SSH config alias and the public Codex app-server. It retains strict host-key verification and batch authentication, never reads SSH credentials itself, and never opens the protected Desktop app-tools socket as a fallback. The bridge preserves verified Claude caller identity and its existing per-sender delivery ledger. Only already-loaded idle threads are eligible; no new thread, server, permission override, or automatic retry is created. A lost reply or cancellation after transmitting a turn is recorded as uncertain and must be reconciled before a new submission.

Please report a vulnerability through [GitHub private vulnerability reporting](https://github.com/KeeVeeG/codex-claude-desktop-bridge/security/advisories/new). Include the affected version, Windows and application versions, a minimal reproduction, and the expected impact. Avoid posting credentials, private conversation text, or live routing addresses in public issues.

For installation and usage problems that do not expose sensitive data, [open a public issue](https://github.com/KeeVeeG/codex-claude-desktop-bridge/issues/new).
