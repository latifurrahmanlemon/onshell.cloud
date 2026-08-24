import { beforeEach, describe, expect, it, vi } from "vitest";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { generate, generateSecret, verify } from "otplib";
import bcrypt from "bcryptjs";
import { loadConfig } from "@onshell/config";
import { passwordPolicy, validatePassword } from "@onshell/shared";
import { decryptSecret, encryptSecret } from "../../lib/encryption.js";
import { createRefreshToken, hashToken, signAccessToken, verifyAccessToken } from "../../lib/token.js";

/**
 * A Prisma stand-in holding just the tables the auth routes touch.
 *
 * Hoisted because `vi.mock` is: the factory below runs before the imports, so
 * everything that reads `lib/prisma.js` — the routes, `getAuthenticatedSession`,
 * `addAuthMethods` — sees this store rather than MySQL. The routes themselves
 * are real, registered on a real Fastify instance and driven through `inject`,
 * because the behaviour worth pinning down here is the HTTP contract: which
 * status code a non-member gets, and which organization comes back.
 */
const db = vi.hoisted(() => {
  interface Row {
    [key: string]: unknown;
  }
  const store = {
    users: [] as Row[],
    organizations: [] as Row[],
    memberships: [] as Row[],
    refreshTokens: [] as Row[],
    auditLogs: [] as Row[],
    authEvents: [] as Row[]
  };

  const byCreatedAt = (a: Row, b: Row) => Number(a.createdAt) - Number(b.createdAt);

  function membershipsFor(userId: unknown) {
    return store.memberships.filter((member) => member.userId === userId).sort(byCreatedAt);
  }

  function withMemberships(user: Row | undefined) {
    return user ? { ...user, memberships: membershipsFor(user.id) } : null;
  }

  const prisma = {
    /** Both array and callback forms; the fake is not transactional, only shaped like one. */
    $transaction: async (work: unknown) =>
      typeof work === "function"
        ? await (work as (tx: unknown) => Promise<unknown>)(prisma)
        : await Promise.all(work as Promise<unknown>[]),
    user: {
      findUnique: async ({ where }: { where: Row }) =>
        withMemberships(
          store.users.find((user) => (where.id ? user.id === where.id : user.email === where.email))
        ),
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const user = store.users.find((candidate) => candidate.id === where.id);
        if (!user) throw Object.assign(new Error("not found"), { code: "P2025" });
        Object.assign(user, data);
        return withMemberships(user);
      }
    },
    organization: {
      findUnique: async ({ where }: { where: Row }) =>
        store.organizations.find((organization) => organization.id === where.id) ?? null
    },
    organizationMember: {
      findUnique: async ({ where }: { where: Row }) => {
        const key = where.organizationId_userId as Row;
        const member = store.memberships.find(
          (candidate) =>
            candidate.organizationId === key.organizationId && candidate.userId === key.userId
        );
        if (!member) return null;
        return {
          ...member,
          organization: store.organizations.find((organization) => organization.id === member.organizationId)
        };
      },
      findMany: async ({ where }: { where: Row }) =>
        membershipsFor(where.userId).map((member) => ({
          ...member,
          organization: store.organizations.find((organization) => organization.id === member.organizationId)
        }))
    },
    refreshToken: {
      findFirst: async ({ where }: { where: Row }) => {
        const row = store.refreshTokens.find((candidate) => candidate.tokenHash === where.tokenHash);
        if (!row) return null;
        return { ...row, user: withMemberships(store.users.find((user) => user.id === row.userId)) };
      },
      create: async ({ data }: { data: Row }) => {
        const row = { id: `rt_${store.refreshTokens.length}`, revokedAt: null, ...data };
        store.refreshTokens.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = store.refreshTokens.find((candidate) => candidate.id === where.id);
        if (row) Object.assign(row, data);
        return row ?? null;
      }
    },
    auditLog: { create: async ({ data }: { data: Row }) => store.auditLogs.push(data) },
    authEventLog: { create: async ({ data }: { data: Row }) => store.authEvents.push(data) },
    oAuthAccount: { count: async () => 0 },
    twoFactorSecret: { findUnique: async () => null },
    // Turnstile is configured per deployment and off here, so the login route
    // does not need a bot-protection token.
    turnstileSetting: { findUnique: async () => null }
  };

  return { store, prisma };
});

vi.mock("../../lib/prisma.js", () => ({ prisma: db.prisma }));

const { registerAuthRoutes } = await import("./auth.js");

