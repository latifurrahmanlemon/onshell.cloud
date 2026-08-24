/**
 * The console's API client — the browser's binding of `@onshell/api-client`.
 *
 * Every endpoint now lives in that package, shared with the desktop app, so the
 * two cannot drift on what a route means. What stays here is the part that is
 * genuinely browser-specific: cookie authentication, and probing whether an
 * agent is running on this very machine.
 */
import { ApiError, cookieAuth, createApiClient, sessionWebsocketUrl as buildWebsocketUrl } from "@onshell/api-client";
import type { LocalRoute, RemoteSession } from "@onshell/api-client";

export { apiBaseUrl, gatewayBaseUrl } from "../../lib/site";
import { apiBaseUrl, gatewayBaseUrl } from "../../lib/site";

export { ApiError };
export { MAX_EDITABLE_FILE_BYTES } from "@onshell/api-client";
export type {
  ActiveOrganizationChange,
  AiMessage,
  AiSendResult,
  AiStatus,
  AiThreadDetail,
  AiThreadSummary,
  BillingInterval,
  CheckoutStart,
  ConsolePlan,
  CurrentIdentity,
  GrowthOverview,
  HostExportFormat,
  HostImportFormat,
  HostImportOptions,
  HostImportPreview,
  HostImportPreviewRow,
  HostImportResult,
  HostWorkspace,
  InviteResult,
  LaunchedSession,
  LocalRoute,
  MemberHostAccess,
  MembershipSummary,
  PendingInvitation,
  RemoteDirectory,
  RemoteFileContent,
  RemoteFileEntry,
  TeamMember,
  UsageEntry
} from "@onshell/api-client";

const auth = cookieAuth({ baseUrl: apiBaseUrl });

/**
 * Renews the session ahead of time, for a console that has been left open.
 * Called when the tab regains focus.
 */
export const keepSessionAlive = auth.keepAlive;

/**
 * Tries the loopback route to an agent on this machine, falling back to the
 * tunnel by returning undefined.
 *
 * Three ways this legitimately fails, none of them worth showing the user: the
 * browser is on a different machine entirely (the common case), Safari refuses
 * `ws://127.0.0.1` from an https page, or endpoint software blocks loopback
 * listeners. The probe is given a short deadline for exactly that reason — a
 * session must not hang waiting to discover it is remote.
 *
 * The device id is checked because *something* answering on that port is not
 * evidence it is the machine we were told to expect.
 */
async function probeLocalRoute(local: LocalRoute): Promise<string | undefined> {
  const controller = new AbortController();
  const deadline = window.setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(`http://127.0.0.1:${local.port}/onshell/hello`, {
      signal: controller.signal,
      // Not `include`: this endpoint authenticates on the ticket alone, and
      // sending cookies to a loopback port would be a way to leak them.
      credentials: "omit"
    });
    if (!response.ok) return undefined;

    const hello = (await response.json()) as { deviceId?: string };
    if (local.deviceId && hello.deviceId !== local.deviceId) return undefined;

    return `ws://127.0.0.1:${local.port}/onshell/session?ticket=${encodeURIComponent(local.ticket)}`;
  } catch {
    return undefined;
  } finally {
    window.clearTimeout(deadline);
  }
}

export const consoleApi = createApiClient({
  baseUrl: apiBaseUrl,
  gatewayBaseUrl,
  auth,
  probeLocalRoute
});

/** Resolve a session's terminal WebSocket URL, falling back to the gateway convention. */
export function sessionWebsocketUrl(session: RemoteSession, explicit?: string) {
  return buildWebsocketUrl(gatewayBaseUrl, session, explicit);
}
