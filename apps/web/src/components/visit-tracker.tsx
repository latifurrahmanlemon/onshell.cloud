"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { apiBaseUrl } from "../lib/site";

const VISITOR_KEY = "onshell-analytics-visitor";
const SESSION_KEY = "onshell-analytics-session";
const SESSION_ACTIVITY_KEY = "onshell-analytics-last-activity";
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const ENGAGED_AFTER_MS = 10_000;

function randomId() {
  return crypto.randomUUID();
}

function storedId(storage: Storage, key: string) {
  const existing = storage.getItem(key);
  if (existing) return existing;
  const id = randomId();
  storage.setItem(key, id);
  return id;
}

function sessionId() {
  const now = Date.now();
  const last = Number(sessionStorage.getItem(SESSION_ACTIVITY_KEY) ?? 0);
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id || now - last > SESSION_TIMEOUT_MS) {
    id = randomId();
    sessionStorage.setItem(SESSION_KEY, id);
  }
  sessionStorage.setItem(SESSION_ACTIVITY_KEY, String(now));
  return id;
}

function campaign() {
  const params = new URLSearchParams(window.location.search);
  const read = (name: string) => params.get(name)?.slice(0, 190) || undefined;
  const value = {
    source: read("utm_source"),
    medium: read("utm_medium"),
    campaign: read("utm_campaign"),
    content: read("utm_content"),
    term: read("utm_term")
  };
  return Object.values(value).some(Boolean) ? value : undefined;
}

/**
 * First-party analytics for every application route. It records navigation and
 * active time only: query strings, form values and page contents never leave
 * the browser.
 */
export function VisitTracker() {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname || pathname.startsWith("/api")) return;

    let visitorId: string;
    let currentSessionId: string;
    try {
      visitorId = storedId(localStorage, VISITOR_KEY);
      currentSessionId = sessionId();
    } catch {
      visitorId = randomId();
      currentSessionId = randomId();
    }

    const id = randomId();
    const startedAt = performance.now();
    let visibleStartedAt = document.visibilityState === "visible" ? startedAt : null;
    let visibleMs = 0;
    let lastReportedMs = -1;

    const reportEngagement = () => {
      const now = performance.now();
      const durationMs = Math.max(0, Math.round(visibleMs + (visibleStartedAt === null ? 0 : now - visibleStartedAt)));
      if (durationMs === lastReportedMs) return;
      lastReportedMs = durationMs;
      try {
        sessionStorage.setItem(SESSION_ACTIVITY_KEY, String(Date.now()));
      } catch {
        // Ephemeral sessions still report; storage is only an enhancement.
      }
      void fetch(`${apiBaseUrl}/public/visit/engagement`, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, durationMs, engaged: durationMs >= ENGAGED_AFTER_MS }),
        keepalive: true
      }).catch(() => undefined);
    };

    void fetch(`${apiBaseUrl}/public/visit`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id,
        path: pathname,
        visitorId,
        sessionId: currentSessionId,
        title: document.title,
        referrer: document.referrer || undefined,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        utm: campaign()
      }),
      keepalive: true
    }).catch(() => undefined);

    const onVisibility = () => {
      const now = performance.now();
      if (document.visibilityState === "hidden") {
        if (visibleStartedAt !== null) visibleMs += now - visibleStartedAt;
        visibleStartedAt = null;
        reportEngagement();
      } else if (visibleStartedAt === null) {
        visibleStartedAt = now;
      }
    };
    const heartbeat = window.setInterval(reportEngagement, 15_000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", reportEngagement);

    return () => {
      window.clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", reportEngagement);
      reportEngagement();
    };
  }, [pathname]);

  return null;
}
