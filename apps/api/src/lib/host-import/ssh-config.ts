import { finalizeHost } from "./normalize.js";
import type { ParseIssue, ParsedHost, ParseResult } from "./types.js";

interface Block {
  patterns: string[];
  line: number;
  values: Record<string, string>;
}

/**
 * Reads an OpenSSH client config (`~/.ssh/config`).
 *
 * Only the directives that map onto a host record are used — HostName, Port,
 * User — plus `#` comments for the notes field. Everything else (IdentityFile,
 * ProxyJump, forwarding options) is intentionally ignored: they describe *how* to
 * connect from a workstation, which is the gateway's job here, not the host's.
 */
export function parseSshConfig(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const blocks: Block[] = [];
  const issues: ParseIssue[] = [];
  let current: Block | undefined;
  let pendingComment: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trim();

    if (!line) continue;
    if (line.startsWith("#")) {
      // Remember the comment directly above a Host line as its description.
      pendingComment = line.replace(/^#+\s*/, "").slice(0, 200);
      continue;
    }

    // Directives are `Keyword value` or `Keyword=value`, case-insensitive.
    const match = /^([A-Za-z0-9_-]+)\s*[=\s]\s*(.+)$/.exec(line);
    if (!match) continue;

    const keyword = match[1].toLowerCase();
    const value = match[2].trim();

    if (keyword === "host") {
      current = {
        // A single Host line can declare several aliases.
        patterns: value.split(/\s+/).filter(Boolean),
        line: index + 1,
        values: pendingComment ? { __comment: pendingComment } : {}
      };
      blocks.push(current);
      pendingComment = undefined;
      continue;
    }

    // A directive before any Host line belongs to the implicit global block,
    // which has no host of its own.
    if (!current) continue;
    if (!(keyword in current.values)) current.values[keyword] = value;
  }

  const hosts: ParsedHost[] = [];

  for (const block of blocks) {
    for (const pattern of block.patterns) {
      const sourceRef = `line ${block.line} (Host ${pattern})`;

      // Wildcard entries configure other hosts rather than describing one.
      if (pattern.includes("*") || pattern.includes("?") || pattern === "!") {
        issues.push({ sourceRef, message: `Skipped wildcard pattern "${pattern}".` });
        continue;
      }

      // Without HostName, the alias itself is the address — standard ssh behaviour.
      const address = block.values.hostname ?? pattern;
      const port = block.values.port ? Number.parseInt(block.values.port, 10) : undefined;

      const result = finalizeHost({
        name: pattern,
        address,
        port: Number.isFinite(port) ? port : undefined,
        username: block.values.user,
        type: "ssh",
        notes: block.values.__comment,
        sourceRef
      });

      if ("error" in result) issues.push({ sourceRef, message: result.error });
      else hosts.push(result);
    }
  }

  return { format: "ssh-config", hosts, issues };
}
