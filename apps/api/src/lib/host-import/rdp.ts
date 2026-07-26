import { DEFAULT_PORTS, finalizeHost } from "./normalize.js";
import type { ParseIssue, ParsedHost, ParseResult } from "./types.js";

/**
 * Reads one or more Windows Remote Desktop `.rdp` files.
 *
 * The format is `setting:type:value` per line, where type is `s` (string),
 * `i` (integer), or `b` (binary). A `.rdp` file carries no name of its own — the
 * filename is the label in Explorer — so `defaultName` is used when the client
 * knows it, and the address is the fallback.
 *
 * Several concatenated files are supported: a `full address` line starts a new
 * host, which is what happens when someone pastes a handful of `.rdp` files
 * together rather than uploading them one at a time.
 */
export function parseRdp(text: string, defaultName?: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const hosts: ParsedHost[] = [];
  const issues: ParseIssue[] = [];

  let values: Record<string, string> = {};
  let startLine = 1;

  const flush = () => {
    const address = values["full address"] ?? values["alternate full address"];
    if (!address) {
      values = {};
      return;
    }

    const sourceRef = defaultName ? `${defaultName} (line ${startLine})` : `line ${startLine}`;
    const explicitPort = values["server port"] ? Number.parseInt(values["server port"], 10) : undefined;

    const result = finalizeHost({
      // `full address` usually embeds the port, which finalizeHost splits off.
      name: defaultName ?? values["alternate shell"] ?? undefined,
      address,
      port: Number.isFinite(explicitPort) ? explicitPort : undefined,
      username: values.username,
      type: "rdp",
      // Domain is worth keeping — it is needed at connect time but is not part of
      // the host record, so it goes in notes rather than being silently dropped.
      notes: values.domain ? `RDP domain: ${values.domain}` : undefined,
      sourceRef
    });

    if ("error" in result) issues.push({ sourceRef, message: result.error });
    else hosts.push({ ...result, port: result.port || DEFAULT_PORTS.rdp });

    values = {};
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const match = /^([^:]+):([sib]):(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1].trim().toLowerCase();
    const value = match[3].trim();

    // A second address means a new file was concatenated onto the first.
    if ((key === "full address" || key === "alternate full address") && values["full address"]) {
      flush();
      startLine = index + 1;
    }
    if (Object.keys(values).length === 0) startLine = index + 1;

    if (value) values[key] = value;
  }

  flush();

  if (hosts.length === 0 && issues.length === 0) {
    issues.push({ sourceRef: "file", message: 'No "full address" line found — this does not look like a .rdp file.' });
  }

  return { format: "rdp", hosts, issues };
}

/* ------------------------------------------------------------------ RDCMan */

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
}

/**
 * Minimal tag/text walker for RDCMan `.rdg` files.
 *
 * A dependency-free XML pass rather than a regex: `.rdg` nests groups
 * arbitrarily deep, and the same `<name>` element means "group name" or "server
 * address" purely by position, which regex cannot track.
 */
function* walkXml(text: string): Generator<Tag | { text: string }> {
  let index = 0;

  while (index < text.length) {
    const open = text.indexOf("<", index);
    if (open === -1) break;

    if (open > index) {
      const content = text.slice(index, open).trim();
      if (content) yield { text: content };
    }

    // Skip comments, declarations, and CDATA wholesale.
    if (text.startsWith("<!--", open)) {
      const end = text.indexOf("-->", open);
      index = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<?", open) || text.startsWith("<!", open)) {
      const end = text.indexOf(">", open);
      index = end === -1 ? text.length : end + 1;
      continue;
    }

    const close = text.indexOf(">", open);
    if (close === -1) break;

    const inner = text.slice(open + 1, close).trim();
    const closing = inner.startsWith("/");
    const selfClosing = inner.endsWith("/");
    const name = inner.replace(/^\//, "").replace(/\/$/, "").split(/\s/)[0].toLowerCase();

    yield { name, closing, selfClosing };
    index = close + 1;
  }
}

function decodeXmlText(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

/**
 * Reads a Remote Desktop Connection Manager `.rdg` file.
 *
 * Structure: `<group><properties><name>Group</name></properties>
 * <server><properties><name>host</name><displayName>Label</displayName>…`.
 * Group nesting becomes the host's group (innermost wins), which is how RDCMan
 * users actually organise estates.
 */
export function parseRdcman(text: string): ParseResult {
  const hosts: ParsedHost[] = [];
  const issues: ParseIssue[] = [];

  const groupStack: string[] = [];
  // Tracks which element's text we are currently collecting.
  const path: string[] = [];

  let server: { name?: string; displayName?: string; username?: string; port?: string } | undefined;
  let groupNamePending = false;
  let index = 0;

  for (const token of walkXml(text)) {
    if ("text" in token) {
      const value = decodeXmlText(token.text);
      const element = path[path.length - 1];

      if (server) {
        if (element === "name") server.name ??= value;
        else if (element === "displayname") server.displayName ??= value;
        else if (element === "username") server.username ??= value;
        else if (element === "port") server.port ??= value;
      } else if (groupNamePending && element === "name") {
        groupStack.push(value);
        groupNamePending = false;
      }
      continue;
    }

    if (token.selfClosing) continue;

    if (!token.closing) {
      path.push(token.name);
      if (token.name === "server") {
        server = {};
        index += 1;
      } else if (token.name === "properties" && !server) {
        // The next <name> inside a group's <properties> is the group's own name.
        groupNamePending = path.includes("group");
      }
      continue;
    }

    // Closing tag.
    path.pop();

    if (token.name === "server" && server) {
      const sourceRef = `server ${index} (${server.displayName ?? server.name ?? "unnamed"})`;
      const port = server.port ? Number.parseInt(server.port, 10) : undefined;

      const result = finalizeHost({
        name: server.displayName ?? server.name,
        address: server.name,
        port: Number.isFinite(port) ? port : undefined,
        username: server.username,
        type: "rdp",
        group: groupStack[groupStack.length - 1],
        sourceRef
      });

      if ("error" in result) issues.push({ sourceRef, message: result.error });
      else hosts.push(result);

      server = undefined;
      continue;
    }

    if (token.name === "group") {
      groupStack.pop();
      groupNamePending = false;
    }
  }

  if (hosts.length === 0 && issues.length === 0) {
    issues.push({ sourceRef: "file", message: "No <server> entries found in this .rdg file." });
  }

  return { format: "rdcman", hosts, issues };
}
