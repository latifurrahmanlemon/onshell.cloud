/**
 * "Sign in with browser" — the state machine behind the desktop app's
 * device-authorisation flow.
 *
 * The problem it solves: the desktop app can only ask for a password, and a
 * growing share of accounts have no password at all (Google sign-in), while the
 * ones that do may sit behind Turnstile — a challenge no native window can
 * render. Handing the sign-in to the user's real browser makes every one of
 * those work for free, because the browser is where they already work.
 *
 * The whole security question is: who is allowed to collect the session this
 * produces? Three things answer it, and none of them is optional.
 *
 *  1. **A device secret**, generated here and returned to the app exactly once.
 *     Only the process holding it can poll for the tokens. Stored as a hash, so
 *     reading this map is not enough to intercept a sign-in.
 *  2. **A user code**, which the person must read off the app window and type
 *     into the browser. This is the defence against the classic attack on this
 *     shape of flow: an attacker starts a request on their own machine and
 *     phishes a link at somebody who is already signed in. It is deliberately
 *     *not* carried in the URL the app opens. A pre-filled code turns approval
 *     into a single click on a page that looks entirely legitimate, which is
 *     exactly the attack; typing it makes the browser prove it is sitting next
 *     to the app that started the request, and there is no way to obtain the
 *     code from the server — `preview` never returns it.
 *  3. **A signed-in browser session**, which is what decides *whose* account is
 *     being handed over. Approval is an authenticated action by a real user.
 *
 * Both codes are compared in constant time, both are attempt-capped, the whole
 * thing expires in five minutes, and collecting the session consumes the
 * request — a second poll gets "expired", not a second copy of the tokens.
 *
 * State lives in `store.ts` rather than a Prisma model on purpose: a request is
 * meaningful for five minutes and worthless afterwards, so surviving an API
 * restart buys nothing. The app's poll fails, the person clicks the button
 * again, and the alternative would be a table of half-finished sign-ins to age
 * out by hand.
 */
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { store, type DesktopAuthRequest } from "./store.js";
import { hashToken } from "./token.js";

/** Must match `DESKTOP_AUTH_REQUEST_TTL_MS` in store.ts. */
export const DESKTOP_AUTH_TTL_SECONDS = 5 * 60;

/**
 * How often the app should ask. Sent to the client rather than hard-coded there
 * so this can be raised without shipping a new installer.
 */
export const DESKTOP_AUTH_POLL_INTERVAL_SECONDS = 2;

/** Wrong user codes tolerated before the request is destroyed. */
const MAX_CODE_ATTEMPTS = 5;

/**
 * Polls served before the request is destroyed. Generous next to
 * TTL/interval — a slow link retries — but finite, so a wedged client cannot
 * turn one request into an unbounded stream of lookups.
 */
const MAX_POLLS = 300;

/**
 * The user-code alphabet: no I, O, 0, or 1.
 *
 * The person is transcribing this between two windows, and a code that cannot
 * be read wrong is worth more than four extra bits. Eight characters out of
 * thirty-two is forty bits, against a five-attempt cap and a five-minute life.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export interface CreateDesktopAuthRequestInput {
  machineName: string;
  platform: string;
  appVersion?: string;
  ipAddress?: string;
}

export interface CreatedDesktopAuthRequest {
  requestId: string;
  /** Returned once and never stored in plaintext. */
  deviceSecret: string;
  /** Displayed by the app so the person can type it into the browser. */
  userCode: string;
  expiresAt: string;
  pollIntervalSeconds: number;
}

export type PollResult =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "approved"; userId: string }
  | { status: "invalid_device_secret" };

export type ApproveResult =
  | { status: "approved"; request: DesktopAuthRequest }
  | { status: "expired" }
  | { status: "already_resolved"; resolution: "approved" | "denied" }
  | { status: "invalid_user_code" };

export type DenyResult =
  | { status: "denied"; request: DesktopAuthRequest }
  | { status: "expired" }
  | { status: "already_resolved"; resolution: "approved" | "denied" };

/**
 * Constant-time comparison of two hex digests.
 *
 * `!==` on a secret leaks how many leading bytes were right, which over enough
 * requests is a working oracle. Same reasoning as `signatureMatches` in
 * token.ts; the length guard is there because `timingSafeEqual` throws on
 * mismatched buffers.
 */
