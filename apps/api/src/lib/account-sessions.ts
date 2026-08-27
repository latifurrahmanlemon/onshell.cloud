/**
 * Turning refresh-token rows into the list of devices a person recognises.
 *
 * The table stores a *chain*, not a list of sessions: rotation replaces the row
 * on every refresh, so one browser left open for a fortnight is dozens of rows,
 * each of which — read on its own — looks like a sign-in that happened minutes
 * ago. Listing them raw is how "your signed-in devices" would end up showing the
 * same laptop twelve times and no way to tell which is which.
 *
 * `familyId` is carried across rotations and names the chain. So the rule is:
 * group by family, keep the newest row of each, and that row is what the session
 * looks like right now — its current IP, its last use, the client it last spoke
 * from. `startedAt` is carried too, so the answer to "since when" is the sign-in
 * rather than the last refresh.
 *
 * Kept free of Prisma and Fastify so the grouping can be read and tested on its
 * own — it is the part with the edge cases in it.
 */
import type { AccountSession } from "@onshell/shared";
import { describeDevice } from "./device-name.js";

/** The columns this needs, so a caller can select only these. */
export interface SessionRow {
  id: string;
  familyId: string | null;
  startedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ipAddress: string | null;
}

/**
 * The id a family-less row is listed under.
 *
 * Prefixed so it can never collide with a family id, and so the revoke route can
 * tell which of the two it was handed. These are the rows minted before families
 * existed; each is listed on its own, unnamed, because nothing was recorded about
 * it — and each can still be revoked, which is the part that matters.
 */
export function legacySessionId(rowId: string) {
  return `token:${rowId}`;
}

/** Splits `token:<id>` back apart. Returns undefined for a family id. */
export function legacyRowId(sessionId: string) {
  return sessionId.startsWith("token:") ? sessionId.slice("token:".length) : undefined;
}

/**
 * @param rows live refresh tokens for one user, newest first
 * @param activeFamilyId the family the caller is asking from, if it has one
 */
export function toAccountSessions(rows: SessionRow[], activeFamilyId?: string): AccountSession[] {
  const sessions: AccountSession[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const id = row.familyId ?? legacySessionId(row.id);
    // Newest first, so the first row of a family is the one still in use and
    // every later one is a rotation that has already been superseded.
    if (seen.has(id)) continue;
    seen.add(id);

    const device = describeDevice(row.userAgent);
    sessions.push({
      id,
      device: device.label,
      browser: device.browser,
      os: device.os,
      ipAddress: row.ipAddress ?? undefined,
      startedAt: (row.startedAt ?? row.createdAt).toISOString(),
      lastActiveAt: (row.lastUsedAt ?? row.createdAt).toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      // Never true on a family-less row: two of those could have come from the
      // same browser and there is no way to tell, so marking one "this device"
      // would be a guess — and one that hides a revoke button.
      current: Boolean(activeFamilyId) && row.familyId === activeFamilyId
    });
  }

  // Most recently used first: a session someone does not recognise is what they
  // came to look for, and that is rarely the oldest one on the list.
  sessions.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  return sessions;
}
