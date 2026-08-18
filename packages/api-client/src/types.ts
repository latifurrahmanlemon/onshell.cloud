/**
 * Response shapes for the Onshell API, as seen by a client.
 *
 * These describe what the API *sends*, which is deliberately not the same as
 * what it stores — a `CredentialSummary` has no secret in it because no route
 * returns one. Domain entities (`Host`, `User`, `Role`, …) come from
 * `@onshell/shared` and are re-exported here so a client needs one import.
 */
import type {
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

export interface CurrentIdentity {
  user: User;
  organization?: Organization;
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
