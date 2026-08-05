"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { type AgentBuild, formatBytes } from "../../lib/agent-downloads";

type Detected = { os: AgentBuild["os"] | null; arch: "x64" | "arm64" | null };

/**
 * What the browser will admit about the machine it is running on.
 *
 * The OS is reliable. The architecture is not: only Chromium exposes it, and
 * only asynchronously behind `getHighEntropyValues`. Safari on an M-series Mac
 * still reports `Intel Mac OS X`, so guessing from the user-agent string alone
 * would confidently hand Apple silicon users a binary whose native module
 * cannot load. Hence `arch: null` is a normal answer, and the UI is built to
 * show both options rather than pick wrong.
 */
async function detect(): Promise<Detected> {
  const ua = navigator.userAgent;
  const os: Detected["os"] = /Windows/i.test(ua)
    ? "windows"
    : /Mac OS X|Macintosh/i.test(ua)
      ? "macos"
      : /Linux|X11/i.test(ua)
        ? "linux"
        : null;

  let arch: Detected["arch"] = null;
  const data = (
    navigator as Navigator & {
      userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> };
    }
  ).userAgentData;

  if (data?.getHighEntropyValues) {
    try {
      const high = await data.getHighEntropyValues(["architecture"]);
      if (high.architecture === "arm") arch = "arm64";
      else if (high.architecture === "x86") arch = "x64";
    } catch {
      // Permission or an older Chromium. Falls through to the both-options UI.
    }
  }

  return { os, arch };
}

/** The build to lead with, given what little the browser told us. */
function pick(builds: AgentBuild[], detected: Detected) {
  const forOs = builds.filter((build) => build.os === detected.os);
  if (forOs.length === 0) return null;
  if (detected.arch) {
    const exact = forOs.find((build) => build.target.endsWith(detected.arch as string));
    if (exact) return exact;
  }
  // No architecture from the browser: lead with the one most machines run and
  // let the alternate sit visibly underneath.
  const preferred = detected.os === "macos" ? "arm64" : "x64";
  return forOs.find((build) => build.target.endsWith(preferred)) ?? forOs[0];
}

export function DownloadPicker({ builds, version }: { builds: AgentBuild[]; version: string }) {
  const [detected, setDetected] = useState<Detected | null>(null);

  useEffect(() => {
    let live = true;
    detect().then((result) => {
      if (live) setDetected(result);
    });
    return () => {
      live = false;
    };
  }, []);

  // Server render and first paint are identical: no platform is claimed until
  // the browser has actually been asked, so the card never flashes the wrong OS.
  const best = detected ? pick(builds, detected) : null;
  const alternates = best ? builds.filter((build) => build.os === best.os && build.target !== best.target) : [];

  if (!best) {
    return (
      <div className="dl-hero-card dl-hero-card-idle">
        <p className="dl-hero-idle">
          {detected === null ? "Detecting your platform…" : "Pick the build that matches your computer below."}
        </p>
      </div>
    );
  }

  return (
    <div className="dl-hero-card">
      <a className="primary-button large dl-primary" href={best.path} download>
        <Download aria-hidden="true" size={18} />
        Download for {best.osLabel}
      </a>
      <p className="dl-hero-meta">
        Version {version} · {best.archLabel} · {formatBytes(best.bytes)} · .{best.format}
      </p>
      {alternates.length > 0 && (
        <p className="dl-hero-alt">
          Different chip?{" "}
          {alternates.map((build, index) => (
            <span key={build.target}>
              {index > 0 && " · "}
              <a href={build.path} download>
                {build.archLabel}
              </a>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
