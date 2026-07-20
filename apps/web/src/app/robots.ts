import type { MetadataRoute } from "next";

const siteUrl = "https://onshell.cloud";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Keep private/authenticated surfaces out of search indexes.
        disallow: ["/console", "/admin", "/login", "/signup"]
      }
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl
  };
}
