/**
 * Getting a token the gateway will accept.
 *
 * The agent authenticates against the **API** with its long-lived device token
 * and receives a short-lived JWT, which it then presents to the gateway. The
 * gateway therefore needs no database and never learns the device token — it
 * checks a signature and reads the claims, which is all it does for anything
 * else. See docs/agent.md.
 */
import { AGENT_VERSION, type AgentConfig } from "./config.js";

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Development escape hatch: a pre-minted agent JWT, so the tunnel and the
 * terminal can be exercised before enrollment exists.
 *
 * Phase 2 deletes this path. It is gated on an explicit environment variable
 * and announces itself loudly precisely so it cannot become load-bearing.
 */
function developmentToken() {
  const token = process.env.ONSHELL_AGENT_DEV_TOKEN;
  if (!token) return undefined;

  console.warn(
    "[onshell-agent] using ONSHELL_AGENT_DEV_TOKEN — development only, this bypasses device enrollment"
  );
  return token;
}

export async function getConnectionToken(config: AgentConfig): Promise<string> {
  const development = developmentToken();
  if (development) return development;

  if (!config.deviceId || !config.deviceToken) {
    throw new AuthError(
      "not_enrolled",
      `This machine is not paired yet. Run: onshell-agent pair <code>  (config: ${config.apiBaseUrl})`
    );
  }

  let response: Response;
  try {
    response = await fetch(`${config.apiBaseUrl}/agents/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `onshell-agent/${AGENT_VERSION}`
      },
      body: JSON.stringify({ deviceId: config.deviceId, deviceToken: config.deviceToken })
    });
  } catch (error) {
    throw new AuthError("api_unreachable", error instanceof Error ? error.message : String(error));
  }

  // A revoked device is permanent until re-paired, but the caller still retries
  // on a backoff: the alternative is an agent that gives up on a transient 401
  // and needs a human to restart it. Retrying a revoked device costs one request
  // a minute and resolves itself the moment it is re-enrolled.
  if (response.status === 401 || response.status === 403) {
    throw new AuthError("device_rejected", "This device was revoked or its token is no longer valid.");
  }
  if (!response.ok) {
    throw new AuthError("token_request_failed", `API responded with status ${response.status}`);
  }

  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new AuthError("token_request_failed", "API response contained no token");
  }

  return body.token;
}