describe("TOTP two-factor flow helpers", () => {
  it("verifies a Google Authenticator compatible TOTP code after encrypted storage", async () => {
    const secret = generateSecret();
    const encrypted = encryptSecret(secret, "master-key");
    const restoredSecret = decryptSecret(encrypted, "master-key");
    const token = await generate({ secret: restoredSecret });
    const result = await verify({ secret: restoredSecret, token });

    expect(result.valid).toBe(true);
  });
});

describe("password policy", () => {
  it("requires at least 10 characters with lower, upper, digit and symbol", () => {
    expect(passwordPolicy.minLength).toBe(10);

    const result = validatePassword("Sup3r-Secret!");
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a short password with every missing requirement listed", () => {
    const result = validatePassword("abc");
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(4);
  });

  it("rejects passwords missing a single character class", () => {
    expect(validatePassword("nouppercase1!").valid).toBe(false);
    expect(validatePassword("NOLOWERCASE1!").valid).toBe(false);
    expect(validatePassword("NoDigitsHere!").valid).toBe(false);
    expect(validatePassword("NoSymbols123").valid).toBe(false);
  });
});

describe("token helpers used by refresh and OTP flows", () => {
  it("hashes tokens deterministically so stored hashes can be compared", () => {
    const otp = "042917";
    expect(hashToken(otp)).toBe(hashToken(otp));
    expect(hashToken(otp)).not.toBe(hashToken("042918"));
  });

  it("creates unique refresh tokens", () => {
    expect(createRefreshToken()).not.toBe(createRefreshToken());
  });

  it("round-trips an access token and rejects a tampered secret", () => {
    const payload = {
      sub: "user_1",
      email: "user@example.com",
      organizationId: "org_1",
      role: "owner",
      isPlatformAdmin: false
    };
    const token = signAccessToken(payload, "jwt-secret");

    const decoded = verifyAccessToken(token, "jwt-secret");
    expect(decoded?.sub).toBe("user_1");
    expect(verifyAccessToken(token, "other-secret")).toBeUndefined();
  });
});

/* ------------------------------------------------- workspace switching */

/**
 * The account this whole change exists for: somebody who had their own workspace
 * and was then invited into a colleague's.
 *
 * Their own membership is deliberately the *older* one, because that is what
 * made the original bug deterministic — `memberships[0]` resolved through the
 * userId index in primary-key order, and the key is a time-prefixed cuid, so the
 * oldest membership always won. They were pinned to their own workspace for
 * good: invited, granted a host, and unable to see it.
 */
const PASSWORD = "Sup3r-Secret!";
const config = { ...loadConfig("api"), jwtSecret: "test-jwt-secret" };

async function buildApp() {
  const app = Fastify();
  await app.register(cookie, { secret: config.jwtSecret });
  await registerAuthRoutes(app, config);
  await app.ready();
  return app;
}

type TestApp = Awaited<ReturnType<typeof buildApp>>;

function seed() {
  const { store } = db;
  for (const table of Object.values(store)) table.length = 0;

  store.organizations.push(
    { id: "org_own", name: "Ada workspace", slug: "ada-workspace", createdAt: new Date(1) },
    { id: "org_host", name: "Acme Platform", slug: "acme-platform", createdAt: new Date(2) },
    { id: "org_other", name: "Somebody Else", slug: "somebody-else", createdAt: new Date(3) }
  );
  store.users.push({
    id: "user_ada",
    email: "ada@example.com",
    name: "Ada Lovelace",
    // Cost 4 rather than the production 12: this is a fixture, not a stored hash.
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
    avatarUrl: null,
    themePreference: null,
    isPlatformAdmin: false,
    emailVerifiedAt: null,
    twoFactorEnabled: false,
    referralCode: null,
    lastActiveOrganizationId: null,
    createdAt: new Date(1)
  });
  store.memberships.push(
    { id: "mem_own", organizationId: "org_own", userId: "user_ada", role: "OWNER", createdAt: new Date(1) },
    { id: "mem_host", organizationId: "org_host", userId: "user_ada", role: "DEVELOPER", createdAt: new Date(2) }
  );
}

/** Removes a membership the way the team panel's remove-member route does. */
function removeMembership(id: string) {
  db.store.memberships.splice(
    db.store.memberships.findIndex((member) => member.id === id),
    1
  );
}

