import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { updateGatewaySession, type GatewaySession } from "../registry.js";

const sshClients = new Map<string, Client>();

/**
 * Why a connection could not be made, in words meant for the person at the
 * terminal rather than for a log. `code` stays machine-readable so the console
 * can decide what to offer (editing the host, opening the vault).
 */
export class SshConnectionError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "SshConnectionError";
  }
}

/**
 * Turns an ssh2 failure into something worth reading.
 *
 * ssh2 reports the interesting cases three different ways — a socket errno, an
 * authentication `level`, and a bare "Timed out while waiting for handshake" —
 * so each is translated here rather than at every call site.
 */
function describeSshFailure(error: NodeJS.ErrnoException & { level?: string }, input: SshConnectionInput) {
  const where = `${input.address}:${input.port}`;
  switch (error.code) {
    case "ECONNREFUSED":
      return new SshConnectionError(
        "connection_refused",
        `${where} refused the connection. Check the port, and that SSH is running on that machine.`
      );
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return new SshConnectionError(
        "address_not_found",
        `${input.address} could not be resolved. Check the address for a typo.`
      );
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return new SshConnectionError(
        "unreachable",
        `${where} did not answer. It may be offline, or a firewall is blocking the port.`
      );
    case "ECONNRESET":
      return new SshConnectionError("connection_reset", `${where} closed the connection during the handshake.`);
    default:
      break;
  }

  if (error.level === "client-authentication") {
    return new SshConnectionError(
      "authentication_failed",
      input.username
        ? `${where} rejected the credentials for "${input.username}". Check the username, and the key or password attached in the Vault.`
        : `${where} rejected the credentials. Attach a key or password in the Vault and set the host's username.`
    );
  }
  if (/timed out/i.test(error.message)) {
    return new SshConnectionError("handshake_timeout", `${where} did not complete the SSH handshake in time.`);
  }

  return new SshConnectionError("connection_failed", error.message || `Could not connect to ${where}.`);
}

/**
 * Resolves once a session's SSH client is usable, and rejects with the reason
 * it will never be. The browser opens its WebSocket the moment the API answers,
 * which is normally before the handshake has finished — without this the shell
 * was asked for on a client that had not connected yet.
 */
const readiness = new Map<string, Promise<void>>();

export function waitForSshReady(sessionId: string) {
  const pending = readiness.get(sessionId);
  if (!pending) {
    return Promise.reject(new SshConnectionError("not_connected", "This session is no longer connected."));
  }
  return pending;
}

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
  readiness.delete(sessionId);
}

export function attachSshConnection(session: GatewaySession, input: SshConnectionInput) {
  const client = new Client();
  sshClients.set(session.id, client);

  let markReady: () => void = () => undefined;
  let markFailed: (error: SshConnectionError) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    markFailed = reject;
  });
  // Nothing awaits this until the browser's socket arrives, which may be after
  // the handshake has already failed; the no-op keeps that from surfacing as an
  // unhandled rejection and taking the gateway down with it.
  void ready.catch(() => undefined);
  readiness.set(session.id, ready);

  client
    .on("ready", () => {
      updateGatewaySession(session.id, {
        status: "active",
        websocketPath: session.protocol === "ssh" ? `/ws/ssh/${session.id}` : session.websocketPath
      });
      markReady();
    })
    .on("error", (error) => {
      const failure = describeSshFailure(error, input);
      updateGatewaySession(session.id, {
        status: "failed",
        metadata: {
          ...session.metadata,
          error: failure.message,
          errorCode: failure.code
        }
      });
      markFailed(failure);
      sshClients.delete(session.id);
    })
    .on("close", () => {
      updateGatewaySession(session.id, { status: "closed" });
      // A close before "ready" is a connection that never happened; resolving it
      // would send the caller on to ask for a shell on a dead client.
      markFailed(
        new SshConnectionError("connection_closed", `The connection to ${input.address}:${input.port} closed.`)
      );
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

export async function openShell(sessionId: string) {
  await waitForSshReady(sessionId);
  const client = getSshClient(sessionId);
  if (!client) throw new SshConnectionError("not_connected", "This session is no longer connected.");

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

export async function getSftp(sessionId: string) {
  // Same race as openShell: the file view can ask for SFTP while the handshake
  // is still in flight.
  await waitForSshReady(sessionId);
  const client = getSshClient(sessionId);
  if (!client) throw new SshConnectionError("not_connected", "This session is no longer connected.");

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

