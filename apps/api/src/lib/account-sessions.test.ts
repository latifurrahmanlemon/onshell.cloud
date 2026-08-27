import { describe, expect, it } from "vitest";
import { legacyRowId, legacySessionId, toAccountSessions, type SessionRow } from "./account-sessions.js";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

function row(overrides: Partial<SessionRow> & Pick<SessionRow, "id">): SessionRow {
  return {
    familyId: null,
    startedAt: null,
    lastUsedAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    userAgent: null,
    ipAddress: null,
    ...overrides
  };
}

describe("toAccountSessions", () => {
  it("collapses a chain of rotations into the one session it really is", () => {
    // What a browser open for a few days actually looks like in the table: one
    // family, several rows, newest first.
    const rows = [
      row({
        id: "t3",
        familyId: "fam-a",
        startedAt: new Date("2026-08-20T09:00:00.000Z"),
        lastUsedAt: new Date("2026-08-27T08:00:00.000Z"),
        createdAt: new Date("2026-08-27T08:00:00.000Z"),
        userAgent: CHROME,
        ipAddress: "203.0.113.9"
      }),
      row({ id: "t2", familyId: "fam-a", createdAt: new Date("2026-08-25T08:00:00.000Z"), userAgent: CHROME }),
      row({ id: "t1", familyId: "fam-a", createdAt: new Date("2026-08-20T09:00:00.000Z"), userAgent: CHROME })
    ];

    const sessions = toAccountSessions(rows);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("fam-a");
    expect(sessions[0].device).toBe("Chrome on Windows");
    // From the newest row: where the session is now, not where it began.
    expect(sessions[0].ipAddress).toBe("203.0.113.9");
    // Carried across rotations, so "signed in" is the sign-in and not the last
    // refresh — which is the whole reason `startedAt` exists.
    expect(sessions[0].startedAt).toBe("2026-08-20T09:00:00.000Z");
    expect(sessions[0].lastActiveAt).toBe("2026-08-27T08:00:00.000Z");
  });

  it("keeps separate sign-ins separate, newest use first", () => {
    const sessions = toAccountSessions([
      row({
        id: "t2",
        familyId: "fam-b",
        lastUsedAt: new Date("2026-08-26T10:00:00.000Z"),
        createdAt: new Date("2026-08-26T10:00:00.000Z"),
        userAgent: SAFARI
      }),
      row({
        id: "t1",
        familyId: "fam-a",
        lastUsedAt: new Date("2026-08-27T10:00:00.000Z"),
        createdAt: new Date("2026-08-20T10:00:00.000Z"),
        userAgent: CHROME
      })
    ]);

    expect(sessions.map((session) => session.id)).toEqual(["fam-a", "fam-b"]);
    expect(sessions.map((session) => session.device)).toEqual(["Chrome on Windows", "Safari on macOS"]);
  });

  it("marks only the caller's own family as current", () => {
    const sessions = toAccountSessions(
      [row({ id: "t1", familyId: "fam-a" }), row({ id: "t2", familyId: "fam-b" })],
      "fam-b"
    );

    expect(sessions.find((session) => session.id === "fam-b")?.current).toBe(true);
    expect(sessions.find((session) => session.id === "fam-a")?.current).toBe(false);
  });

  it("lists pre-family rows one apiece, unnamed, and never as the current device", () => {
    // Two rows with no family could be the same browser or two different ones —
    // there is no way to tell. Merging them would hide a session; calling either
    // one "this device" would hide its revoke button.
    const sessions = toAccountSessions([row({ id: "old-1" }), row({ id: "old-2" })], "fam-a");

    expect(sessions.map((session) => session.id)).toEqual([legacySessionId("old-1"), legacySessionId("old-2")]);
    expect(sessions.every((session) => session.device === "Unknown device")).toBe(true);
    expect(sessions.every((session) => session.current === false)).toBe(true);
  });

  it("falls back to createdAt when a row predates the timestamp columns", () => {
    const sessions = toAccountSessions([row({ id: "old-1", createdAt: new Date("2026-07-04T12:00:00.000Z") })]);

    expect(sessions[0].startedAt).toBe("2026-07-04T12:00:00.000Z");
    expect(sessions[0].lastActiveAt).toBe("2026-07-04T12:00:00.000Z");
  });

  it("round-trips a legacy id, and leaves a family id alone", () => {
    expect(legacyRowId(legacySessionId("row-9"))).toBe("row-9");
    expect(legacyRowId("fam-a")).toBeUndefined();
  });
});
