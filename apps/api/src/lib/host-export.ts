import type { Host } from "@onshell/shared";

export const exportFormats = ["json", "csv", "ssh-config"] as const;
export type ExportFormat = (typeof exportFormats)[number];

/**
 * Fields written on export.
 *
 * Deliberately no credentials: the vault exists so secrets stay server-side, and
 * an export is a file that leaves the platform. A round-tripped export therefore
 * recreates hosts but never their keys or passwords.
 */
interface ExportedHost {
  name: string;
  type: Host["type"];
  address: string;
  port: number;
  username?: string;
  environment: Host["environment"];
  tags: string[];
  group?: string;
  notes?: string;
}

function toExported(host: Host): ExportedHost {
  return {
    name: host.name,
    type: host.type,
    address: host.address,
    port: host.port,
    ...(host.username ? { username: host.username } : {}),
    environment: host.environment,
    tags: host.tags,
    ...(host.group ? { group: host.group } : {}),
    ...(host.notes ? { notes: host.notes } : {})
  };
}

/**
 * `"` and a leading `=`/`+`/`-`/`@` both need handling: the first is CSV quoting,
 * the second is spreadsheet formula injection — Excel and Sheets will execute a
 * cell starting with those characters, so a host named `=cmd|...` becomes a
 * payload the moment someone opens the export.
 */
function csvCell(value: string | number | undefined) {
  if (value === undefined) return "";

  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/["\n\r,;\t]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

const CSV_COLUMNS = [
  "name",
  "type",
  "address",
  "port",
  "username",
  "environment",
  "tags",
  "group",
  "notes"
] as const;

export function exportHosts(hosts: Host[], format: ExportFormat): { body: string; contentType: string; extension: string } {
  const rows = hosts.map(toExported);

  if (format === "json") {
    return {
      // `generator` lets detectFormat recognise our own file on re-import.
      body: `${JSON.stringify(
        {
          generator: "onshell.cloud",
          version: 1,
          exportedAt: new Date().toISOString(),
          hostCount: rows.length,
          hosts: rows
        },
        null,
        2
      )}\n`,
      contentType: "application/json; charset=utf-8",
      extension: "json"
    };
  }

  if (format === "csv") {
    const lines = [CSV_COLUMNS.join(",")];
    for (const row of rows) {
      lines.push(
        [
          csvCell(row.name),
          csvCell(row.type),
          csvCell(row.address),
          csvCell(row.port),
          csvCell(row.username),
          csvCell(row.environment),
          csvCell(row.tags.join(", ")),
          csvCell(row.group),
          csvCell(row.notes)
        ].join(",")
      );
    }
    return {
      body: `${lines.join("\r\n")}\r\n`,
      contentType: "text/csv; charset=utf-8",
      extension: "csv"
    };
  }

  // ssh-config: only SSH hosts are representable, so the rest are listed as
  // comments instead of being dropped without explanation.
  const sshHosts = rows.filter((row) => row.type === "ssh");
  const other = rows.filter((row) => row.type !== "ssh");

  const lines = [
    "# Onshell.cloud host export",
    `# Generated ${new Date().toISOString()}`,
    "# Credentials are not exported — they stay in the Onshell vault.",
    ""
  ];

  for (const row of sshHosts) {
    // Host aliases cannot contain whitespace.
    const alias = row.name.replace(/\s+/g, "-");
    if (row.notes) lines.push(`# ${row.notes.replace(/\r?\n/g, " ").slice(0, 200)}`);
    lines.push(`Host ${alias}`);
    lines.push(`  HostName ${row.address}`);
    lines.push(`  Port ${row.port}`);
    if (row.username) lines.push(`  User ${row.username}`);
    lines.push("");
  }

  if (other.length > 0) {
    lines.push(`# ${other.length} non-SSH host(s) omitted (ssh config cannot represent RDP or VNC):`);
    for (const row of other) lines.push(`#   ${row.name} — ${row.type} ${row.address}:${row.port}`);
    lines.push("");
  }

  return {
    body: lines.join("\n"),
    contentType: "text/plain; charset=utf-8",
    extension: "config"
  };
}
