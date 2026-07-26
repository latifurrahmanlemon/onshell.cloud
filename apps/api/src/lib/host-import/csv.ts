import { finalizeHost, inferHostType } from "./normalize.js";
import type { ParseIssue, ParsedHost, ParseResult } from "./types.js";

/**
 * RFC 4180 reader: handles quoted fields, embedded commas and newlines, and
 * doubled quotes. Written by hand because the alternative is a dependency for
 * ~50 lines, and export files from Termius and Excel both need the quoting rules
 * honoured (a hostname column is fine, but a notes column with a comma is not).
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;

  // Strip a UTF-8 BOM, which Excel writes and which would otherwise corrupt the
  // first header name.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // Skip rows that are entirely empty (trailing newlines, blank separators).
    if (row.some((value) => value.trim() !== "")) rows.push(row);
    row = [];
  };

  while (index < input.length) {
    const char = input[index];

    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === "") {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === "," || char === ";" || char === "\t") {
      endField();
      index += 1;
      continue;
    }
    if (char === "\r") {
      index += 1;
      continue;
    }
    if (char === "\n") {
      endRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * Header aliases, most specific first.
 *
 * Different tools name the same column differently — Termius uses `Label` and
 * `Hostname`, mRemoteNG uses `Name` and `Hostname`, a hand-written sheet might
 * use `Server` and `IP`. Matching on a normalised form of the header keeps all of
 * them working without asking the user to remap columns by hand.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  name: ["label", "name", "displayname", "title", "alias", "server", "hostalias", "connectionname"],
  address: ["address", "hostname", "host", "ip", "ipaddress", "fulladdress", "endpoint", "server"],
  port: ["port", "portnumber", "sshport"],
  username: ["username", "user", "login", "loginname", "account"],
  type: ["type", "protocol", "connectiontype"],
  environment: ["environment", "env", "stage"],
  tags: ["tags", "tag", "labels", "keywords"],
  group: ["group", "folder", "groupname", "parentgroup", "category"],
  notes: ["notes", "note", "description", "comment", "comments"]
};

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Maps each logical field to a column index, or -1 when absent. */
export function mapColumns(header: string[]): Record<string, number> {
  const normalized = header.map(normalizeHeader);
  const mapping: Record<string, number> = {};

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    mapping[field] = -1;
    for (const alias of aliases) {
      const exact = normalized.indexOf(alias);
      if (exact !== -1) {
        mapping[field] = exact;
        break;
      }
    }
  }

  // `server` is an alias for both name and address. When it matched both, treat
  // it as the address and leave the name to be derived from it.
  if (mapping.name !== -1 && mapping.name === mapping.address) mapping.name = -1;

  return mapping;
}

const ENVIRONMENTS = new Set(["production", "staging", "development"]);

export function parseCsvHosts(text: string): ParseResult {
  const rows = parseCsv(text);
  const issues: ParseIssue[] = [];
  const hosts: ParsedHost[] = [];

  if (rows.length === 0) {
    return { format: "csv", hosts, issues: [{ sourceRef: "file", message: "The file is empty." }] };
  }

  const mapping = mapColumns(rows[0]);
  if (mapping.address === -1) {
    return {
      format: "csv",
      hosts,
      issues: [
        {
          sourceRef: "header",
          message:
            "No address column found. Expected a header named one of: address, hostname, host, ip, or full address."
        }
      ]
    };
  }

  const pick = (row: string[], field: string) => {
    const index = mapping[field];
    if (index === -1 || index >= row.length) return undefined;
    const value = row[index]?.trim();
    return value || undefined;
  };

  // Row 1 is the header, so data starts at index 1 and human-facing row numbers
  // line up with what the operator sees in a spreadsheet.
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const sourceRef = `row ${index + 1}`;

    const rawType = pick(row, "type");
    const rawPort = pick(row, "port");
    const port = rawPort ? Number.parseInt(rawPort, 10) : undefined;
    const rawEnvironment = pick(row, "environment")?.toLowerCase();

    const result = finalizeHost({
      name: pick(row, "name"),
      address: pick(row, "address"),
      port: Number.isFinite(port) ? port : undefined,
      username: pick(row, "username"),
      type: rawType ? inferHostType(rawType, port) : undefined,
      environment: rawEnvironment && ENVIRONMENTS.has(rawEnvironment) ? (rawEnvironment as never) : undefined,
      tags: [pick(row, "tags")],
      group: pick(row, "group"),
      notes: pick(row, "notes"),
      sourceRef
    });

    if ("error" in result) issues.push({ sourceRef, message: result.error });
    else hosts.push(result);
  }

  return { format: "csv", hosts, issues };
}
