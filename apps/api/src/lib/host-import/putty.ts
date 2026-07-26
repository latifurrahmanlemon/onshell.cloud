import { finalizeHost, inferHostType } from "./normalize.js";
import type { ParseIssue, ParsedHost, ParseResult } from "./types.js";

const SESSION_KEY_PATTERN = /^\[HKEY_[^\]]*\\Software\\SimonTatham\\PuTTY\\Sessions\\([^\]]+)\]$/i;

/**
 * PuTTY stores sessions in the Windows registry, so the portable form is a
 * `.reg` export produced by `regedit /e` or `putty -pack`.
 *
 * Session names are percent-encoded in the key path (`My%20Server`), string
 * values are quoted, and numbers are `dword:` in hex.
 */
export function parsePuttyReg(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const hosts: ParsedHost[] = [];
  const issues: ParseIssue[] = [];

  let sessionName: string | undefined;
  let sessionLine = 0;
  let values: Record<string, string> = {};

  const flush = () => {
    if (!sessionName) return;

    const sourceRef = `session "${sessionName}"`;
    const protocol = values.protocol;

    // Serial sessions have no network address at all.
    if (protocol && protocol.toLowerCase() === "serial") {
      issues.push({ sourceRef, message: "Skipped serial session (no network address)." });
      sessionName = undefined;
      values = {};
      return;
    }

    const port = values.portnumber ? Number.parseInt(values.portnumber, 10) : undefined;
    const result = finalizeHost({
      name: sessionName,
      address: values.hostname,
      port: Number.isFinite(port) ? port : undefined,
      username: values.username,
      type: inferHostType(protocol, Number.isFinite(port) ? port : undefined),
      sourceRef
    });

    if ("error" in result) issues.push({ sourceRef, message: result.error });
    else hosts.push(result);

    sessionName = undefined;
    values = {};
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith(";")) continue;

    if (line.startsWith("[")) {
      // A new key ends the previous session, whether or not it is a session key.
      flush();
      const match = SESSION_KEY_PATTERN.exec(line);
      if (match) {
        sessionName = decodePuttyName(match[1]);
        sessionLine = index + 1;
        values = {};
      }
      continue;
    }

    if (!sessionName) continue;

    const match = /^"([^"]+)"=(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1].toLowerCase();
    const raw = match[2].trim();

    if (raw.startsWith('"')) {
      // Quoted string; registry exports escape backslashes.
      values[key] = raw.slice(1, raw.endsWith('"') ? -1 : undefined).replace(/\\\\/g, "\\");
    } else if (raw.toLowerCase().startsWith("dword:")) {
      const parsed = Number.parseInt(raw.slice(6), 16);
      if (Number.isFinite(parsed)) values[key] = String(parsed);
    }
  }

  flush();
  void sessionLine;

  return { format: "putty-reg", hosts, issues };
}

/** PuTTY percent-encodes characters that are not valid in a registry key name. */
function decodePuttyName(raw: string) {
  return raw.replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}
