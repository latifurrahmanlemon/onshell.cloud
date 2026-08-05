import type { MetadataRoute } from "next";
import { absoluteUrl, siteUrl } from "../lib/site";

/**
 * Public, indexable routes only. Authenticated surfaces are excluded here and
 * in robots.ts, so the two never disagree about what should be crawled.
 */
const routes: Array<{
  path: string;
  priority: number;
  changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
}> = [
  { path: "/", priority: 1, changeFrequency: "weekly" },
  { path: "/browser-ssh-client", priority: 0.9, changeFrequency: "monthly" },
  { path: "/download", priority: 0.8, changeFrequency: "weekly" },
  { path: "/security", priority: 0.7, changeFrequency: "monthly" },
  { path: "/contact", priority: 0.6, changeFrequency: "yearly" }
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return routes.map((route) => ({
    url: route.path === "/" ? siteUrl : absoluteUrl(route.path),
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority
  }));
}
