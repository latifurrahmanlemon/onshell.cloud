/**
 * Public surface of the agent core, for embedders.
 *
 * `main.ts` is the CLI. The Electron desktop app in `apps/agent-desktop` needs
 * the same machinery — pair, connect, read the log — but driven by a tray and a
 * window instead of argv, so the logic lives in these modules and both front
 * ends import it. Nothing here opens a shell or a socket on load; that only
 * happens when the embedder constructs an `AgentTunnel` and calls `start()`.
 */
export { AGENT_VERSION, configPath, loadAgentConfig, saveAgentConfig, type AgentConfig } from "./config.js";
export { APPROVAL_MODES, isApprovalMode, type ApprovalMode } from "./consent.js";
export { discoverShells, type ResolvedShell } from "./shells.js";
export { AgentTunnel } from "./tunnel.js";
export { pair } from "./pair.js";
export { auditPath, readAudit, recordAudit } from "./audit.js";
export { serviceDefinition } from "./service.js";
