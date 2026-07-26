/**
 * Short-lived, in-process state for flows that span two requests: pending 2FA
 * setups, pending 2FA login challenges, and Google OAuth `state` values.
 *
 * Everything durable lives in MySQL via Prisma — nothing here survives a
 * restart, and nothing here is a credential store. Entries carry an expiry and
 * are swept on every access, so a flood of abandoned login attempts cannot grow
 * the heap without bound (an unbounded map here is a denial-of-service vector).
 */

const TWO_FACTOR_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const TWO_FACTOR_SETUP_TTL_MS = 15 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Hard cap per map. Oldest entries are evicted first once exceeded. */
const MAX_ENTRIES = 5_000;

export interface TwoFactorChallenge {
  userId: string;
  createdAt: string;
  method?: "totp" | "email";
  emailOtpHash?: string;
  emailOtpExpiresAt?: string;
  lastEmailSentAt?: string;
  attempts?: number;
}

export interface OAuthState {
  createdAt: string;
  returnTo: string;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** A Map with per-entry TTL, lazy sweeping, and an insertion-order size cap. */
class ExpiringMap<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly ttlMs: number) {}

  private sweep() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  set(key: string, value: T) {
    this.sweep();
    // Map preserves insertion order, so the first key is the oldest.
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  delete(key: string) {
    return this.entries.delete(key);
  }

  get size() {
    this.sweep();
    return this.entries.size;
  }
}

export const store = {
  /** userId -> unconfirmed TOTP secret, discarded if setup is not completed. */
  pendingTwoFactorSetups: new ExpiringMap<string>(TWO_FACTOR_SETUP_TTL_MS),
  /** challengeId -> in-flight second-factor login challenge. */
  pendingTwoFactorChallenges: new ExpiringMap<TwoFactorChallenge>(TWO_FACTOR_CHALLENGE_TTL_MS),
  /** state -> CSRF state for the Google OAuth redirect round-trip. */
  googleOAuthStates: new ExpiringMap<OAuthState>(OAUTH_STATE_TTL_MS),
  /** userId -> hashed OTP for email-based 2FA enable/disable confirmation. */
  pendingEmailTwoFactorCodes: new ExpiringMap<{ otpHash: string; expiresAt: string }>(
    TWO_FACTOR_CHALLENGE_TTL_MS
  )
};
