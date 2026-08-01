import type { DialableHostType, Environment } from "@onshell/shared";

/** Source formats the importer can read. */
export const importFormats = [
  "onshell-json",
  "termius-json",
  "csv",
  "ssh-config",
  "putty-reg",
  "rdp",
  "rdcman"
] as const;

export type ImportFormat = (typeof importFormats)[number];

export const importFormatLabels: Record<ImportFormat, string> = {
  "onshell-json": "Onshell.cloud JSON",
  "termius-json": "Termius JSON",
  csv: "CSV / Termius CSV",
  "ssh-config": "OpenSSH config",
  "putty-reg": "PuTTY registry export",
  rdp: "Windows Remote Desktop (.rdp)",
  rdcman: "Remote Desktop Connection Manager (.rdg)"
};

/**
 * One host as read from a source file, before it is checked against the
 * organization's existing hosts or plan limits.
 */
export interface ParsedHost {
  name: string;
  type: DialableHostType;
  address: string;
  port: number;
  username?: string;
  environment: Environment;
  tags: string[];
  group?: string;
  notes?: string;
  /**
   * Where this came from in the source (line number, row number, session name),
   * so a rejected row can be pointed at precisely.
   */
  sourceRef: string;
}

/** A row that could not be turned into a host, with the reason. */
export interface ParseIssue {
  sourceRef: string;
  message: string;
}

export interface ParseResult {
  format: ImportFormat;
  hosts: ParsedHost[];
  /** Rows that were skipped, and why. Never contains secret material. */
  issues: ParseIssue[];
}

export class UnknownFormatError extends Error {
  constructor() {
    super("Could not recognise this file format.");
    this.name = "UnknownFormatError";
  }
}
