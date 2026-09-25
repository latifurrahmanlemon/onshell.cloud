import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMUNITY_START,
  communityCategories,
  communitySchedule,
  publishedPost,
  publishedPosts,
  safeJsonLd,
  xmlEscape,
} from "./community";
import { GET as feed } from "../app/community/feed.xml/route";
import sitemap from "../app/sitemap";
const start = Date.parse(COMMUNITY_START);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("community publishing", () => {
  it("has twenty complete, uniquely addressed English guides", () => {
    const posts = communitySchedule(COMMUNITY_START);
    expect(posts).toHaveLength(20);
    expect(new Set(posts.map((p) => p.slug)).size).toBe(20);
    for (const p of posts) {
      expect(p.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(communityCategories).toContain(p.category);
      expect(p.sections.length).toBeGreaterThanOrEqual(3);
      expect(
        p.sections
          .flatMap((s) => s.paragraphs)
          .join(" ")
          .split(/\s+/).length,
      ).toBeGreaterThan(150);
      expect(p.checklist).toHaveLength(3);
      expect(p.description.length).toBeLessThanOrEqual(180);
      expect(p.productLink).toMatch(
        /^\/(desktop|browser-ssh-client|console|security|contact)$/,
      );
    }
  });
  it("publishes exactly one per day, including each exact boundary", () => {
    expect(publishedPosts(start - 1, COMMUNITY_START)).toEqual([]);
    for (let day = 0; day < 20; day++) {
      expect(
        publishedPosts(start + day * 86400000, COMMUNITY_START),
      ).toHaveLength(day + 1);
      expect(
        publishedPosts(start + (day + 1) * 86400000 - 1, COMMUNITY_START),
      ).toHaveLength(day + 1);
    }
    expect(publishedPosts(start + 30 * 86400000, COMMUNITY_START)).toHaveLength(
      20,
    );
  });
  it("never resolves a future or unknown slug", () => {
    const schedule = communitySchedule(COMMUNITY_START);
    expect(
      publishedPost(schedule[1].slug, start, COMMUNITY_START),
    ).toBeUndefined();
    expect(publishedPost("unknown", start, COMMUNITY_START)).toBeUndefined();
    expect(publishedPost(schedule[0].slug, start, COMMUNITY_START)?.slug).toBe(
      schedule[0].slug,
    );
  });
  it("accepts equivalent timezones and rejects ambiguous settings", () => {
    expect(communitySchedule("2026-09-26T09:00:00+06:00")).toEqual(
      communitySchedule(COMMUNITY_START),
    );
    expect(() => communitySchedule("2026-09-26T09:00:00")).toThrow("timezone");
    expect(() => communitySchedule("not-a-date")).toThrow();
  });
  it("updates RSS and sitemap with the runtime clock without a rebuild", async () => {
    vi.stubEnv("COMMUNITY_START_AT", COMMUNITY_START);
    vi.useFakeTimers();
    vi.setSystemTime(start - 1);
    expect(await feed().text()).not.toContain("<item>");
    expect(sitemap().filter((p) => p.url.includes("/community/"))).toHaveLength(
      0,
    );
    vi.setSystemTime(start);
    const xml = await feed().text();
    expect(xml.match(/<item>/g)).toHaveLength(1);
    expect(xml).toContain(communitySchedule()[0].slug);
    expect(xml).not.toContain(communitySchedule()[1].slug);
    const articles = sitemap().filter((p) => p.url.includes("/community/"));
    expect(articles).toHaveLength(1);
    expect(articles[0].lastModified).toBe(COMMUNITY_START);
    expect(feed().headers.get("cache-control")).toBe("no-store");
    vi.setSystemTime(start + 86400000);
    expect((await feed().text()).match(/<item>/g)).toHaveLength(2);
  });
  it("escapes structured data and feed values safely", () => {
    const text = '<script>&"test"';
    expect(xmlEscape(text)).toBe("&lt;script&gt;&amp;&quot;test&quot;");
    expect(safeJsonLd({ text })).not.toContain("<script>");
    expect(JSON.parse(safeJsonLd({ text })).text).toBe(text);
  });
});
