import { parseCsvHosts } from "./csv.js";
import { parseJsonHosts } from "./json-sources.js";
import { parsePuttyReg } from "./putty.js";
import { parseRdcman, parseRdp } from "./rdp.js";
import { parseSshConfig } from "./ssh-config.js";
import { importFormats, UnknownFormatError, type ImportFormat, type ParseResult } from "./types.js";

export * from "./types.js";
export { hostKey } from "./normalize.js";

/** Hard ceiling on rows accepted from one file, to bound memory and insert time. */
export const MAX_IMPORT_HOSTS = 5_000;

/**
 * Identifies the source format from the file's own content.
 *
 * Extensions lie — people rename `.txt`, paste into a box, and download `.rdp`
 * files as `.rdp.txt` — so detection is by signature, with the filename used only
 * to break the CSV-vs-SSH-config tie at the end.
 */
export function detectFormat(text: string, filename?: string): ImportFormat | undefined {
  const sample = text.slice(0, 8_000);
  const trimmed = sample.trimStart();

  // Registry exports are checked before JSON: a `.reg` fragment pasted without
  // its `Windows Registry Editor` header starts with `[HKEY_…`, which the
  // JSON-array test below would otherwise claim.
  if (/\\Software\\SimonTatham\\PuTTY\\Sessions\\/i.test(sample)) return "putty-reg";

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    // Our own export is self-identifying; anything else JSON is read as Termius.
    return /"generator"\s*:\s*"onshell/i.test(sample) ? "onshell-json" : "termius-json";
  }

  if (/<\s*RDCMan\b/i.test(sample) || /<\s*server\s*>[\s\S]*<\s*properties\s*>/i.test(sample)) return "rdcman";
  if (/^\s*(full address|alternate full address)\s*:\s*s\s*:/im.test(sample)) return "rdp";
  // Any `key:s:value` / `key:i:value` line is an RDP setting.
  if (/^\s*[a-z ]+:[sib]:/im.test(sample) && /:[sib]:/.test(sample)) return "rdp";

  // `Host x` followed by an indented directive is unambiguous ssh config.
  if (/^\s*Host\s+\S+/im.test(sample) && /^\s*(HostName|Port|User|IdentityFile|ProxyJump)\b/im.test(sample)) {
    return "ssh-config";
  }

  const firstLine = sample.split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith("#"));
  if (firstLine && /[,;\t]/.test(firstLine)) return "csv";

  if (/^\s*Host\s+\S+/im.test(sample)) return "ssh-config";

  const extension = filename?.toLowerCase().split(".").pop();
  if (extension === "csv" || extension === "tsv") return "csv";
  if (extension === "rdp") return "rdp";
  if (extension === "rdg") return "rdcman";
  if (extension === "reg") return "putty-reg";
  if (extension === "config" || extension === "conf") return "ssh-config";

  return undefined;
}

export function isImportFormat(value: string): value is ImportFormat {
  return (importFormats as readonly string[]).includes(value);
}

/**
 * Parses a source file into candidate hosts.
 *
 * `format` may be supplied to override detection — useful when a file is
 * ambiguous, or when the operator knows better than the sniffer.
 */
export function parseHostSource(input: {
  text: string;
  filename?: string;
  format?: ImportFormat;
}): ParseResult {
  const format = input.format ?? detectFormat(input.text, input.filename);
  if (!format) throw new UnknownFormatError();

  // Strip the extension so a `.rdp` file's name becomes the host label.
  const baseName = input.filename?.replace(/\.[^.]+$/, "").trim() || undefined;

  const result = ((): ParseResult => {
    switch (format) {
      case "onshell-json":
      case "termius-json":
        return parseJsonHosts(input.text, format);
      case "csv":
        return parseCsvHosts(input.text);
      case "ssh-config":
        return parseSshConfig(input.text);
      case "putty-reg":
        return parsePuttyReg(input.text);
      case "rdp":
        return parseRdp(input.text, baseName);
      case "rdcman":
        return parseRdcman(input.text);
    }
  })();

  if (result.hosts.length <= MAX_IMPORT_HOSTS) return result;

  // Truncate rather than reject: importing the first 5,000 of a huge file and
  // saying so is more useful than refusing the whole thing.
  return {
    ...result,
    hosts: result.hosts.slice(0, MAX_IMPORT_HOSTS),
    issues: [
      ...result.issues,
      {
        sourceRef: "file",
        message: `File contains ${result.hosts.length} hosts; only the first ${MAX_IMPORT_HOSTS} were read. Split the file and import the rest separately.`
      }
    ]
  };
}
