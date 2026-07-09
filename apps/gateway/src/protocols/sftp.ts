import type { GatewaySession } from "../registry.js";
import { createGatewaySession, updateGatewaySession } from "../registry.js";
import { attachSshConnection, getSftp } from "./ssh-connections.js";

export interface OpenSftpSessionInput {
  hostId: string;
  address: string;
  port: number;
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  startPath?: string;
}

export function openSftpSession(input: OpenSftpSessionInput): GatewaySession {
  const session = createGatewaySession({
    protocol: "sftp",
    hostId: input.hostId,
    metadata: {
      address: input.address,
      port: input.port,
      username: input.username,
      startPath: input.startPath ?? "/"
    }
  });

  attachSshConnection(session, input);

  return updateGatewaySession(session.id, {}) as GatewaySession;
}

export async function listSftpDirectory(sessionId: string, path = "/") {
  const sftp = await getSftp(sessionId);

  return new Promise<Array<{ name: string; type: "file" | "directory" | "other"; size: number; modifiedAt: number }>>((resolve, reject) => {
    sftp.readdir(path, (error, entries) => {
      sftp.end();
      if (error) {
        reject(error);
        return;
      }

      resolve(
        entries.map((entry) => ({
          name: entry.filename,
          type: entry.longname.startsWith("d") ? "directory" : entry.longname.startsWith("-") ? "file" : "other",
          size: entry.attrs.size,
          modifiedAt: entry.attrs.mtime
        }))
      );
    });
  });
}