function digestsMatch(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function generateUserCode() {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    // randomInt, not Math.random: this is a credential, however short.
    code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * What the person typed, reduced to what was actually generated.
 *
 * Case and the grouping dash are presentation, and refusing a correct code
 * because it was pasted without the hyphen would be a bug the user cannot see
 * the cause of. Anything else is left alone so a genuine mistyping still fails.
 */
export function normalizeUserCode(input: string) {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isExpired(request: DesktopAuthRequest) {
  return new Date(request.expiresAt).getTime() <= Date.now();
}

/**
 * Reads a live request, dropping it if its own deadline has passed.
 *
 * The expiry is checked against the record rather than left to the map, because
 * every mutation below re-`set`s the entry and that restarts the map's TTL. The
 * five minutes has to be five minutes from creation, not five minutes from the
 * last poll, or a client that keeps asking keeps the window open indefinitely.
 */
function live(requestId: string): DesktopAuthRequest | undefined {
  const request = store.pendingDesktopAuthRequests.get(requestId);
  if (!request) return undefined;
  if (isExpired(request)) {
    store.pendingDesktopAuthRequests.delete(requestId);
    return undefined;
  }
  return request;
}

/** What the approval page is allowed to see. Never the code, never a token. */
export function previewDesktopAuthRequest(requestId: string) {
  const request = live(requestId);
  if (!request) return undefined;
  return {
    status: request.status,
    machineName: request.machineName,
    platform: request.platform,
    appVersion: request.appVersion,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt
  };
}

export function createDesktopAuthRequest(
  input: CreateDesktopAuthRequestInput
): CreatedDesktopAuthRequest {
  // 32 random bytes, like the device-enrolment secret next door. The request id
  // is separate from the secret so the id can safely travel in a URL the user
  // pastes, is logged by a proxy, or appears in a browser history.
  const requestId = `dar_${randomBytes(16).toString("base64url")}`;
  const deviceSecret = randomBytes(32).toString("base64url");
  const userCode = generateUserCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DESKTOP_AUTH_TTL_SECONDS * 1000);

  store.pendingDesktopAuthRequests.set(requestId, {
    deviceSecretHash: hashToken(deviceSecret),
    userCodeHash: hashToken(normalizeUserCode(userCode)),
    machineName: input.machineName,
    platform: input.platform,
    appVersion: input.appVersion,
    requestedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ipAddress: input.ipAddress,
    codeAttempts: 0,
    polls: 0,
    status: "pending"
  });

  return {
    requestId,
    deviceSecret,
    userCode,
    expiresAt: expiresAt.toISOString(),
    pollIntervalSeconds: DESKTOP_AUTH_POLL_INTERVAL_SECONDS
  };
}

/**
 * The app asking whether the browser has answered yet.
 *
 * Returning `approved` consumes the request. That is the one-shot rule, and it
 * costs something honest: a poll response lost on the wire means the person
 * starts over rather than a second party being able to collect the same
 * session. Leaving the record behind so a retry could pick the tokens up again
 * would mean an approved request stays collectable for as long as it lives,
 * which is precisely what the device secret exists to prevent.
 */
export function pollDesktopAuthRequest(requestId: string, presentedSecret: string): PollResult {
  const request = live(requestId);
  if (!request) return { status: "expired" };

  if (!digestsMatch(request.deviceSecretHash, hashToken(presentedSecret))) {
    // Not counted against the poll cap and does not destroy the request: the
    // caller has proved nothing about this request, so it must not be able to
    // cancel a sign-in it does not hold the secret for.
    return { status: "invalid_device_secret" };
  }

  request.polls += 1;
  if (request.polls > MAX_POLLS) {
    store.pendingDesktopAuthRequests.delete(requestId);
    return { status: "expired" };
  }

  if (request.status === "denied") {
    store.pendingDesktopAuthRequests.delete(requestId);
    return { status: "denied" };
  }

  if (request.status === "approved" && request.approvedUserId) {
    store.pendingDesktopAuthRequests.delete(requestId);
    return { status: "approved", userId: request.approvedUserId };
  }

  store.pendingDesktopAuthRequests.set(requestId, request);
  return { status: "pending" };
}

/**
 * A signed-in browser agreeing to hand this account to that machine.
 *
 * The user code is the whole check here; `userId` comes from the caller's own
 * authenticated session, so approval can only ever grant the approver's own
 * account. A wrong code is counted, and running out of attempts destroys the
 * request rather than locking it — a request nobody can finish is of no use to
 * whoever was guessing.
 */
export function approveDesktopAuthRequest(
  requestId: string,
  presentedCode: string,
  userId: string
): ApproveResult {
  const request = live(requestId);
  if (!request) return { status: "expired" };
  if (request.status !== "pending") {
    return { status: "already_resolved", resolution: request.status };
  }

  if (!digestsMatch(request.userCodeHash, hashToken(normalizeUserCode(presentedCode)))) {
    request.codeAttempts += 1;
    if (request.codeAttempts >= MAX_CODE_ATTEMPTS) {
      store.pendingDesktopAuthRequests.delete(requestId);
      return { status: "expired" };
    }
    store.pendingDesktopAuthRequests.set(requestId, request);
    return { status: "invalid_user_code" };
  }

  request.status = "approved";
  request.approvedUserId = userId;
  store.pendingDesktopAuthRequests.set(requestId, request);
  return { status: "approved", request };
}

/**
 * Refusing. No user code required, deliberately: refusing is always the safe
 * direction, and someone who has been handed a request id and does not
 * recognise the machine should be able to kill it in one click rather than
 * hunting for a code they never had.
 */
export function denyDesktopAuthRequest(requestId: string): DenyResult {
  const request = live(requestId);
  if (!request) return { status: "expired" };
  if (request.status !== "pending") {
    return { status: "already_resolved", resolution: request.status };
  }

  request.status = "denied";
  store.pendingDesktopAuthRequests.set(requestId, request);
  return { status: "denied", request };
}
