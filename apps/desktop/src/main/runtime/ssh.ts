/**
 * Direct SSH: this machine dials the host, and nothing of ours is on the wire.
 *
 * The credential arrives as a lease — decrypted by the API, valid for about a
 * minute, for one host and one session. It is used here and then dropped. Three
 * rules keep that honest, and all three are visible in this file:
 *
 *   1. The material never leaves the main process. It is not sent to the
 *      renderer, not written to a file, not put in a log line, and not attached
 *      to an error.
 *   2. It is overwritten in the buffer once ssh2 has consumed it, so it is not
 *      sitting in memory for the life of a session that may last all day, and
 *      is less likely to survive into a crash dump.
 *   3. Failures are reported as sentences, not as the underlying error object,
 *      which for ssh2 can contain the key it tried.
 */
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import { requireApi } from "./session.js";
import { deviceSecret } from "./device.js";

export interface DirectLease {
  sessionId: string;
  host: { address: string; port: number; username?: string };
  credential: { kind: "password" | "privateKey"; material: string; passphraseHint?: string };
  expiresAt: string;
}

export interface DirectSession {
  sessionId: string;
  title: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** Errors the caller is expected to handle by offering the relay instead. */
export class DirectUnavailableError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DirectUnavailableError";
    this.code = code;
  }
}

/**
 * Asks the server for material to open one connection.
 *
 * The refusals are told apart because they call for different things from the
 * user: a workspace that has switched direct mode off is a policy decision to
 * respect silently by relaying, while a revoked device is something they need to
 * know about.
 */
export async function leaseFor(
  hostId: string,
  credentialId: string | undefined,
  protocol: "ssh" | "sftp"
): Promise<DirectLease> {
  const secret = await deviceSecret();
  if (!secret) {
    throw new DirectUnavailableError(
      "device_not_enrolled",
      "This machine is not enrolled for direct connections."
    );
  }

  try {
    return await requireApi().transport.request<DirectLease>("/desktop/leases", {
      method: "POST",
      headers: { "x-onshell-device-secret": secret },
      body: JSON.stringify({ hostId, credentialId, protocol })
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : "Could not get a credential for that host.";
    throw new DirectUnavailableError(code ?? "lease_failed", message);
  }
}

/** Best-effort report of what happened; the server cannot see this connection. */
function reportState(sessionId: string, state: "opened" | "failed" | "closed", reason?: string) {
  void requireApi()
    .transport.request(`/desktop/sessions/${sessionId}/state`, {
      method: "POST",
      body: JSON.stringify({ state, reason })
    })
    .catch(() => undefined);
}

export interface OpenDirectOptions {
  hostId: string;
  credentialId?: string;
  onData(chunk: Buffer): void;
  onExit(code: number | undefined, reason?: string): void;
}

export async function openDirectSession(options: OpenDirectOptions): Promise<DirectSession> {
  const lease = await leaseFor(options.hostId, options.credentialId, "ssh");

  // Held as a buffer rather than left only as the string it arrived as, so
  // there is something concrete to overwrite once ssh2 has read it.
  const material = Buffer.from(lease.credential.material, "utf8");
  const wipe = () => material.fill(0);

  const connectConfig: ConnectConfig = {
    host: lease.host.address,
    port: lease.host.port,
    username: lease.host.username,
    ...(lease.credential.kind === "privateKey"
      ? { privateKey: material }
      : { password: material.toString("utf8") }),
    // A host that takes a long time to answer is common on a VPN; a host that
    // never answers must not leave a tab spinning for ever.
    readyTimeout: 20_000,
    keepaliveInterval: 20_000
  };

  const client = new Client();
  const title = `${lease.host.username ? `${lease.host.username}@` : ""}${lease.host.address}`;

  return new Promise<DirectSession>((resolve, reject) => {
    let settled = false;

    const fail = (code: string, message: string) => {
      wipe();
      if (settled) return;
      settled = true;
      reportState(lease.sessionId, "failed", code);
      client.end();
      reject(new DirectUnavailableError(code, message));
    };

    client.on("ready", () => {
      // The credential has done its job the moment the handshake completes.
      wipe();

      client.shell({ term: "xterm-256color", cols: 80, rows: 24 }, (error, stream: ClientChannel) => {
        if (error) return fail("shell_failed", "Connected, but the host refused to open a shell.");

        settled = true;
        reportState(lease.sessionId, "opened");

        stream.on("data", (chunk: Buffer) => options.onData(chunk));
        stream.stderr?.on("data", (chunk: Buffer) => options.onData(chunk));
        stream.on("close", (code?: number) => {
          client.end();
          reportState(lease.sessionId, "closed");
          options.onExit(code);
        });

        resolve({
          sessionId: lease.sessionId,
          title,
          write: (data) => stream.write(data),
          resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
          close: () => {
            stream.end();
            client.end();
          }
        });
      });
    });

    client.on("error", (error: Error & { level?: string }) => {
      // ssh2's error carries the attempted key on some failures, so it is
      // classified rather than forwarded.
      if (error.level === "client-authentication") {
        return fail("authentication_failed", "The host rejected that credential.");
      }
      if (error.level === "client-timeout") {
        return fail("timeout", `${lease.host.address} did not answer in time.`);
      }
      fail("connect_failed", `Could not reach ${lease.host.address}:${lease.host.port} from this machine.`);
    });

    client.on("end", wipe);
    client.on("close", wipe);

    try {
      client.connect(connectConfig);
    } catch {
      fail("connect_failed", "Could not start the connection.");
    }
  });
}
