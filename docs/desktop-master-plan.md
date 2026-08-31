# Onshell Desktop master plan

Status: active

Started: 2026-08-30

Scope: `apps/desktop` and the desktop release pipeline. The existing web application stays unchanged.

Release target for this work: `desktop-v0.3.1`. Do not replace the already-published `0.3.0` binaries in place; a new version keeps update checks, checksums, and incident history honest.

## Product direction

Onshell Desktop should feel like a serious daily workstation for infrastructure teams: fast, dense, keyboard-first, calm under pressure, and native enough to feel at home on macOS, Windows, and Linux. Termius is a useful feature benchmark, not a visual template to copy. Onshell keeps its own identity and its differentiators: local shells, direct/relay transparency, self-hosting, auditable access, and the ability to share the current computer.

The current Termius product surface publicly highlights hosts and groups, terminal tabs/workspace restoration, IDE-style autocomplete, SFTP, snippets, encrypted vaults/key generation, port forwarding, direct/offline connections, secure team sharing, and activity/session visibility. Sources: [Termius product](https://www.termius.com/), [Termius vault](https://www.termius.com/vault), and [Termius security](https://www.termius.com/security).

## Non-negotiable principles

- The website remains intact. Shared API/domain packages may grow, but desktop UI work must not restyle or replace the web console.
- Security boundaries remain intact: no remote renderer code, no credentials in renderer state, no silent direct-to-relay fallback, and secrets remain in the OS keychain.
- Desktop is keyboard-first: every core action has a discoverable shortcut and visible focus state.
- The UI uses semantic design tokens, one SVG icon language, 4/8px spacing, 150–250ms purposeful motion, and WCAG AA contrast in both themes.
- Large host, session, and file lists are searchable and virtualized before they become a performance problem.
- “Feature parity” means equivalent user outcomes, not cloning proprietary implementation or branding.

## Information architecture

The permanent activity rail contains Hosts, Files, Snippets, Port Forwarding, Vault, Workspaces, History/Audit, and Settings. A contextual resource sidebar shows the selected area. The remaining workspace holds persistent tabs, splits, terminal/SFTP/RDP content, and inspectors. Command palette (`Ctrl/Cmd+K`) is the universal fast path; the first UI foundation uses it to focus search and later phases expand it into actions.

## Capability matrix and delivery order

| Capability                     | Today                                  | Target                                                                                     | Phase |
| ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------ | ----- |
| Local shell                    | Working                                | Profiles, startup command, duplicate/reconnect, restore                                    | 1–2   |
| Direct and relayed SSH         | Working                                | Rich host details, reconnect, jump hosts, proxy command, agent forwarding                  | 2     |
| Terminal tabs                  | Working                                | Drag/reorder, pin, split panes, broadcast input, workspace restore                         | 2     |
| Search/favorites/snippets      | Basic                                  | Command palette, tags/groups, snippet folders/variables/run confirmation                   | 2     |
| SFTP                           | Working dual-pane base                 | New folder, rename/delete, edit, queue, pause/resume, conflict handling, drag/drop         | 2     |
| Host and credential management | Web-managed                            | Full desktop CRUD, import/export, known-host verification, OS keychain integration         | 3     |
| Port forwarding                | Missing                                | Local, remote, dynamic/SOCKS; saved rules; live traffic/status; background lifecycle       | 3     |
| Workspaces                     | Missing in desktop                     | Saved tab/split layouts, bulk open, crash-safe restore                                     | 3     |
| RDP                            | Gateway path exists; viewer incomplete | Native-quality viewer, clipboard, scaling, multi-monitor policy                            | 4     |
| Autocomplete                   | Missing                                | Local command history first; opt-in context-aware suggestions without leaking secrets      | 4     |
| Team collaboration             | Partial through web/API                | Shared vaults, roles, approvals, session handoff, presence and audit                       | 4     |
| Offline-first                  | Local shell only                       | Encrypted local cache for hosts/settings/snippets; direct SSH offline; safe sync conflicts | 4     |
| Enterprise controls            | Mostly web/API                         | SSO policy surfacing, device trust, exportable audit, managed settings                     | 5     |
| Hardware/biometric keys        | Missing                                | FIDO2/WebAuthn SSH keys, Touch ID/Windows Hello gate, key generation/rotation              | 5     |

## Phases

### Phase 1 — trustworthy install and professional shell

Deliver the new activity rail, resource sidebar, consistent vector icons, compact tabs, polished empty states, keyboard search/new-terminal shortcuts, focus states, reduced-motion support, and responsive desktop density. Keep all current terminal/file/settings behavior working. Public macOS tags must fail unless they are Developer ID signed and notarized, and CI must verify both architecture bundles before upload.

Exit criteria: typecheck/build pass; Windows 10/11 at 100% and 150% scaling; macOS Intel and Apple Silicon install without Gatekeeper bypass; keyboard-only smoke test; light/dark contrast review.

### Phase 2 — daily terminal and file workflow

Add split panes, tab reorder/pin/duplicate/reconnect, session restoration, a real command palette, host groups/tags, richer snippets, and production-grade SFTP operations with a transfer queue. Persist layout locally using a versioned schema and never persist terminal secrets or raw scrollback by default.

Exit criteria: restore survives app restart and schema migration; 50 concurrent saved tabs remain responsive; SFTP transfers recover cleanly after interruption; every destructive file action has confirmation or undo.

### Phase 3 — infrastructure management

Bring host, vault, key, known-host, workspace, and port-forward management into desktop. Reuse API contracts rather than embedding the web console. Port forwards run in the main process, expose an explicit active indicator, and stop according to a user-visible close/background policy.

Exit criteria: SSH host lifecycle can be completed without opening the website; local/remote/dynamic forwards have integration tests; credentials never cross into the renderer; import/export round trips without loss.

### Phase 4 — advanced protocol and collaboration

Complete RDP, offline direct access, autocomplete, shared team resources, approvals, and session handoff. Autocomplete begins with local history and static shell knowledge; any AI/cloud enhancement is opt-in and redacts secrets by construction.

Exit criteria: reconnect/offline conflict tests pass; RDP input/clipboard/scaling tested on supported platforms; collaboration has explicit role checks and auditable events.

### Phase 5 — enterprise hardening

Add FIDO2 and platform biometrics, managed configuration, enterprise policy surfacing, performance telemetry with privacy controls, accessibility certification, staged updates, crash recovery, and signed/notarized release provenance.

Exit criteria: security review, threat-model update, SBOM and checksums, signed update verification, release rollback drill, WCAG AA audit, and documented support matrix.

## Release and quality gates

- Pull request: renderer/main typecheck, unit tests, production build, and IPC contract tests.
- Visual: snapshot the signed-out flow, empty workspace, active terminal, files, settings, light mode, dark mode, 100%/150% scaling, and reduced motion.
- macOS tag: require Developer ID Application certificate, Apple ID app-specific password, Team ID, hardened runtime, notarization, and `codesign`/`spctl` verification for x64 and arm64.
- Windows tag: Authenticode-sign the installer and executable; test clean Windows 10/11 VMs and SmartScreen reputation over time.
- Update channel: stable/beta channels, signed metadata, staged rollout, rollback, and no arbitrary remote renderer code.
- Performance budgets: window usable in under 2s on a reference machine, input feedback under 100ms, terminal resize at 60fps, no unbounded renderer list or scrollback growth.

## Phase 1 implementation record

- Added the professional three-column desktop shell (activity rail, resource sidebar, workspace).
- Replaced text/emoji actions with a consistent SVG icon system.
- Added searchable resource hierarchy, counts, connection state, keyboard focus shortcut, and new-local-terminal shortcut.
- Reworked tabs and the first-run terminal workspace state for clearer hierarchy and faster scanning.
- Added semantic theme tokens, keyboard focus, light/dark parity, and reduced-motion handling.
- Changed the release workflow so a tagged unsigned/unnotarized macOS build cannot be published as a public release.

## Phase 2 implementation record

- Added a real keyboard command palette for hosts, snippets, local files, Vault, history, and settings.
- Added duplicate, reconnect, close-tab and next/previous-tab keyboard workflows.
- Added a two-terminal split view that keeps both xterm instances live and correctly refits each pane.
- Added a desktop Vault overview that exposes credential metadata and host assignments without exposing secrets.
- Added recent session and workspace audit views using the existing secure main-process API boundary.
- Kept partial API failures recoverable: unavailable audit/history data no longer prevents local or remote terminal access.
- Added account-bound workspace restoration that persists connection targets only, never credentials, scrollback, or terminal input.
