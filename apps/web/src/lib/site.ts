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
  domain: new URL(siteUrl).hostname,
  url: siteUrl,
  /** Primary positioning statement — reused in metadata, JSON-LD, and llms.txt. */
  tagline: "The best browser-based SSH client for teams",
  supportEmail: "support@onshell.cloud",
  salesEmail: "sales@onshell.cloud",
  securityEmail: "security@onshell.cloud",
  foundedYear: 2026
} as const;

export function absoluteUrl(path = "/") {
  return `${siteUrl}${path.startsWith("/") ? path : `/${path}`}`;
}
