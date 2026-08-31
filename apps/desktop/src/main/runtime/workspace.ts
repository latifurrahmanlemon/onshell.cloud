import type { TerminalTarget } from "../../shared/ipc.js";

const MAX_TARGETS = 24;
const MAX_ID = 200;
const MAX_LOCAL_VALUE = 1_000;

/**
 * Accept only the narrow, serializable target shapes the terminal API already
 * understands. IPC input is untrusted even though it came from our renderer.
 */
export function safeWorkspaceTargets(input: unknown): TerminalTarget[] {
  if (!Array.isArray(input)) return [];
  const targets: TerminalTarget[] = [];
  for (const value of input.slice(0, MAX_TARGETS)) {
    if (!value || typeof value !== "object") continue;
    const target = value as Record<string, unknown>;
    if (target.kind === "local") {
      targets.push({
        kind: "local",
        ...(typeof target.shellId === "string" ? { shellId: target.shellId.slice(0, MAX_LOCAL_VALUE) } : {}),
        ...(typeof target.cwd === "string" ? { cwd: target.cwd.slice(0, MAX_LOCAL_VALUE) } : {})
      });
      continue;
    }
    if ((target.kind === "direct" || target.kind === "relay") && typeof target.hostId === "string") {
      targets.push({
        kind: target.kind,
        hostId: target.hostId.slice(0, MAX_ID),
        ...(typeof target.credentialId === "string" ? { credentialId: target.credentialId.slice(0, MAX_ID) } : {}),
        ...(target.kind === "relay" && typeof target.shell === "string"
          ? { shell: target.shell.slice(0, MAX_LOCAL_VALUE) }
          : {})
      });
    }
  }
  return targets;
}