/** Signs in the way the console does, and returns the session it was handed. */
async function signIn(app: TestApp) {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: "ada@example.com", password: PASSWORD }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    user: { organizationId: string; role: string };
    accessToken: string;
    refreshToken: string;
  };
}

async function switchTo(app: TestApp, accessToken: string, organizationId: string, payload?: unknown) {
  return app.inject({
    method: "POST",
    url: `/auth/organizations/${organizationId}/switch`,
    headers: asUser(accessToken),
    ...(payload ? { payload } : {})
  });
}

function asUser(accessToken: string) {
  return { authorization: `Bearer ${accessToken}` };
}

beforeEach(seed);

describe("GET /auth/organizations", () => {
  it("lists every workspace with the role held there, not the role of the session", async () => {
    const app = await buildApp();
    const session = await signIn(app);

    const response = await app.inject({
      method: "GET",
      url: "/auth/organizations",
      headers: asUser(session.accessToken)
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.activeOrganizationId).toBe("org_own");
    expect(body.organizations).toEqual([
      expect.objectContaining({ id: "org_own", name: "Ada workspace", role: "owner", isActive: true }),
      expect.objectContaining({ id: "org_host", name: "Acme Platform", role: "developer", isActive: false })
    ]);
  });

  it("refuses an unauthenticated caller rather than describing anybody", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/auth/organizations" })).statusCode).toBe(401);
  });
});

describe("POST /auth/organizations/:organizationId/switch", () => {
  it("moves the session into a workspace the caller is a member of", async () => {
    const app = await buildApp();
    const session = await signIn(app);
    // The bug: a fresh sign-in lands in the oldest membership, which is their own
    // workspace rather than the one they were invited into.
    expect(session.user.organizationId).toBe("org_own");

    const switched = await switchTo(app, session.accessToken, "org_host");

    expect(switched.statusCode).toBe(200);
    const body = switched.json();
    expect(body.changed).toBe(true);
    expect(body.user.organizationId).toBe("org_host");
    expect(body.organization).toMatchObject({ id: "org_host", name: "Acme Platform" });

    // Every later request is scoped to it, because the re-issued access token is
    // what the console sends from here on.
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: asUser(body.accessToken) });
    expect(me.json().user.organizationId).toBe("org_host");
    expect(me.json().organization).toMatchObject({ name: "Acme Platform" });
  });

  it("reads the role from the target membership and ignores one the caller supplies", async () => {
    const app = await buildApp();
    const session = await signIn(app);
    expect(session.user.role).toBe("owner");

    // A client asking to be an owner of somebody else's workspace, and naming a
    // different organization and user while it is at it. None of it is read: the
    // membership is resolved from the authenticated id and the path.
    const switched = await switchTo(app, session.accessToken, "org_host", {
      role: "owner",
      organizationId: "org_other",
      userId: "someone_else"
    });

    expect(switched.statusCode).toBe(200);
    expect(switched.json().user.role).toBe("developer");
    expect(switched.json().user.organizationId).toBe("org_host");

    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: asUser(switched.json().accessToken)
    });
    expect(me.json().user.role).toBe("developer");
  });

  it("answers 404 for a workspace the caller is not in, identically to one that does not exist", async () => {
    const app = await buildApp();
    const session = await signIn(app);

    const foreign = await switchTo(app, session.accessToken, "org_other");
    const imaginary = await switchTo(app, session.accessToken, "org_does_not_exist");

    // 404 and not 403. A 403 for the real id next to a 404 for the invented one
    // would make this endpoint an oracle for which organization ids exist.
    expect(foreign.statusCode).toBe(404);
    expect(imaginary.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ error: "organization_not_found" });
    expect(foreign.json()).toEqual(imaginary.json());
  });

  it("treats switching to the current workspace as a no-op and mints no session", async () => {
    const app = await buildApp();
    const session = await signIn(app);
    const sessionRows = db.store.refreshTokens.length;

    const response = await switchTo(app, session.accessToken, "org_own");

    expect(response.statusCode).toBe(200);
    expect(response.json().changed).toBe(false);
    expect(response.json().accessToken).toBeUndefined();
    expect(db.store.refreshTokens).toHaveLength(sessionRows);
  });

  it("refuses an unauthenticated caller", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/auth/organizations/org_host/switch" });
    expect(response.statusCode).toBe(401);
  });

  it("records the switch in the audit log and the login log", async () => {
    const app = await buildApp();
    const session = await signIn(app);
    await switchTo(app, session.accessToken, "org_host");

    expect(db.store.auditLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "auth.organization.switch",
          organizationId: "org_host",
          actorId: "user_ada",
          metadata: { from: "org_own", role: "developer" }
        })
      ])
    );
    expect(db.store.authEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "LOGIN", method: "SESSION", reason: "organization_switch" })
      ])
    );
  });
});

