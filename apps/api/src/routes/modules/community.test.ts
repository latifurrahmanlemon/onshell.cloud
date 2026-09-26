import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@onshell/config";
const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("../../lib/prisma.js", () => {
  const tx = { communityPost: db, auditLog: { create: db.audit } };
  return {
    prisma: {
      ...tx,
      $transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
    },
  };
});
vi.mock("../../lib/current-user.js", () => ({
  getAuthenticatedUser: async (request: { headers: Record<string, string> }) =>
    request.headers["x-role"]
      ? {
          id: "actor",
          organizationId: "org",
          role: "admin",
          isPlatformAdmin: request.headers["x-role"] === "platform",
        }
      : null,
}));
import {
  registerCommunityRoutes,
  communityPostSchema,
  publishedWhere,
} from "./community.js";
const body = {
  slug: "test-guide",
  title: "Test guide",
  category: "Desktop",
  description: "A useful guide",
  answer: "Direct answer",
  sections: [{ heading: "Start here", paragraphs: ["Useful instructions."] }],
  checklist: ["Verify"],
  productLink: "/desktop",
  authorName: "Onshell",
  seoTitle: "",
  seoDescription: "",
  coverImage: null,
  coverAlt: "",
  status: "PUBLISHED",
  publishedAt: "2026-09-26T03:00:00Z",
};
let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  vi.resetAllMocks();
  app = Fastify();
  await registerCommunityRoutes(app, {} as RuntimeConfig);
});
afterEach(async () => {
  await app.close();
  vi.useRealTimers();
});
it("protects every admin route, including private previews", async () => {
  for (const [method, url, payload] of [
    ["GET", "/admin/community", undefined],
    ["GET", "/admin/community/id", undefined],
    ["POST", "/admin/community", body],
    ["PATCH", "/admin/community/id", { ...body, version: 1 }],
    ["DELETE", "/admin/community/id", { version: 1 }],
  ] as const) {
    for (const role of [undefined, "member"]) {
      const res = await app.inject({
        method,
        url,
        payload,
        headers: role ? { "x-role": role } : {},
      });
      expect(res.statusCode).toBe(role ? 403 : 401);
    }
  }
  expect(db.create).not.toHaveBeenCalled();
  expect(db.findMany).not.toHaveBeenCalled();
});
it("gates public list and detail at the exact publication instant", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(body.publishedAt));
  db.findMany.mockResolvedValue([]);
  db.findFirst.mockResolvedValue(null);
  expect((await app.inject("/public/community")).json()).toEqual([]);
  expect(db.findMany.mock.calls[0][0].where).toEqual(
    publishedWhere(new Date(body.publishedAt)),
  );
  expect((await app.inject("/public/community/test-guide")).statusCode).toBe(
    404,
  );
  expect(db.findFirst.mock.calls[0][0].where).toEqual({
    slug: "test-guide",
    ...publishedWhere(new Date(body.publishedAt)),
  });
  expect((await app.inject("/public/community")).headers["cache-control"]).toBe(
    "no-store",
  );
});
it("creates and audits posts, preserving explicit UTC schedule", async () => {
  db.create.mockResolvedValue({ id: "created", ...body });
  const response = await app.inject({
    method: "POST",
    url: "/admin/community",
    headers: { "x-role": "platform" },
    payload: body,
  });
  expect(response.statusCode).toBe(201);
  expect(db.create.mock.calls[0][0].data.publishedAt).toEqual(
    new Date(body.publishedAt),
  );
  expect(db.audit).toHaveBeenCalled();
});
it("validates publication, internal links and raster covers", () => {
  expect(
    communityPostSchema.safeParse({ ...body, publishedAt: null }).success,
  ).toBe(false);
  expect(
    communityPostSchema.safeParse({
      ...body,
      status: "DRAFT",
      publishedAt: null,
      sections: [],
      answer: "",
      description: "",
    }).success,
  ).toBe(true);
  expect(
    communityPostSchema.safeParse({ ...body, productLink: "//evil.test" })
      .success,
  ).toBe(false);
  expect(
    communityPostSchema.safeParse({
      ...body,
      coverImage: "data:image/svg+xml;base64,PHN2Zz4=",
    }).success,
  ).toBe(false);
});
it("rejects stale edits without mutating or auditing", async () => {
  db.updateMany.mockResolvedValue({ count: 0 });
  const res = await app.inject({
    method: "PATCH",
    url: "/admin/community/id",
    headers: { "x-role": "platform" },
    payload: { ...body, version: 2 },
  });
  expect(res.statusCode).toBe(409);
  expect(db.updateMany.mock.calls[0][0].where).toEqual({
    id: "id",
    version: 2,
  });
  expect(db.audit).not.toHaveBeenCalled();
});
it("updates content with a new version and allows unpublishing", async () => {
  db.updateMany.mockResolvedValue({ count: 1 });
  db.findUnique.mockResolvedValue({
    id: "id",
    ...body,
    status: "DRAFT",
    version: 3,
  });
  const res = await app.inject({
    method: "PATCH",
    url: "/admin/community/id",
    headers: { "x-role": "platform" },
    payload: { ...body, status: "DRAFT", version: 2 },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().status).toBe("DRAFT");
  expect(db.updateMany.mock.calls[0][0].data.version).toEqual({ increment: 1 });
  expect(db.audit).toHaveBeenCalled();
});
it("deletes only the expected version and records the deletion", async () => {
  db.deleteMany.mockResolvedValue({ count: 1 });
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: "/admin/community/id",
        headers: { "x-role": "platform" },
        payload: { version: 3 },
      })
    ).statusCode,
  ).toBe(200);
  expect(db.deleteMany.mock.calls[0][0].where).toEqual({
    id: "id",
    version: 3,
  });
  expect(db.audit).toHaveBeenCalled();
});
it("reports duplicate slugs clearly", async () => {
  db.create.mockRejectedValue({ code: "P2002" });
  const res = await app.inject({
    method: "POST",
    url: "/admin/community",
    headers: { "x-role": "platform" },
    payload: body,
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().message).toContain("unique slug");
});

it("imports all twenty original guides once with stable daily dates", () => {
  const sql = readFileSync(new URL("../../../prisma/migrations/20260926090000_community_cms/migration.sql", import.meta.url), "utf8");
  const source = JSON.parse(readFileSync(new URL("../../../../../docs/community-starter-posts.json", import.meta.url), "utf8"));
  const inserts = sql.split("\n").filter(line => line.startsWith("INSERT INTO"));
  expect(inserts).toHaveLength(20);
  for (let i = 0; i < inserts.length; i++) {
    const values = [...inserts[i].matchAll(/CONVERT\(0x([a-f0-9]+) USING utf8mb4\)|''/g)].map(match => match[1] ? Buffer.from(match[1], "hex").toString("utf8") : "");
    expect(values[1]).toBe(source[i].slug);
    expect(values[2]).toBe(source[i].title);
    expect(JSON.parse(values[6])).toEqual(source[i].sections);
    expect(JSON.parse(values[7])).toEqual(source[i].checklist);
    expect(values[10]).toBe("PUBLISHED");
    expect(new Date(values[11].replace(" ", "T") + "Z").getTime()).toBe(Date.parse("2026-09-26T03:00:00Z") + i * 86400000);
  }
});
