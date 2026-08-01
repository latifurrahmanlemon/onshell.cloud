/**
 * The wire protocol between an Onshell Agent and the gateway.
 *
 * One WebSocket per agent carries every terminal and every file operation on
 * that machine, so frames are multiplexed by channel:
 *
 *   - **Text frames are JSON control messages** (this module's zod schemas).
 *   - **Binary frames are pty bytes**, prefixed with a uint32 little-endian
 *     channel id — see `encodeDataFrame`.
 *
 * The split is what keeps the hot path cheap: keystrokes and screen output are
 * the highest-volume traffic in the product, and they never pay for JSON
 * encoding or base64 expansion. Everything else stays legible in a packet
 * capture, which matters a lot when debugging somebody else's machine.
 *
 * Both directions are validated. The gateway does not trust the agent (it runs
 * on a customer's laptop) and the agent does not trust the gateway (a
 * compromised gateway must not be able to make agents do arbitrary things), so
 * each side parses with the schema for the direction it *receives*.
 *
 * See docs/agent.md.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Bumped when a change would make an older agent misread a frame. */
export const AGENT_PROTOCOL_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Shells                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A shell is named by an opaque token the agent itself advertised in `hello`,
 * never by a path or a command line: `"powershell"`, `"cmd"`, `"pwsh"`,
 * `"bash"`, `"zsh"`, `"wsl:Ubuntu-22.04"`.
 *
 * This is the single most important constraint in the protocol. There is no
 * `exec` frame and no way to name an arbitrary binary, so the only code the
 * gateway can start on a customer's machine is a shell that machine's own agent
 * chose to offer. It does not restrict the user — they can type anything once
 * the shell is open — but it does mean a compromised gateway cannot quietly run
 * something headless on thousands of laptops.
 */
export const shellTokenSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(:[A-Za-z0-9][A-Za-z0-9._+-]*)?$/, "shell token must be `name` or `name:variant`");

export type ShellToken = z.infer<typeof shellTokenSchema>;

/** One entry in the agent's advertised shell list. */
export const shellDescriptorSchema = z.object({
  /** Stable token used in `open-shell`. */
  token: shellTokenSchema,
  /** Human label for the browser's shell picker, e.g. "PowerShell 7". */
  label: z.string().min(1).max(120),
  /** Preselected when the console opens a terminal without asking. */
  default: z.boolean().default(false)
});

export type ShellDescriptor = z.infer<typeof shellDescriptorSchema>;

/* -------------------------------------------------------------------------- */
/* Channels                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Channel ids are allocated by the gateway (the side that opens things) and are
 * unique per agent connection, not globally. Zero is reserved so an
 * uninitialised field never addresses a real channel.
 */
export const channelIdSchema = z.number().int().min(1).max(0xffff_ffff);

/* -------------------------------------------------------------------------- */
/* Control frames: gateway -> agent                                           */
/* -------------------------------------------------------------------------- */

/**
 * Starts a terminal — or resumes one.
 *
 * The gateway reuses a channel id when the session behind it is still alive, so
 * an `open-shell` naming a channel the agent is still holding from a dropped
 * connection means "resume", not "start". That avoids a separate frame for a
 * case that is otherwise identical, and it degrades correctly: an agent that
 * restarted in the meantime holds nothing, starts a fresh shell, and says so
 * with `resumed: false` rather than silently handing the user a new prompt.
 */
const openShellFrameSchema = z.object({
  t: z.literal("open-shell"),
  ch: channelIdSchema,
  shell: shellTokenSchema,
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
  /** Working directory. Omitted means the user's home. */
  cwd: z.string().max(4096).optional()
});

const resizeFrameSchema = z.object({
  t: z.literal("resize"),
  ch: channelIdSchema,
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000)
});

const closeFrameSchema = z.object({
  t: z.literal("close"),
  ch: channelIdSchema
});

const rpcFrameSchema = z.object({
  t: z.literal("rpc"),
  id: z.string().min(1).max(64),
  /** `fs.*` methods arrive with the file transport — see docs/agent.md. */
  method: z.string().min(1).max(64),
  params: z.unknown().optional()
});

/**
 * Sent when the device is revoked or its policy changes under it. The agent
 * closes every pty and re-authenticates from scratch; if the device really was
 * revoked, that next `/agents/token` call fails and it stops.
 *
 * This exists because the agent's connection token is a short-lived JWT the
 * gateway validates by signature alone, with no database lookup. Without an
 * explicit kill, revoking a device would leave an already-open tunnel alive
 * until the JWT expired.
 */
const killFrameSchema = z.object({
  t: z.literal("kill"),
  reason: z.string().max(200)
});

const pingFrameSchema = z.object({ t: z.literal("ping") });

/* -------------------------------------------------------------------------- */
/* Stream frames (both directions)                                            */
/* -------------------------------------------------------------------------- */

