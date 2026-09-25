import drafts from "../content/community/posts.json";

export const COMMUNITY_START = "2026-09-26T03:00:00.000Z";
export const communityCategories = [
  "Getting started",
  "Desktop",
  "Workflows",
  "Team access",
  "Self-hosting",
] as const;
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
  readingMinutes: number;
}
/** Runtime clock gating is shared by HTML, metadata, sitemap, image and feed routes. */
export function communitySchedule(
  start = process.env.COMMUNITY_START_AT ?? COMMUNITY_START,
): CommunityPost[] {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      start,
    ) ||
    !Number.isFinite(Date.parse(start))
  ) {
    throw new Error(
      "COMMUNITY_START_AT must be an ISO timestamp with a timezone, for example 2026-09-26T09:00:00+06:00.",
    );
  }
  return drafts.map((post, index) => ({
    ...post,
    publishedAt: new Date(Date.parse(start) + index * 86_400_000).toISOString(),
    readingMinutes: Math.max(
      1,
      Math.ceil(
        [
          post.answer,
          ...post.sections.flatMap((s) => s.paragraphs),
          ...post.checklist,
        ]
          .join(" ")
          .split(/\s+/).length / 200,
      ),
    ),
  }));
}
export function publishedPosts(
  now = Date.now(),
  start?: string,
): CommunityPost[] {
  return communitySchedule(start)
    .filter((post) => Date.parse(post.publishedAt) <= now)
    .reverse();
}
export function publishedPost(slug: string, now = Date.now(), start?: string) {
  return publishedPosts(now, start).find((post) => post.slug === slug);
}
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
