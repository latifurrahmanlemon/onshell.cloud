/**
 * Telling the user a newer version exists.
 *
 * Deliberately *not* an auto-updater. An updater downloads code and runs it as
 * you, which is only acceptable when the payload's signature can be checked —
 * and these builds are not signed yet. Shipping the download half of an updater
 * before the verification half is how a release channel becomes an attack
 * channel, so this checks, says so, and hands the user to the release page to
 * decide for themselves.
 *
 * When code-signing certificates are in place this is the module that grows an
 * electron-updater feed. Until then it does the honest, smaller thing.
 */
import { app } from "electron";

/** Where releases are published. Overridable for a fork or a self-hosted build. */
const RELEASES_API =
  process.env.ONSHELL_RELEASES_API ??
  "https://api.github.com/repos/latifurrahmanlemon/onshell-downloads/releases/latest";

export interface UpdateStatus {
  current: string;
  latest?: string;
  /** True only when `latest` is genuinely newer than what is running. */
  available: boolean;
  /** Where to get it. Opened in the user's real browser, never in-app. */
  url?: string;
  checkedAt: string;
}

/** Semver-ish compare, tolerant of a `desktop-v` prefix and missing segments. */
function isNewer(latest: string, current: string) {
  const parse = (value: string) =>
    value
      .replace(/^desktop-v/, "")
      .replace(/^v/, "")
      .split(/[.-]/)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));

  const a = parse(latest);
  const b = parse(current);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

let lastCheck: UpdateStatus | undefined;

/**
 * Asks once and caches. A failed check is not an error the user needs to see —
 * being offline is the ordinary state of a laptop — so it answers "no update
 * known" rather than raising.
 */
export async function checkForUpdate(force = false): Promise<UpdateStatus> {
  const current = app.getVersion();
  if (lastCheck && !force) return lastCheck;

  const status: UpdateStatus = { current, available: false, checkedAt: new Date().toISOString() };

  try {
    const response = await fetch(RELEASES_API, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000)
    });
    if (response.ok) {
      const release = (await response.json()) as { tag_name?: string; html_url?: string };
      if (release.tag_name) {
        status.latest = release.tag_name.replace(/^desktop-v/, "");
        status.available = isNewer(release.tag_name, current);
        status.url = release.html_url;
      }
    }
  } catch {
    // Offline, rate-limited, or the repository moved. None of those are worth
    // interrupting someone's terminal over.
  }

  lastCheck = status;
  return status;
}
