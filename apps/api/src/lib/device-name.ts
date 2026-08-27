/**
 * Naming the machine behind a session, from its `User-Agent`.
 *
 * This exists for one screen — "your signed-in devices" — and the bar it has to
 * clear is *recognition*: someone scanning the list has to be able to say "that
 * one is my laptop, and that one is not mine". A raw UA string does not clear
 * it, and neither would a full-fidelity parser; "Chrome on Windows" does.
 *
 * So this is deliberately shallow. It reads the handful of families that make up
 * essentially all real traffic, in the order where the impersonation is one-way
 * (every Chromium browser also claims to be Chrome and Safari, so Edge and Opera
 * have to be tested first), and it says "Unknown device" rather than guessing
 * when nothing matches. A wrong name here is worse than no name: it could talk
 * someone out of revoking a session that really was not theirs.
 *
 * Kept free of Prisma and Fastify so it can be read and tested on its own.
 */

export interface DeviceDescription {
  /** What to show, e.g. "Chrome on Windows". Never empty. */
  label: string;
  browser?: string;
  os?: string;
}

const UNKNOWN: DeviceDescription = { label: "Unknown device" };

/**
 * Order matters. Chromium forks carry "Chrome" and "Safari" in their own UA, and
 * Chrome carries "Safari", so the most specific claim has to be tested first or
 * every Edge session in the list is labelled Chrome.
 */
const BROWSERS: Array<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//i, "Edge"],
  [/\bOPR\/|\bOpera\//i, "Opera"],
  [/\bVivaldi\//i, "Vivaldi"],
  [/\bBrave\//i, "Brave"],
  [/\bSamsungBrowser\//i, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//i, "Firefox"],
  [/\bCriOS\//i, "Chrome"],
  [/\bChrome\//i, "Chrome"],
  [/\bSafari\//i, "Safari"]
];

const OPERATING_SYSTEMS: Array<[RegExp, string]> = [
  // Before the generic Windows test: Windows 11 and Windows 10 send the same
  // "Windows NT 10.0", so claiming a version would be a coin toss.
  [/Windows NT/i, "Windows"],
  [/\bAndroid\b/i, "Android"],
  [/\b(?:iPhone|iPod)\b/i, "iPhone"],
  [/\biPad\b/i, "iPad"],
  [/\bMac OS X\b|\bMacintosh\b/i, "macOS"],
  [/\bCrOS\b/i, "ChromeOS"],
  [/\bUbuntu\b/i, "Ubuntu"],
  [/\bLinux\b/i, "Linux"]
];

function matchFirst(userAgent: string, table: Array<[RegExp, string]>) {
  for (const [pattern, name] of table) {
    if (pattern.test(userAgent)) return name;
  }
  return undefined;
}

/**
 * The desktop app is not a browser and must not be labelled as one — it sends
 * its own product token, and "Onshell Desktop on macOS" is the honest answer.
 */
const DESKTOP_APP = /\bOnshell(?:-|\s)?Desktop\/|\bElectron\//i;

export function describeDevice(userAgent: string | null | undefined): DeviceDescription {
  const value = userAgent?.trim();
  if (!value) return UNKNOWN;

  const os = matchFirst(value, OPERATING_SYSTEMS);
  const browser = DESKTOP_APP.test(value) ? "Onshell Desktop" : matchFirst(value, BROWSERS);

  if (browser && os) return { label: `${browser} on ${os}`, browser, os };
  if (browser) return { label: browser, browser };
  if (os) return { label: os, os };
  return UNKNOWN;
}
