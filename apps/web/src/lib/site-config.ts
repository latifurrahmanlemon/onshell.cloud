"use client";

import { useEffect, useState } from "react";
import { apiBaseUrl } from "./site";

/**
 * Runtime configuration fetched from the API rather than baked into the bundle,
 * so a platform admin can rotate the Turnstile site key or switch the AI
 * assistant on without a rebuild and redeploy.
 */
export interface SiteConfig {
  site: { name: string; domain: string; url: string; supportEmail: string };
  turnstile: {
    enabled: boolean;
    siteKey: string | null;
    forms: {
      signup: boolean;
      login: boolean;
      passwordReset: boolean;
      contact: boolean;
      checkout: boolean;
      newsletter: boolean;
    };
  };
  ai: { enabled: boolean };
}

export type TurnstileFormKey = keyof SiteConfig["turnstile"]["forms"];

const FALLBACK: SiteConfig = {
  site: {
    name: "Onshell.cloud",
    domain: "onshell.cloud",
    url: "https://onshell.cloud",
    supportEmail: "support@onshell.cloud"
  },
  turnstile: {
    enabled: false,
    siteKey: null,
    forms: {
      signup: false,
      login: false,
      passwordReset: false,
      contact: false,
      checkout: false,
      newsletter: false
    }
  },
  ai: { enabled: false }
};

/**
 * Shared across every consumer on the page so N forms do not each issue their
 * own request. Reset only on a full reload, which is the right cadence for
 * settings an admin changes rarely.
 */
let cached: SiteConfig | undefined;
let inFlight: Promise<SiteConfig> | undefined;

export async function loadSiteConfig(): Promise<SiteConfig> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = fetch(`${apiBaseUrl}/public/site-config`, {
    credentials: "omit",
    // The response decides whether a Turnstile widget is rendered; a stale copy
    // means no challenge on screen while the API requires one.
    cache: "no-store"
  })
    .then((response) => {
      if (!response.ok) throw new Error(`site_config_${response.status}`);
      return response.json();
    })
    .then((payload: SiteConfig) => {
      cached = payload;
      return payload;
    })
    .catch(() => {
      // API unreachable: fall back to "no challenge configured" so the form is
      // still usable, but do NOT cache the failure. The server may well be
      // requiring a challenge, in which case the submit is rejected and the form
      // calls invalidateSiteConfig() to try again — which only works if a retry
      // is actually possible.
      return FALLBACK;
    })
    .finally(() => {
      inFlight = undefined;
    });

  return inFlight;
}

/**
 * Drops the cached config so the next read re-fetches.
 *
 * Called when the API rejects a submit for a challenge the browser never showed:
 * that means this client is working from a stale or failed config, and the only
 * way out is to ask again.
 */
export function invalidateSiteConfig() {
  cached = undefined;
  inFlight = undefined;
}

/** Reads the site config, returning `undefined` until the first load resolves. */
export function useSiteConfig() {
  const [config, setConfig] = useState<SiteConfig | undefined>(cached);

  useEffect(() => {
    if (config) return;
    let active = true;
    void loadSiteConfig().then((loaded) => {
      if (active) setConfig(loaded);
    });
    return () => {
      active = false;
    };
  }, [config]);

  return config;
}
