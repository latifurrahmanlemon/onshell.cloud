/**
 * The relayed path: the same one the browser console uses.
 *
 * `POST /sessions` has the API decrypt the credential and hand it to the
 * gateway, which holds the SSH connection; this process then speaks to the
 * gateway over a WebSocket and moves bytes. Onshell is on the wire here, and
 * that is the deliberate trade — it is what reaches hosts this machine has no
 * route to, agent machines, and RDP.
 *
 * The framing is the gateway's, documented at the top of
 * apps/gateway/src/routes.ts: text frames are terminal output, JSON control
 * frames go the other way for resize and explicit input.
 */
import WebSocket from "ws";
import { requireApi } from "./session.js";

export interface RelaySession {
  sessionId: string;
  title: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface OpenRelayOptions {
  hostId: string;
  credentialId?: string;
  shell?: string;
  title: string;
  onData(chunk: string): void;
  onExit(reason?: string): void;
}

export async function openRelaySession(options: OpenRelayOptions): Promise<RelaySession> {
  const client = requireApi();
  const { session, websocketUrl } = await client.openSession({
    hostId: options.hostId,
    protocol: "ssh",
    credentialId: options.credentialId,
    shell: options.shell
  });

  if (!websocketUrl) throw new Error("The server did not offer a terminal connection for that host.");

  const socket = new WebSocket(websocketUrl);

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      socket.off("error", onError);
      resolve();
    };
    const onError = () => {
      socket.off("open", onOpen);
      // Deliberately not the underlying message: a failed WebSocket upgrade
      // reports as a bare status code that means nothing to the person reading
      // it, and the actionable part is which end could not be reached.
      reject(new Error("Could not reach the Onshell gateway."));
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });

  socket.on("message", (data: WebSocket.RawData) => {
    const text = data.toString("utf8");
    // The gateway's first frame is a JSON control frame; everything after it is
    // raw terminal output that must be passed through untouched, including any
    // output that happens to look like JSON.
    if (text.startsWith('{"type":"system"')) {
      try {
        const control = JSON.parse(text) as { data?: string };
        if (control.data) options.onData(`\x1b[90m${control.data}\x1b[0m\r\n`);
        return;
      } catch {
        // Not actually a control frame. Fall through and print it.
      }
    }
    options.onData(text);
  });

  socket.on("close", () => options.onExit());
  socket.on("error", () => options.onExit("The connection to the gateway was lost."));

  return {
    sessionId: session.id,
    title: options.title,
    write: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    resize: (cols, rows) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    },
    close: () => {
      socket.close();
      // The gateway session outlives the socket unless it is closed explicitly,
      // and a leaked session counts against the workspace's concurrency limit.
      void client.closeSession(session.id).catch(() => undefined);
    }
  };
}