/**
 * File contents move as binary frames on their own channel, exactly like pty
 * output — so a download is not base64-inflated through JSON, and the same
 * multiplexing serves both.
 *
 * These three frames are what a channel needs beyond raw bytes: an end, a
 * failure, and permission to keep going. All three travel in both directions,
 * because a read has the agent writing and a write has the gateway writing.
 */
const streamEndFrameSchema = z.object({
  t: z.literal("stream-end"),
  ch: channelIdSchema
});

const streamErrorFrameSchema = z.object({
  t: z.literal("stream-error"),
  ch: channelIdSchema,
  code: z.string().max(64),
  message: z.string().max(500).optional()
});

/**
 * Grants the far side permission to send `bytes` more on this channel.
 *
 * Without it, an agent reading a large file from a fast disk would push it into
 * the tunnel as quickly as it could read, and whatever is draining the other end
 * — a slow browser, a slower destination host — would fall behind until the
 * gateway ran out of memory. The reader releases credit only as it drains, so
 * the slowest link sets the pace.
 */
const streamCreditFrameSchema = z.object({
  t: z.literal("stream-credit"),
  ch: channelIdSchema,
  bytes: z.number().int().min(1).max(64 * 1024 * 1024)
});

/**
 * Bytes a stream may have in flight before it must wait for credit.
 *
 * Both ends start a channel with this much credit by convention, so the first
 * megabyte moves without a round trip; after that the reader's `stream-credit`
 * frames set the pace.
 */
export const STREAM_WINDOW_BYTES = 1024 * 1024;

/** Every frame an agent is willing to act on. */
export const gatewayFrameSchema = z.discriminatedUnion("t", [
  openShellFrameSchema,
  resizeFrameSchema,
  closeFrameSchema,
  rpcFrameSchema,
  killFrameSchema,
  pingFrameSchema,
  streamEndFrameSchema,
  streamErrorFrameSchema,
  streamCreditFrameSchema
]);

export type GatewayFrame = z.infer<typeof gatewayFrameSchema>;

/* -------------------------------------------------------------------------- */
/* Control frames: agent -> gateway                                           */
/* -------------------------------------------------------------------------- */

/** First frame after connecting. Until it arrives the connection is unusable. */
const helloFrameSchema = z.object({
  t: z.literal("hello"),
  protocolVersion: z.number().int(),
  agentVersion: z.string().max(32),
  platform: z.enum(["win32", "darwin", "linux"]),
  arch: z.string().max(32),
  osVersion: z.string().max(200).optional(),
  hostname: z.string().max(255).optional(),
  shells: z.array(shellDescriptorSchema).max(64),
  /**
   * The loopback port this agent is listening on, when it has one.
   *
   * Advertised so the gateway can offer a browser *on this same machine* a
   * direct connection instead of a round trip through us. Absent when the
   * listener could not start, which is common enough — corporate endpoint
   * software blocks loopback listeners — that it must never be required.
   */
  localPort: z.number().int().min(1).max(65535).optional(),
  /**
   * False when node-pty could not load and the agent fell back to piping a
   * shell over stdio. Commands still run, but there is no job control, no
   * window size, and a duller prompt — the console says so rather than letting
   * the user wonder why their editor looks broken.
   */
  pty: z.boolean().default(true)
});

const openedFrameSchema = z.object({
  t: z.literal("opened"),
  ch: channelIdSchema,
  pid: z.number().int().optional(),
  /** True when this reattached a held pty; false when a fresh shell was started. */
  resumed: z.boolean().default(false),
  /** Per-channel, because the stdio fallback is decided at spawn time. */
  pty: z.boolean().default(true)
});

const exitFrameSchema = z.object({
  t: z.literal("exit"),
  ch: channelIdSchema,
  code: z.number().int().optional()
});

/**
 * A channel failed to open, or failed later. Codes are stable identifiers
 * (`shell_not_available`, `spawn_failed`, `consent_denied`, `policy_denied`);
 * `message` is for logs and is never rendered as trusted markup.
 */
const channelErrorFrameSchema = z.object({
  t: z.literal("channel-error"),
  ch: channelIdSchema,
  code: z.string().max(64),
  message: z.string().max(500).optional()
});

const rpcOkFrameSchema = z.object({
  t: z.literal("rpc-ok"),
  id: z.string().min(1).max(64),
  result: z.unknown().optional()
});

const rpcErrFrameSchema = z.object({
  t: z.literal("rpc-err"),
  id: z.string().min(1).max(64),
  code: z.string().max(64),
  message: z.string().max(500).optional()
});

const pongFrameSchema = z.object({ t: z.literal("pong") });

