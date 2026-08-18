/**
 * Public surface of the agent core, for embedders.
 *
 * `main.ts` is the CLI. Onshell Desktop (`apps/desktop`) needs the same
 * machinery — pair, connect, serve a shell, read the log — but driven by a
 * window and a tray instead of argv, so the logic lives in these modules and
 * both front ends import it. There is exactly one implementation of who may
 * open a shell on somebody's machine, which is the point: two would drift, and
 * the one that drifted would be the one deciding.
 *
 * Nothing here opens a shell or a socket on load; that only happens when the
 * embedder constructs an `AgentTunnel` and calls `start()`.
 */
export { AGENT_VERSION, configPath, loadAgentConfig, saveAgentConfig, type AgentConfig } from "./config.js";
export { APPROVAL_MODES, isApprovalMode, type ApprovalMode } from "./consent.js";
export { discoverShells, type ResolvedShell } from "./shells.js";
// The desktop app serves this machine's shell to a terminal in its own window,
// with no tunnel in between. That is a different topology, not a different way
// of starting a shell, so it reuses the spawn path rather than growing a second
// one that could drift on environment, fallback behaviour, or quoting.
export { ptyStatus, spawnPty, type AgentPty, type SpawnPtyOptions } from "./pty.js";
export { AgentTunnel } from "./tunnel.js";
export { pair } from "./pair.js";
export { auditPath, readAudit, recordAudit } from "./audit.js";
export { serviceDefinition } from "./service.js";