describe("the active workspace over a session's lifetime", () => {
  it("survives /auth/refresh, which the clients call on any 401 and on tab focus", async () => {
    const app = await buildApp();
    const session = await signIn(app);
    const switched = (await switchTo(app, session.accessToken, "org_host")).json() as { refreshToken: string };

    const refreshed = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: switched.refreshToken }
    });

    expect(refreshed.statusCode).toBe(200);
    // Before the workspace lived on the session row this came back as org_own: a
    // background refresh silently undid the switch, with nothing on screen to
    // explain why the workspace had changed.
    expect(refreshed.json().user.organizationId).toBe("org_host");
    expect(refreshed.json().user.role).toBe("developer");
    expect(refreshed.json().activeOrganizationChanged).toBeUndefined();

    // And it keeps surviving, rotation after rotation.
    const again = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: refreshed.json().refreshToken }
    });
    expect(again.json().user.organizationId).toBe("org_host");
  });

  it("lands a fresh sign-in in the workspace the account was last reading", async () => {
    const app = await buildApp();
    const first = await signIn(app);
    await switchTo(app, first.accessToken, "org_host");

    const second = await signIn(app);
    expect(second.user.organizationId).toBe("org_host");
    expect(second.user.role).toBe("developer");
  });
});

describe("a workspace the caller has been removed from", () => {
  it("falls back to one they are still in rather than granting the revoked one", async () => {
    const app = await buildApp();
    const session = await signIn(app);
    const switched = (await switchTo(app, session.accessToken, "org_host")).json() as {
      accessToken: string;
      refreshToken: string;
    };

    // The workspace owner removes them. The access token in hand still names
    // org_host and is still signed, valid, and unexpired.
    removeMembership("mem_host");

    const me = await app.inject({ method: "GET", url: "/auth/me", headers: asUser(switched.accessToken) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.organizationId).toBe("org_own");
    expect(me.json().user.role).toBe("owner");
    // Not silent. The console can say which workspace was lost and where the
    // person ended up, instead of their host list quietly becoming another
    // workspace's.
    expect(me.json().activeOrganizationChanged).toEqual({
      reason: "membership_revoked",
      previousOrganizationId: "org_host",
      previousOrganizationName: "Acme Platform",
      organizationId: "org_own",
      organizationName: "Ada workspace"
    });

    // The refresh path reaches the same conclusion and re-anchors the session on
    // the workspace that is left.
    const refreshed = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: switched.refreshToken }
    });
    expect(refreshed.json().user.organizationId).toBe("org_own");
    expect(refreshed.json().activeOrganizationChanged).toMatchObject({ previousOrganizationId: "org_host" });

    // Switching back is refused exactly as it is for anyone who is not a member.
    expect((await switchTo(app, switched.accessToken, "org_host")).statusCode).toBe(404);
  });

  it("does not let an organization claim in a validly signed token widen what the caller sees", async () => {
    const app = await buildApp();
    // Signed with the right secret but naming a workspace this account has no
    // membership in — the shape a switch bug, or a claim lifted from elsewhere,
    // would take.
    const token = signAccessToken(
      {
        sub: "user_ada",
        email: "ada@example.com",
        organizationId: "org_other",
        role: "owner",
        isPlatformAdmin: false
      },
      config.jwtSecret
    );

    const me = await app.inject({ method: "GET", url: "/auth/me", headers: asUser(token) });

    // The claim is a request, not a fact: memberships are re-read per request and
    // the role re-derived, so the session resolves into a workspace they are in.
    expect(me.json().user.organizationId).toBe("org_own");
    expect(me.json().user.role).toBe("owner");
    expect(me.json().activeOrganizationChanged).toMatchObject({ previousOrganizationId: "org_other" });
  });
});

describe("accounts with a single workspace", () => {
  it("get one entry and no substitution to report, so the console renders no switcher", async () => {
    removeMembership("mem_host");
    const app = await buildApp();
    const session = await signIn(app);

    const me = await app.inject({ method: "GET", url: "/auth/me", headers: asUser(session.accessToken) });
    expect(me.json().organizations).toHaveLength(1);
    expect(me.json().activeOrganizationChanged).toBeUndefined();
  });
});
