import { cache } from "react";
import { apiBaseUrl } from "./site";

export interface CommunityPost {
  slug: string;
  title: string;
  category: string;
  description: string;
  answer: string;
  sections: { heading: string; paragraphs: string[] }[];
  checklist: string[];
  productLink: string;
  publishedAt: string;
  modifiedAt: string;
  readingMinutes: number;
  authorName: string;
  seoTitle: string;
  seoDescription: string;
  coverImage: string | null;
  coverAlt: string;
}
// Server calls may use an internal API origin; public browser requests still use apiBaseUrl.
async function readCommunity<T>(path: string): Promise<T | undefined> {
  const origin = (process.env.COMMUNITY_API_URL || apiBaseUrl).replace(
    /\/+$/,
    "",
  );
  const response = await fetch(`${origin}/public/community${path}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404 && path) return undefined;
  if (!response.ok)
    throw new Error("Community content is temporarily unavailable.");
  return response.json() as Promise<T>;
}
export async function publishedPosts(): Promise<CommunityPost[]> {
  return (await readCommunity<CommunityPost[]>(""))!;
}
// Deduplicate metadata and page reads only within the current server render.
export const publishedPost = cache(async (slug: string) =>
  readCommunity<CommunityPost>(`/${encodeURIComponent(slug)}`),
);
export function articleDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    timeZone: "Asia/Dhaka",
  }).format(new Date(value));
}
export function safeJsonLd(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
export function xmlEscape(value: string) {
  return value.replace(
    /[<>&'\"]/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        "'": "&apos;",
        '"': "&quot;",
      })[c]!,
  );
}
