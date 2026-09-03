/**
 * Single source of truth for the public domain and API origin.
 *
 * Everything SEO-facing (canonicals, sitemap, JSON-LD, OG URLs) reads from here
 * so switching domains is one env change rather than a grep across the app.
 */

function trimSlashes(value: string) {
  return value.replace(/\/+$/, "");
}

export const siteUrl = trimSlashes(process.env.NEXT_PUBLIC_SITE_URL ?? "https://onshell.cloud");

export const apiBaseUrl = trimSlashes(process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000");

export const gatewayBaseUrl = trimSlashes(
  process.env.NEXT_PUBLIC_GATEWAY_BASE_URL ?? "http://localhost:4100"
);

export const site = {
  name: "Onshell.cloud",
  shortName: "Onshell",
  legalName: "Holy LLC",
  domain: new URL(siteUrl).hostname,
  url: siteUrl,
  /** Primary positioning statement — reused in metadata, JSON-LD, and llms.txt. */
  tagline: "The best browser-based SSH client for teams",
  supportEmail: "support@onshell.cloud",
  salesEmail: "sales@onshell.cloud",
  securityEmail: "security@onshell.cloud",
  foundedYear: 2026,
  /**
   * The public source. Onshell is AGPL-3.0 and the whole platform is published —
   * vault, session broker, gateway, agent, desktop app — so this link is part of
   * the product's argument rather than a footer courtesy: a tool people hand
   * their server credentials to should be one they can read.
   */
  repoUrl: "https://github.com/latifurrahmanlemon/onshell.cloud",
  licenseName: "AGPL-3.0",
  licenseUrl: "https://github.com/latifurrahmanlemon/onshell.cloud/blob/master/LICENSE"
} as const;

export function absoluteUrl(path = "/") {
  return `${siteUrl}${path.startsWith("/") ? path : `/${path}`}`;
}
