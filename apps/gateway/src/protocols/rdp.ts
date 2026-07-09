import type { GatewaySession } from "../registry.js";
import { createGatewaySession, updateGatewaySession } from "../registry.js";

export interface OpenRdpSessionInput {
  hostId: string;
  address: string;
  port: number;
  username?: string;
  password?: string;
  domain?: string;
  security?: string;
  width?: number;
  height?: number;
}

export function openRdpSession(input: OpenRdpSessionInput): GatewaySession {
  const session = createGatewaySession({
    protocol: "rdp",
    hostId: input.hostId,
    websocketPath: "",
    metadata: {
      address: input.address,
      port: input.port,
      username: input.username,
      password: input.password,
      domain: input.domain,
      security: input.security,
      width: input.width,
      height: input.height,
      gateway: "guacd"
    }
  });

  return updateGatewaySession(session.id, {
    status: "active",
    websocketPath: `/ws/rdp/${session.id}`
  }) as GatewaySession;
}
