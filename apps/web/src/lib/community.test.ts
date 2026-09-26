import { afterEach, expect, it, vi } from "vitest";
import {
  publishedPosts,
  publishedPost,
  safeJsonLd,
  xmlEscape,
} from "./community";
import { GET as feed } from "../app/community/feed.xml/route";
import sitemap from "../app/sitemap";
const post = {
  slug: "test-guide",
  title: "A guide",
  category: "Desktop",
  description: "SSH & SFTP",
  publishedAt: "2026-09-26T03:00:00.000Z",
  modifiedAt: "2026-09-27T03:00:00.000Z",
  readingMinutes: 2,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("fetches live content without falling back to bundled drafts", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify([post])));
  vi.stubGlobal("fetch", fetcher);
  vi.stubEnv("COMMUNITY_API_URL", "http://internal-api:4000/");
  expect(await publishedPosts()).toEqual([post]);
  expect(fetcher.mock.calls[0][0]).toBe(
    "http://internal-api:4000/public/community",
  );
  expect(fetcher.mock.calls[0][1].cache).toBe("no-store");
  fetcher.mockResolvedValue(new Response("unavailable", { status: 503 }));
  await expect(publishedPosts()).rejects.toThrow("temporarily unavailable");
});
it("treats hidden or deleted posts as missing, and encodes the slug", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response("missing", { status: 404 }));
  vi.stubGlobal("fetch", fetcher);
  expect(await publishedPost("hidden/post")).toBeUndefined();
  expect(fetcher.mock.calls[0][0]).toContain("hidden%2Fpost");
});
it("RSS and sitemap reflect API edits and deletions on the next request", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify([post]))),
  );
  expect(await (await feed()).text()).toContain("SSH &amp; SFTP");
  expect(
    (await sitemap()).find((item) => item.url.endsWith(post.slug))
      ?.lastModified,
  ).toBe(post.modifiedAt);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]")),
  );
  expect(await (await feed()).text()).not.toContain("<item>");
  expect((await sitemap()).some((item) => item.url.endsWith(post.slug))).toBe(
    false,
  );
});
it("escapes JSON-LD and XML", () => {
  expect(xmlEscape('<script>&"')).toBe("&lt;script&gt;&amp;&quot;");
  expect(safeJsonLd({ text: "</script>" })).not.toContain("</script>");
});
