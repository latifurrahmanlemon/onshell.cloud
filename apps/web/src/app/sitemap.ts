import type { MetadataRoute } from "next";

const siteUrl = "https://onshell.cloud";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    {
      url: siteUrl,
      lastModified,
      changeFrequency: "weekly",
      priority: 1
    }
  ];
}
