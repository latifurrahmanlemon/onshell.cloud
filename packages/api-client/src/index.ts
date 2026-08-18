/**
 * `@onshell/api-client` — the Onshell API, as one typed client.
 *
 * Used by the browser console (`apps/web`) and the desktop app (`apps/desktop`).
 * They differ in how they authenticate, not in what they call: see
 * `cookieAuth` and `bearerAuth` in `transport.ts`.
 */
export { ApiError, createTransport, cookieAuth, bearerAuth } from "./transport.js";
export type { AuthStrategy, RequestOptions, TokenPair, Transport, TransportOptions } from "./transport.js";

export { createApiClient, sessionWebsocketUrl } from "./client.js";
export type { ApiClient, ApiClientOptions } from "./client.js";

export { MAX_EDITABLE_FILE_BYTES } from "./types.js";
export type * from "./types.js";
