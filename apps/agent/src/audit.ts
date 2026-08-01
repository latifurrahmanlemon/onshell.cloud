/**
 * The machine's own record of what was done to it.
 *
 * Deliberately a plain file on the customer's disk, readable without our
 * servers and without an account. Everything else in this product is a log we
 * keep about them; this is the log they keep about us, and it is the only one
 * that is still there if the workspace is deleted, the subscription lapses, or
 * they simply stop trusting the dashboard.
 *
 * Append-only JSON lines, one event per line, so it survives a crash mid-write
 * with at most one truncated record and can be read by anything.
 */
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDirectory } from "./config.js";

export type AuditEvent =
  | "session.requested"
  | "session.granted"
  | "session.denied"
  | "session.ended"
  | "terminal.opened"
  | "terminal.closed"
  | "file.read"
  | "file.written"
  | "file.removed"
  | "agent.started"
  | "agent.stopped";

export function auditPath() {
  return join(configDirectory(), "audit.log");
}

/**
 * Records one event.
 *
 * Never throws: a machine with a full disk or a locked file should still give
 * its owner a working terminal. The failure is reported once to the console and
 * then swallowed, because the alternative — refusing sessions because logging
 * broke — trades a real capability for a paper one.
 */
export async function recordAudit(event: AuditEvent, detail: Record<string, unknown> = {}) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`;

  try {
    const path = auditPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line, { mode: 0o600 });
    // `appendFile`'s mode applies only when it creates the file; tighten anyway
    // in case it was created by something more permissive.
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    console.warn(`[onshell-agent] could not write the local audit log — ${String(error)}`);
  }
}

/** Reads back the most recent entries, for `onshell-agent log`. */
export async function readAudit(limit = 50) {
  try {
    const lines = (await readFile(auditPath(), "utf8")).split("\n").filter((line) => line.trim().length > 0);
    return lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A record truncated by a crash: shown rather than hidden, because a
        // gap in this file is exactly the thing somebody reading it cares about.
        return { at: "?", event: "unreadable", raw: line.slice(0, 200) };
      }
    });
  } catch {
    return [];
  }
}
