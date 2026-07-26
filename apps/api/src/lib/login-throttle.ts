/**
 * Per-account failed-login throttling.
 *
 * The global IP rate limit does not stop a distributed password-spray against
 * one account, and it also lets a single noisy IP exhaust the budget for
 * everyone behind the same NAT. This tracks failures per (email, IP) pair and
 * applies an escalating lock, so guessing one account's password gets slower
 * without locking a legitimate user out from their own network.
 */

const WINDOW_MS = 15 * 60 * 1000;
const ATTEMPTS_BEFORE_LOCK = 5;
const BASE_LOCK_MS = 60 * 1000;
const MAX_LOCK_MS = 15 * 60 * 1000;
const MAX_TRACKED = 20_000;

interface Attempt {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

const attempts = new Map<string, Attempt>();

function key(email: string, ip: string) {
  return `${email.toLowerCase()}|${ip}`;
}

function sweep(now: number) {
  for (const [entryKey, entry] of attempts) {
    const stale = now - entry.firstFailureAt > WINDOW_MS && entry.lockedUntil <= now;
    if (stale) attempts.delete(entryKey);
  }

  while (attempts.size > MAX_TRACKED) {
    const oldest = attempts.keys().next();
    if (oldest.done) break;
    attempts.delete(oldest.value);
  }
}

/**
 * Returns the remaining lock in seconds, or 0 when the caller may proceed.
 * Call before verifying the password.
 */
export function getLoginLock(email: string, ip: string): number {
  const now = Date.now();
  sweep(now);

  const entry = attempts.get(key(email, ip));
  if (!entry || entry.lockedUntil <= now) return 0;
  return Math.ceil((entry.lockedUntil - now) / 1000);
}

/** Records a failed attempt and returns the lock it triggered, in seconds. */
export function recordLoginFailure(email: string, ip: string): number {
  const now = Date.now();
  const entryKey = key(email, ip);
  const existing = attempts.get(entryKey);

  // A gap longer than the window starts a fresh count.
  const entry: Attempt =
    existing && now - existing.firstFailureAt <= WINDOW_MS
      ? existing
      : { failures: 0, firstFailureAt: now, lockedUntil: 0 };

  entry.failures += 1;

  if (entry.failures >= ATTEMPTS_BEFORE_LOCK) {
    const overage = entry.failures - ATTEMPTS_BEFORE_LOCK;
    const lockMs = Math.min(BASE_LOCK_MS * 2 ** overage, MAX_LOCK_MS);
    entry.lockedUntil = now + lockMs;
  }

  attempts.set(entryKey, entry);
  sweep(now);

  return entry.lockedUntil > now ? Math.ceil((entry.lockedUntil - now) / 1000) : 0;
}

/** Clears the counter after a successful sign-in. */
export function clearLoginFailures(email: string, ip: string) {
  attempts.delete(key(email, ip));
}
