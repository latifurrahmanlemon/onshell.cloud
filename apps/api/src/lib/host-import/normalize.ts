import type { Environment, HostType } from "@onshell/shared";
import type { ParsedHost } from "./types.js";

/** Default port per protocol, used when the source file omits one. */
export const DEFAULT_PORTS: Record<HostType, number> = {
  ssh: 22,
  rdp: 3389,
  vnc: 5900
};

const MAX_NAME_LENGTH = 120;
const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 40;
const MAX_NOTES_LENGTH = 2_000;

/**
 * Accepts hostnames, IPv4, and bracketed or bare IPv6.
 *
 * Deliberately permissive about internal names (`db01`, `web.internal`) because
 * that is most of what people import, but it still rejects the things that would
 * break a connection attempt: spaces, schemes, paths, and credentials-in-URL.
 */
const HOSTNAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
const IPV6_PATTERN = /^[0-9a-fA-F:]+$/;

export function isValidAddress(value: string) {
  const address = value.trim();
  if (!address || address.length > 255) return false;
  if (/[\s/\\@]/.test(address)) return false;

  // [2001:db8::1] or a bare IPv6 literal.
  const unbracketed = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  if (unbracketed.includes(":")) return IPV6_PATTERN.test(unbracketed) && unbracketed.length > 2;

  return HOSTNAME_PATTERN.test(unbracketed);
}

/**
 * Splits a trailing `:port` off an address. Skipped for IPv6 literals, where a
 * colon is part of the address rather than a separator.
 */
export function splitAddressPort(raw: string): { address: string; port?: number } {
  const value = raw.trim();

  // [2001:db8::1]:3389
  const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/.exec(value);
  if (bracketed) return { address: `[${bracketed[1]}]`, port: Number(bracketed[2]) };
  if (value.startsWith("[")) return { address: value };

  const parts = value.split(":");
  if (parts.length === 2 && /^\d{1,5}$/.test(parts[1])) {
    return { address: parts[0], port: Number(parts[1]) };
  }

  return { address: value };
}

export function parsePort(raw: unknown, fallback: number): number {
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(value) || value < 1 || value > 65535) return fallback;
  return Math.trunc(value);
}

/**
 * Guesses the environment from the host's own naming.
 *
 * Importing a thousand hosts as "production" would be actively dangerous, and
 * importing them all as "development" hides real production systems — so the
 * name and tags are used as evidence, and anything unrecognised falls back to
 * development, which the import UI lets the operator override in bulk.
 */
export function inferEnvironment(...hints: Array<string | undefined>): Environment {
  const haystack = hints.filter(Boolean).join(" ").toLowerCase();

  if (/\b(prod|production|prd|live)\b/.test(haystack) || /(^|[-_.])prod/.test(haystack)) return "production";
  if (/\b(stag|staging|stg|uat|preprod|pre-prod)\b/.test(haystack) || /(^|[-_.])stg/.test(haystack)) {
    return "staging";
  }
  return "development";
}

/** Infers the protocol from a port or an explicit protocol string. */
export function inferHostType(protocol: string | undefined, port: number | undefined): HostType {
  const value = (protocol ?? "").toLowerCase();
  if (value.includes("rdp") || value.includes("remotedesktop")) return "rdp";
  if (value.includes("vnc")) return "vnc";
  if (value.includes("ssh")) return "ssh";

  if (port === 3389) return "rdp";
  if (port === 5900 || port === 5901) return "vnc";
  return "ssh";
}

export function cleanTags(raw: Array<string | undefined> | undefined): string[] {
  if (!raw) return [];

  const seen = new Set<string>();
  for (const entry of raw) {
    for (const piece of String(entry ?? "").split(/[,;|]/)) {
      const tag = piece.trim().slice(0, MAX_TAG_LENGTH);
      if (tag) seen.add(tag);
      if (seen.size >= MAX_TAGS) break;
    }
    if (seen.size >= MAX_TAGS) break;
  }

  return [...seen];
}

/**
 * Splits `DOMAIN\user` or `user@host` into a bare username.
 *
 * RDP exports almost always carry a domain prefix, and an SSH `user@host` value
 * sometimes lands in a username column.
 */
export function cleanUsername(raw: string | undefined): string | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;

  const withoutDomain = value.includes("\\") ? value.slice(value.lastIndexOf("\\") + 1) : value;
  const withoutHost = withoutDomain.includes("@") ? withoutDomain.slice(0, withoutDomain.indexOf("@")) : withoutDomain;
  return withoutHost.trim().slice(0, 120) || undefined;
}

/**
 * Final gate before a parsed row is offered for import. Returns the normalised
 * host, or a reason string when the row is unusable.
 */
export function finalizeHost(input: {
  name?: string;
  type?: HostType;
  address?: string;
  port?: number;
  username?: string;
  environment?: Environment;
  tags?: Array<string | undefined>;
  group?: string;
  notes?: string;
  sourceRef: string;
}): ParsedHost | { error: string } {
  const rawAddress = (input.address ?? "").trim();
  if (!rawAddress) return { error: "No address in this row." };

  // A host may carry its port inside the address field (`10.0.0.1:2222`).
  const split = splitAddressPort(rawAddress);
  if (!isValidAddress(split.address)) {
    return { error: `"${split.address.slice(0, 60)}" is not a usable hostname or IP address.` };
  }

  const type = input.type ?? inferHostType(undefined, input.port ?? split.port);
  const port = parsePort(input.port ?? split.port, DEFAULT_PORTS[type]);

  // Fall back to the address so an unnamed row still imports as something the
  // operator can recognise and rename.
  const name = (input.name ?? "").trim().slice(0, MAX_NAME_LENGTH) || split.address;
  const tags = cleanTags(input.tags);

  return {
    name,
    type,
    address: split.address,
    port,
    username: cleanUsername(input.username),
    environment: input.environment ?? inferEnvironment(name, input.group, tags.join(" ")),
    tags,
    group: input.group?.trim().slice(0, 120) || undefined,
    notes: input.notes?.trim().slice(0, MAX_NOTES_LENGTH) || undefined,
    sourceRef: input.sourceRef
  };
}

/** Stable key for de-duplicating hosts that point at the same endpoint. */
export function hostKey(host: { address: string; port: number; username?: string | null }) {
  return `${host.address.toLowerCase()}|${host.port}|${(host.username ?? "").toLowerCase()}`;
}
