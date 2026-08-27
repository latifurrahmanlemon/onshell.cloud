/**
 * Response shapes for the Onshell API, as seen by a client.
 *
 * These describe what the API *sends*, which is deliberately not the same as
 * what it stores — a `CredentialSummary` has no secret in it because no route
 * returns one. Domain entities (`Host`, `User`, `Role`, …) come from
 * `@onshell/shared` and are re-exported here so a client needs one import.
 */
import type {
  AccountSession,
  AgentDevice,
  AuditLog,
  CredentialSummary,
  Host,
  Organization,
  RemoteSession,
  Role,
  Snippet,
  ThemePreference,
  User
} from "@onshell/shared";

export type {
  AccountSession,
  AgentDevice,
  AuditLog,
  CredentialSummary,
  Host,
  Organization,
  RemoteSession,
  Role,
  Snippet,
  ThemePreference,
  User
};

/**
 * One workspace this account belongs to.
 *
 * `role` is the role held *in that workspace*, not the caller's current role:
 * being an owner of your own workspace and an auditor of one you were invited to
 * is the ordinary case, and a switcher that showed one role for both would tell
 * the user the wrong thing about what they are about to be able to do.
 */
export interface MembershipSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
  isActive: boolean;
  joinedAt: string;
}

/**
 * The server put the session in a different workspace from the one it asked for.
 *
 * Happens when a live token names a workspace the person has since been removed
 * from. They keep working, in a workspace they really do belong to — but a
 * console whose host list silently becomes somebody else's is indistinguishable
 * from a console that has broken, so the substitution is reported rather than
 * performed quietly.
 */
export interface ActiveOrganizationChange {
  reason: "membership_revoked";
  previousOrganizationId: string;
  /** Null when the workspace itself was deleted rather than the membership. */
  previousOrganizationName: string | null;
  organizationId: string | null;
  organizationName: string | null;
}

export interface CurrentIdentity {
  user: User;
  organization?: Organization;
  /** Every workspace this account can switch into. One entry is the common case. */
  organizations?: MembershipSummary[];
  activeOrganizationChanged?: ActiveOrganizationChange;
}

export interface OrganizationList {
  activeOrganizationId: string;
  organizations: MembershipSummary[];
}

/**
 * `changed` is false when the caller asked for the workspace it was already in,
 * which is a no-op rather than an error and mints no new session.
 */
export interface OrganizationSwitchResult {
  user: User;
  organization: Organization;
  changed: boolean;
  /** Present only when a session was actually minted, i.e. `changed` is true. */
  accessToken?: string;
  refreshToken?: string;
}

/** A member's effective host access, as returned alongside the team list. */
export interface MemberHostAccess {
  /** Reaches every host in the organization, including ones added later. */
  allHosts: boolean;
  /** Individually granted host ids. Empty when `allHosts` is true. */
  hostIds: string[];
  /** True when the access comes from the role (owner/admin) and cannot be edited. */
  implicit: boolean;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
  role: Role;
  joinedAt?: string;
  twoFactorEnabled?: boolean;
  hostAccess?: MemberHostAccess;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: Role;
  expiresAt?: string;
  createdAt?: string;
}

export interface InviteResult extends PendingInvitation {
  /**
   * False when SMTP is disabled or the send failed. The invitation is still
   * valid — it just has to be delivered by hand using `acceptUrl`.
   */
  emailSent: boolean;
  acceptUrl: string;
}

/**
 * What the accept page can learn about an invitation before accepting it.
 *
 * Read with the token alone, by someone who may have no account yet, so it is
 * narrower than `PendingInvitation`: no id, no organization id, and `email` is
 * masked by the API (`l•••@example.com`) rather than returned in full.
 */
export interface InvitationPreview {
  organizationName: string;
  role: Role;
  /** Masked. Enough for the recipient to recognise the mailbox, no more. */
  email: string;
  /** True when the invited address already has an account, so no password is needed. */
  existingUser: boolean;
  expiresAt: string;
}

/**
 * The membership was added to an account that already existed. No session comes
 * back with this — the person still has to sign in, with whatever password and
 * second factor that account already has.
 */
export interface InvitationAcceptedForExistingUser {
  accepted: true;
  existingUser: true;
  requiresLogin: true;
  organizationId: string;
}

/**
 * Two genuinely different outcomes, distinguished by `requiresLogin`: an
 * invitation accepted by a brand-new user creates the account and signs it in
 * (cookies on the response, tokens in the body), while one accepted for an
 * existing account only grants the membership.
 */
export type AcceptInvitationResult =
  | InvitationAcceptedForExistingUser
  | { user: User; accessToken: string; refreshToken: string };

/**
 * A direct route to an agent running on the same machine as this client.
 *
 * Offered by the API; whether it can actually be used is decided at the client,
 * because only the client knows if it is on that machine.
 */
export interface LocalRoute {
  port: number;
  ticket: string;
  deviceId?: string;
}

export interface LaunchedSession {
  session: RemoteSession;
  websocketUrl?: string;
  localRoute?: LocalRoute;
  connectUrl?: string;
}

