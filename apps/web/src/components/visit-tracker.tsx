"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { apiBaseUrl } from "../lib/site";

/** The signed-in app is covered by the audit log; only public pages are tracked. */
const UNTRACKED_PREFIXES = ["/console", "/admin"];

/**
 * Suppresses a repeat beacon for the same path within this window. Guards
 * against React's development double-effect and against a remount of the shell
 * counting one page view twice, without hiding a genuine later re-visit.
 */
const DEDUPE_WINDOW_MS = 2_000;

let lastPath: string | null = null;
let lastSentAt = 0;

/**
 * Fire-and-forget page-view beacon for the public site.
 *
 * The server derives IP, user agent, and country from the request, so the client
 * only supplies what it alone knows: the path and the referrer.
 */
export function VisitTracker() {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname) return;
    if (UNTRACKED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return;

    const now = Date.now();
    if (pathname === lastPath && now - lastSentAt < DEDUPE_WINDOW_MS) return;
    lastPath = pathname;
    lastSentAt = now;

    void fetch(`${apiBaseUrl}/public/visit`, {
      method: "POST",
      // Sends the session cookie so a signed-in visitor is attributed.
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: pathname,
        ...(document.referrer ? { referrer: document.referrer } : {})
      }),
      // Survives a navigation that unmounts this component mid-flight.
      keepalive: true
    }).catch(() => {
      // Analytics must never surface an error to a visitor.
    });
  }, [pathname]);

  return null;
}