/** Every frame the gateway is willing to act on. */
export const agentFrameSchema = z.discriminatedUnion("t", [
  helloFrameSchema,
  openedFrameSchema,
  exitFrameSchema,
  channelErrorFrameSchema,
  rpcOkFrameSchema,
  rpcErrFrameSchema,
  pongFrameSchema,
  streamEndFrameSchema,
  streamErrorFrameSchema,
  streamCreditFrameSchema
]);

export type AgentFrame = z.infer<typeof agentFrameSchema>;
export type HelloFrame = z.infer<typeof helloFrameSchema>;

/**
 * Parses a text frame, returning `undefined` rather than throwing.
 *
 * Malformed input is expected here, not exceptional: this is a socket open to
 * the public internet, and an unparseable frame should close one connection,
 * not unwind a stack through the event loop.
 */
export function parseFrame<T extends z.ZodTypeAny>(schema: T, raw: string): z.infer<T> | undefined {
  if (raw.length > MAX_CONTROL_FRAME_BYTES) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function serializeFrame(frame: AgentFrame | GatewayFrame) {
  return JSON.stringify(frame);
}

/* -------------------------------------------------------------------------- */
/* File operations                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The file surface an agent exposes, mirroring the gateway's `FileTransport`
 * one method at a time so the existing file manager works against a customer's
 * machine with no second implementation.
 *
 * Path *semantics* live on the agent, not here: it is the side that knows
 * whether it is resolving `C:\Users\me` or `/home/me`, and what the session's
 * start directory actually is.
 */
/**
 * Who is asking.
 *
 * Carried on every session open so the machine can log it and, when its policy
 * says to, ask the person sitting at it. This is the field that makes consent
 * meaningful: "someone wants a shell on your laptop" is not a decision anyone
 * can make, and "ada@example.com wants a shell on your laptop" is.
 */
export const requesterSchema = z.object({
  id: z.string().max(64),
  name: z.string().max(120),
  email: z.string().max(320)
});

export type Requester = z.infer<typeof requesterSchema>;

/**
 * Opens a session on the machine, subject to its local policy.
 *
 * Called once per terminal or file session, before anything else happens. The
 * agent answers `consent_denied` if the person at the keyboard says no, or if
 * the request times out waiting for them.
 */
export const sessionOpenParamsSchema = z.object({
  kind: z.enum(["shell", "files"]),
  requestedBy: requesterSchema.optional()
});

export const sessionOpenResultSchema = z.object({ granted: z.literal(true) });

/**
 * Tells the agent to expect a direct loopback connection.
 *
 * The gateway mints a single-use ticket, hands it to the agent over the tunnel
 * and to the browser in the session response. A browser on the same machine
 * then presents it to the agent's own listener, which is what lets keystrokes
 * skip the round trip through us entirely.
 *
 * The ticket is the whole authentication for that connection, which is why it
 * is single-use, short-lived, and only ever issued for a session the API has
 * already authorised.
 */
export const localExpectParamsSchema = z.object({
  ticket: z.string().min(32).max(128),
  shell: shellTokenSchema.optional(),
  cwd: z.string().max(4096).optional(),
  expiresInMs: z.number().int().min(1000).max(600_000)
});

export const SESSION_METHODS = ["session.open", "local.expect"] as const;

/** How long a loopback ticket stays redeemable. */
export const LOCAL_TICKET_TTL_MS = 60_000;

/** Ports the agent tries, in order, and the browser probes. */
export const LOCAL_PORTS = [7681, 7682, 7683, 7684, 7685, 7686, 7687, 7688, 7689, 7690] as const;

export const FS_METHODS = [
  "fs.resolve",
  "fs.stat",
  "fs.lstat",
  "fs.readdir",
  "fs.mkdir",
  "fs.rename",
  "fs.unlink",
  "fs.rmdir",
  "fs.openRead",
  "fs.openWrite"
] as const;

export type FsMethod = (typeof FS_METHODS)[number];

const filePathSchema = z.string().min(1).max(4096);

export const fsResolveParamsSchema = z.object({
  requested: z.string().max(4096),
  /** The session's start directory. Defaults to the account's home. */
  startPath: z.string().max(4096).optional()
});
export const fsPathParamsSchema = z.object({ path: filePathSchema });
export const fsRenameParamsSchema = z.object({ from: filePathSchema, to: filePathSchema });

/** Opening a stream names the channel its bytes will travel on. */
export const fsStreamParamsSchema = z.object({ path: filePathSchema, ch: channelIdSchema });

export const remoteEntryTypeSchema = z.enum(["file", "directory", "other"]);

export const pathStatSchema = z.object({
  type: remoteEntryTypeSchema,
  size: z.number().int().min(0),
  /** Unix seconds. Zero when the entry could not be stat'ed. */
  modifiedAt: z.number().int().min(0)
});

export const remoteFileEntrySchema = pathStatSchema.extend({ name: z.string().max(1024) });

export const fsResolveResultSchema = z.object({ path: filePathSchema });
export const fsReaddirResultSchema = z.object({ entries: z.array(remoteFileEntrySchema).max(100_000) });
export const fsOkResultSchema = z.object({ ok: z.literal(true) });

export type PathStatPayload = z.infer<typeof pathStatSchema>;
export type RemoteFileEntryPayload = z.infer<typeof remoteFileEntrySchema>;

/* -------------------------------------------------------------------------- */
/* Binary data frames                                                         */
/* -------------------------------------------------------------------------- */

export const DATA_FRAME_HEADER_BYTES = 4;

/**
 * Caps a single pty write. Terminal output arrives in far smaller pieces than
 * this; the limit exists so a hostile or wedged peer cannot make the other side
 * buffer without bound.
 */
export const MAX_DATA_FRAME_BYTES = 1024 * 1024;

/** Control frames are small by construction; anything larger is a bug or an attack. */
export const MAX_CONTROL_FRAME_BYTES = 256 * 1024;

export function encodeDataFrame(channelId: number, payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const frame = Buffer.allocUnsafe(DATA_FRAME_HEADER_BYTES + body.length);
  frame.writeUInt32LE(channelId, 0);
  body.copy(frame, DATA_FRAME_HEADER_BYTES);
  return frame;
}

export function decodeDataFrame(frame: Buffer): { channelId: number; payload: Buffer } | undefined {
  if (frame.length < DATA_FRAME_HEADER_BYTES) return undefined;
  if (frame.length > DATA_FRAME_HEADER_BYTES + MAX_DATA_FRAME_BYTES) return undefined;

  const channelId = frame.readUInt32LE(0);
  if (channelId === 0) return undefined;

  return { channelId, payload: frame.subarray(DATA_FRAME_HEADER_BYTES) };
}

/* -------------------------------------------------------------------------- */
/* Timings                                                                    */
/* -------------------------------------------------------------------------- */

export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Two and a half missed beats. Tolerates one lost packet without a false drop. */
export const HEARTBEAT_TIMEOUT_MS = 75_000;

export const RECONNECT_MIN_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 60_000;

/**
 * How long open ptys survive a dropped tunnel.
 *
 * A laptop moving between wifi networks, or a phone losing signal in a lift,
 * must not kill a running build. The agent holds the ptys and buffers their
 * output for this long; if the agent reconnects inside the window the session
 * resumes where it left off.
 */
export const CHANNEL_RESUME_GRACE_MS = 60_000;

/** Per-channel replay buffer for a resumed session. Roughly a few screens of scrollback. */
export const CHANNEL_REPLAY_BUFFER_BYTES = 256 * 1024;

/* -------------------------------------------------------------------------- */
/* Agent connection tokens                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The agent authenticates to the *API* with its long-lived device token and
 * gets one of these back — a short-lived JWT it then presents to the gateway.
 *
 * That indirection is what lets the gateway stay database-free: it validates a
 * signature and reads the claims, exactly as it does for nothing else today. It
 * never learns the device token, and a stolen gateway log yields at most a
 * credential that expires in minutes.
 */
export interface AgentTokenPayload {
  /** Device id. */
  sub: string;
  organizationId: string;
  /**
   * Pins the audience.
   *
   * User access tokens are signed with the same `JWT_SECRET`, so without this
   * claim any logged-in user's token would also verify here and could be
   * presented as an agent. Verification requires the literal `"agent"`.
   */
  typ: "agent";
  exp: number;
}

export const AGENT_TOKEN_TTL_SECONDS = 15 * 60;

function base64Url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

export function signAgentToken(
  payload: Omit<AgentTokenPayload, "exp" | "typ">,
  secret: string,
  ttlSeconds = AGENT_TOKEN_TTL_SECONDS
) {
  const header = { alg: "HS256", typ: "JWT" };
  const body: AgentTokenPayload = {
    ...payload,
    typ: "agent",
    exp: Math.floor(Date.now() / 1000) + ttlSeconds
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(body))}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");

  return `${unsigned}.${signature}`;
}

/** Constant-time compare, so a forged signature leaks no prefix information. */
function signatureMatches(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function verifyAgentToken(token: string, secret: string): AgentTokenPayload | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;

  const [encodedHeader, encodedPayload, signature] = parts;
  if (!encodedHeader || !encodedPayload || !signature) return undefined;

  const expected = createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest("base64url");
  if (!signatureMatches(expected, signature)) return undefined;

  try {
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as { alg?: unknown };
    // Pinned so `alg: none` can never be honoured if this path is refactored.
    if (header.alg !== "HS256") return undefined;

    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as AgentTokenPayload;
    if (payload.typ !== "agent") return undefined;
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return undefined;
    if (typeof payload.organizationId !== "string" || payload.organizationId.length === 0) return undefined;
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}