/** Source formats the host importer understands. */
export type HostImportFormat =
  | "onshell-json"
  | "termius-json"
  | "csv"
  | "ssh-config"
  | "putty-reg"
  | "rdp"
  | "rdcman";

export type HostExportFormat = "json" | "csv" | "ssh-config";

export interface HostImportPreviewRow {
  name: string;
  type: "ssh" | "rdp" | "vnc";
  address: string;
  port: number;
  username?: string;
  environment: "production" | "staging" | "development";
  tags: string[];
  group?: string;
  notes?: string;
  sourceRef: string;
  /** "new" will be created; the others are reported but not written. */
  disposition: "new" | "duplicate-in-file" | "exists";
}

export interface HostImportPreview {
  format: HostImportFormat;
  summary: { parsed: number; new: number; existing: number; duplicatesInFile: number; skipped: number };
  limit: {
    maxHosts: number | null;
    currentHosts: number;
    planName: string | null;
    wouldExceed: boolean;
    remaining: number | null;
  };
  hosts: HostImportPreviewRow[];
  truncatedPreview: boolean;
  issues: Array<{ sourceRef: string; message: string }>;
}

export interface HostImportResult {
  format: HostImportFormat;
  created: number;
  updated: number;
  skippedExisting: number;
  duplicatesInFile: number;
  failed: number;
  failures: Array<{ sourceRef: string; message: string }>;
  issues: Array<{ sourceRef: string; message: string }>;
}

export interface HostImportOptions {
  content: string;
  filename?: string;
  format?: HostImportFormat;
  environmentOverride?: "production" | "staging" | "development";
  groupOverride?: string;
  extraTags?: string[];
  onDuplicate?: "skip" | "update";
}

export interface AiThreadSummary {
  id: string;
  title: string;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

export interface AiMessage {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  createdAt: string;
}

export interface AiThreadDetail extends AiThreadSummary {
  messages: AiMessage[];
}

export interface AiStatus {
  enabled: boolean;
  model: string | null;
  used: number;
  /** Null means unlimited on the current plan. */
  limit: number | null;
  remaining: number | null;
  planName: string | null;
}

export interface AiSendResult {
  thread: AiThreadSummary;
  userMessage: AiMessage;
  assistantMessage: AiMessage;
  usage: { used: number; limit: number | null; remaining: number | null };
}

/** One metered resource, as returned by GET /me/growth. */
export interface UsageEntry {
  used: number;
  limit: number | null;
  ratio: number | null;
  atLimit: boolean;
  nearLimit: boolean;
}

/** A plan as offered in the console's upgrade grid. */
export interface ConsolePlan {
  code: string;
  name: string;
  description: string;
  tagline: string | null;
  badge: string | null;
  isFree: boolean;
  isFeatured: boolean;
  displayOrder: number;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  currency: string;
  maxUsers: number | null;
  maxHosts: number | null;
  maxConcurrentSessions: number | null;
  monthlyAiMessages: number | null;
  auditRetentionDays: number;
  trialDays: number;
  features: string[];
}

export type BillingInterval = "monthly" | "yearly";

export interface CheckoutStart {
  status: string;
  /** False when no payment provider is configured — the request became a sales enquiry. */
  selfServe: boolean;
  provider: string;
  checkoutUrl: string | null;
  plan: ConsolePlan;
  billingInterval: BillingInterval;
  message?: string;
}

export interface GrowthOverview {
  plan: (ConsolePlan & { id: string }) | null;
  plans: ConsolePlan[];
  canManageBilling: boolean;
  subscription: {
    id: string;
    status: string;
    billingInterval: string;
    currentPeriodEnd: string;
    trialEndsAt: string | null;
    cancelAt: string | null;
  } | null;
  usage: {
    members: UsageEntry;
    hosts: UsageEntry;
    concurrentSessions: UsageEntry;
    aiMessages: UsageEntry;
  };
  upgrade: { shouldPrompt: boolean; plan: ConsolePlan } | null;
  referral: { code: string | null; url: string; signups: number };
}

/* ------------------------------------------------------------------ files */

/** One entry in a remote directory listing. */
export interface RemoteFileEntry {
  name: string;
  type: "file" | "directory" | "other";
  size: number;
  /** Unix seconds. 0 when the entry could not be stat'ed. */
  modifiedAt: number;
}

export interface RemoteDirectory {
  /** The path the server resolved — "." becomes an absolute path. */
  path: string;
  entries: RemoteFileEntry[];
}

/** Largest file the editor will open. Bigger files must be transferred, not edited. */
export const MAX_EDITABLE_FILE_BYTES = 1024 * 1024;

export interface RemoteFileContent {
  path: string;
  size: number;
  /** UTF-8 text. Absent when `binary` is true. */
  content?: string;
  /** True when the bytes are not valid UTF-8, so the editor must refuse. */
  binary: boolean;
  /** True when the file exceeded MAX_EDITABLE_FILE_BYTES and was not read. */
  tooLarge: boolean;
}

/* ------------------------------------------------------------- workspaces */

/** A saved set of hosts that can be opened as terminals in one action. */
export interface HostWorkspace {
  id: string;
  name: string;
  description?: string | null;
  hostIds: string[];
  createdAt: string;
  updatedAt: string;
}
