import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { updateGatewaySession, type GatewaySession } from "../registry.js";

const sshClients = new Map<string, Client>();

export interface SshConnectionInput {
  hostId: string;
  address: string;
  port: number;
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export function getSshClient(sessionId: string) {
  return sshClients.get(sessionId);
}

export function closeSshClient(sessionId: string) {
  const client = sshClients.get(sessionId);
  if (client) {
    client.end();
    sshClients.delete(sessionId);
  }
}

export function attachSshConnection(session: GatewaySession, input: SshConnectionInput) {
  const client = new Client();
  sshClients.set(session.id, client);

  client
    .on("ready", () => {
      updateGatewaySession(session.id, {
        status: "active",
        websocketPath: session.protocol === "ssh" ? `/ws/ssh/${session.id}` : session.websocketPath
      });
    })
    .on("error", (error) => {
      updateGatewaySession(session.id, {
        status: "failed",
        metadata: {
          ...session.metadata,
          error: error.message
        }
      });
      sshClients.delete(session.id);
    })
    .on("close", () => {
      updateGatewaySession(session.id, { status: "closed" });
      sshClients.delete(session.id);
    });

  const config: ConnectConfig = {
    host: input.address,
    port: input.port,
    username: input.username,
    password: input.password,
    privateKey: input.privateKey,
    passphrase: input.passphrase,
    keepaliveInterval: 15_000,
    readyTimeout: 20_000
  };

  client.connect(config);
}

export function openShell(sessionId: string) {
  const client = getSshClient(sessionId);
  if (!client) throw new Error("SSH client is not connected");

  return new Promise<ClientChannel>((resolve, reject) => {
    client.shell(
      {
        term: "xterm-256color"
      },
      (error, stream) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(stream);
      }
    );
  });
}

export function getSftp(sessionId: string) {
  const client = getSshClient(sessionId);
  if (!client) throw new Error("SSH client is not connected");

  return new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(sftp);
    });
  });
}

