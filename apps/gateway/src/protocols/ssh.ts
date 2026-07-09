import type { GatewaySession } from "../registry.js";
import { createGatewaySession, updateGatewaySession } from "../registry.js";
import { attachSshConnection } from "./ssh-connections.js";

export interface OpenSshSessionInput {
  hostId: string;
  address: string;
  port: number;
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export function openSshSession(input: OpenSshSessionInput): GatewaySession {
  const session = createGatewaySession({
    protocol: "ssh",
    hostId: input.hostId,
    websocketPath: "",
    metadata: {
      address: input.address,
      port: input.port,
      username: input.username
    }
  });

  attachSshConnection(session, input);

  return updateGatewaySession(session.id, {
    websocketPath: `/ws/ssh/${session.id}`
  }) as GatewaySession;
}
