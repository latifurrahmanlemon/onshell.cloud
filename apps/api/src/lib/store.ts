/**
 * Short-lived, in-process state for flows that span two requests: pending 2FA
 * setups, pending 2FA login challenges, Google OAuth `state` values, and
 * browser sign-in requests from the desktop app.
 *
 * Everything durable lives in MySQL via Prisma — nothing here survives a
 * restart, and nothing here is a credential store. Entries carry an expiry and
 * are swept on every access, so a flood of abandoned login attempts cannot grow
 * the heap without bound (an unbounded map here is a denial-of-service vector).
 */

const TWO_FACTOR_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const TWO_FACTOR_SETUP_TTL_MS = 15 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Browser sign-in requests live five minutes.
 *
 * The person has to read a code off one screen and type it into another, which
 * is a minute's work at worst; anything longer is only a window in which an
 * abandoned request sits waiting to be approved by someone who has forgotten
 * what it was for.
 */
const DESKTOP_AUTH_REQUEST_TTL_MS = 5 * 60 * 1000;

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

/**
 * One in-flight "sign in from the browser" request started by a desktop app.
 *
 * Both secrets are stored as hashes only, for the same reason refresh tokens
 * are: a heap dump, a debugger, or a stray log line must not be enough to
 * complete somebody else's sign-in. The record holds an authorisation decision
 * (`approvedUserId`) rather than a minted session, so no usable credential ever
 * sits in this map waiting to be collected.
 */
export interface DesktopAuthRequest {
  /** sha-256 of the device secret handed to the app once, at creation. */
  deviceSecretHash: string;
  /** sha-256 of the normalised user code the person types into the browser. */
  userCodeHash: string;
  /** What the app said it is. Attacker-controlled, and shown as such. */
  machineName: string;
  platform: string;
  appVersion?: string;
  requestedAt: string;
  expiresAt: string;
  /** The address the request came from, for the audit row on approval. */
  ipAddress?: string;
  /** Wrong user codes offered by a browser. Capped, so the code is not guessable. */
  codeAttempts: number;
  /** Polls served to the app. Capped, so a stuck client cannot poll forever. */
  polls: number;
  status: "pending" | "approved" | "denied";
  /** Set on approval: whose session the app has been authorised to be handed. */
  approvedUserId?: string;
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
  ),
  /** requestId -> a desktop app waiting for a browser to approve its sign-in. */
  pendingDesktopAuthRequests: new ExpiringMap<DesktopAuthRequest>(DESKTOP_AUTH_REQUEST_TTL_MS)
};
