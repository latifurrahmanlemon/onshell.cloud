import { finalizeHost, inferHostType } from "./normalize.js";
import type { ImportFormat, ParseIssue, ParsedHost, ParseResult } from "./types.js";

const ENVIRONMENTS = new Set(["production", "staging", "development"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

/**
 * Finds the host array in a JSON export.
 *
 * Termius has changed its export shape across versions (top-level array, `hosts`,
 * or a nested `data.hosts`), so rather than pinning one schema we look for the
 * first array whose entries carry something address-shaped.
 */
function findHostArray(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) return payload;

  const record = asRecord(payload);
  if (!record) return undefined;

  for (const key of ["hosts", "Hosts", "servers", "connections", "items", "data"]) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
    // `data` is often a wrapper object rather than the array itself.
    const nested = asRecord(candidate);
    if (nested) {
      const inner = findHostArray(nested);
      if (inner) return inner;
    }
  }

  return undefined;
}

/** Pulls a group name from either a string or Termius's `{ label }` object. */
function readGroup(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  return asString(record.label) ?? asString(record.name) ?? asString(record.title);
}

function readTags(value: unknown): Array<string | undefined> {
  if (!Array.isArray(value)) return [asString(value)];
  return value.map((entry) => {
    if (typeof entry === "string") return entry;
    const record = asRecord(entry);
    return record ? (asString(record.label) ?? asString(record.name)) : undefined;
  });
}

/**
 * Reads an Onshell.cloud export or a Termius JSON export.
 *
 * Both go through one permissive mapper: the field names overlap heavily, and a
 * tolerant reader beats two brittle ones when the upstream shape is undocumented
 * and version-dependent.
 */
export function parseJsonHosts(text: string, format: ImportFormat): ParseResult {
  const issues: ParseIssue[] = [];
  const hosts: ParsedHost[] = [];

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { format, hosts, issues: [{ sourceRef: "file", message: "The file is not valid JSON." }] };
  }

  const entries = findHostArray(payload);
  if (!entries) {
    return {
      format,
      hosts,
      issues: [{ sourceRef: "file", message: "No host list found. Expected an array, or an object with a \"hosts\" array." }]
    };
  }

  for (let index = 0; index < entries.length; index += 1) {
    const record = asRecord(entries[index]);
    const sourceRef = `entry ${index + 1}`;

    if (!record) {
      issues.push({ sourceRef, message: "Entry is not an object." });
      continue;
    }

    // Termius nests connection details under `ssh`/`telnet`; Onshell is flat.
    const ssh = asRecord(record.ssh) ?? asRecord(record.sshConfig) ?? {};
    const rawPort = record.port ?? ssh.port;
    const port = rawPort === undefined ? undefined : Number.parseInt(String(rawPort), 10);
    const rawType = asString(record.type) ?? asString(record.protocol);
    const rawEnvironment = asString(record.environment)?.toLowerCase();

    const result = finalizeHost({
      name: asString(record.name) ?? asString(record.label) ?? asString(record.title),
      address:
        asString(record.address) ??
        asString(record.hostname) ??
        asString(record.host) ??
        asString(ssh.host) ??
        asString(record.ip),
      port: Number.isFinite(port) ? port : undefined,
      username:
        asString(record.username) ??
        asString(ssh.username) ??
        asString(asRecord(record.identity)?.username) ??
        asString(record.user),
      type: rawType ? inferHostType(rawType, Number.isFinite(port) ? port : undefined) : undefined,
      environment: rawEnvironment && ENVIRONMENTS.has(rawEnvironment) ? (rawEnvironment as never) : undefined,
      tags: readTags(record.tags ?? record.labels),
      group: readGroup(record.group ?? record.folder ?? record.parentGroup),
      notes: asString(record.notes) ?? asString(record.description),
      sourceRef
    });

    if ("error" in result) issues.push({ sourceRef, message: result.error });
    else hosts.push(result);
  }

  return { format, hosts, issues };
}
