/**
 * The loopback listener: a browser on *this* machine talking straight to the
 * agent, with no round trip through our infrastructure.
 *
 * Worth being precise about what this is and is not. It is an optimisation —
 * zero added latency, no bandwidth cost, and the keystrokes never leave the
 * computer. It is *not* the design: Safari refuses `ws://127.0.0.1` from an
 * https page, Chrome's Private Network Access rules around it have tightened
 * repeatedly, and corporate endpoint software blocks loopback listeners
 * outright. So everything here is allowed to fail, and the tunnel carries the
 * session when it does.
 *
 * Security rests on two things. A ticket, minted by the gateway only for a
 * session the API already authorised, single-use and short-lived — because any
 * process on this machine can reach this port, so being reachable cannot be
 * enough. And an origin allowlist, because any *website* the user visits can
 * also reach it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { LOCAL_PORTS, LOCAL_TICKET_TTL_MS } from "@onshell/agent-protocol";
import { WebSocketServer, type WebSocket } from "ws";
import type { ResolvedShell } from "./shells.js";

export interface LocalTicket {
  shell?: string;
  cwd?: string;
  expiresAt: number;
}

export interface LocalServerHooks {
  /** Opens a terminal for a redeemed ticket and pumps it over `socket`. */
  attach(socket: WebSocket, ticket: LocalTicket): Promise<void>;
}

/**
 * Origins allowed to talk to this listener.
 *
 * Without this, any page the user happens to open could probe for the agent and
 * try to redeem a ticket. It is not a strong boundary on its own — an origin
 * header is only as honest as the browser sending it — which is why the ticket
 * does the real work.
 */
function allowedOrigins() {
  const configured = process.env.ONSHELL_SITE_URL;
  return new Set(
    [configured, "https://onshell.cloud", "https://www.onshell.cloud", "http://localhost:3000"].filter(
      (origin): origin is string => typeof origin === "string" && origin.length > 0
    )
  );
}

function constantTimeEquals(a: string, b: string) {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class LocalServer {
  private server?: Server;
  private wss?: WebSocketServer;
  private readonly tickets = new Map<string, LocalTicket>();
  private readonly origins = allowedOrigins();

  port?: number;

  constructor(
    private readonly deviceId: string,
    private readonly agentVersion: string,
    private readonly shells: ResolvedShell[],
    private readonly hooks: LocalServerHooks,
    private readonly log: (message: string, detail?: Record<string, unknown>) => void
  ) {}

  /**
   * Binds the first free port in the range, or gives up quietly.
   *
   * A machine that will not let us listen is normal, not exceptional, so this
   * resolves to `undefined` rather than throwing — the agent carries on with
   * the tunnel and never mentions it again.
   */
  async start(): Promise<number | undefined> {
    for (const port of LOCAL_PORTS) {
      const bound = await this.listen(port);
      if (bound) {
        this.port = port;
        this.log("loopback listener started", { port });
        return port;
      }
    }

    this.log("no loopback port available — sessions will use the tunnel");
    return undefined;
  }

  private listen(port: number) {
    return new Promise<boolean>((resolve) => {
      const server = createServer((request, response) => this.handleHttp(request, response));
      const wss = new WebSocketServer({ noServer: true });

      server.on("upgrade", (request, socket, head) => {
        if (!this.isAllowedOrigin(request) || !new URL(request.url ?? "/", "http://127.0.0.1").pathname.endsWith("/session")) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (client) => this.handleSocket(client, request));
      });

      server.once("error", () => {
        server.close();
        resolve(false);
      });

      // 127.0.0.1 explicitly, never 0.0.0.0: this must not become a way onto
      // the machine from the network it happens to be sitting on.
      server.listen(port, "127.0.0.1", () => {
        this.server = server;
        this.wss = wss;
        resolve(true);
      });
    });
  }

  private isAllowedOrigin(request: IncomingMessage) {
    const origin = request.headers.origin;
    // A missing Origin is a non-browser caller — curl, another local program —
    // which the ticket still gates. Only a *wrong* origin is refused outright.
    return origin === undefined || this.origins.has(origin);
  }

  private applyCors(request: IncomingMessage, response: ServerResponse) {
    const origin = request.headers.origin;
    if (origin && this.origins.has(origin)) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "origin");
    }
    // Chrome requires this before a page on a public origin may reach a private
    // address; without it the preflight fails and the fast path never starts.
    if (request.headers["access-control-request-private-network"] === "true") {
      response.setHeader("access-control-allow-private-network", "true");
    }
    response.setHeader("access-control-allow-headers", "content-type");
    response.setHeader("access-control-max-age", "600");
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse) {
    this.applyCors(request, response);

    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path !== "/onshell/hello") {
      response.writeHead(404).end();
      return;
    }
    if (!this.isAllowedOrigin(request)) {
      response.writeHead(403).end();
      return;
    }

    // Identifying, but not sensitive: the browser needs the device id to be
    // sure the agent it just found is the machine it was told to expect, and
    // the response is unreadable to any origin outside the allowlist.
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        deviceId: this.deviceId,
        agentVersion: this.agentVersion,
        platform: process.platform,
        shells: this.shells.map(({ token, label, default: isDefault }) => ({ token, label, default: isDefault }))
      })
    );
  }

  private async handleSocket(socket: WebSocket, request: IncomingMessage) {
    const presented = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("ticket");
    const ticket = presented ? this.redeem(presented) : undefined;
    if (!ticket) {
      socket.close(1008, "Unauthorized");
      return;
    }

    try {
      await this.hooks.attach(socket, ticket);
    } catch (error) {
      this.log(`loopback session failed — ${String(error)}`);
      socket.close(1011, "Session failed");
    }
  }

  /** Registers a ticket the gateway just handed out. */
  expect(ticket: string, detail: { shell?: string; cwd?: string; expiresInMs: number }) {
    this.sweep();
    this.tickets.set(ticket, {
      shell: detail.shell,
      cwd: detail.cwd,
      expiresAt: Date.now() + Math.min(detail.expiresInMs, LOCAL_TICKET_TTL_MS)
    });
  }

  /**
   * Consumes a ticket. Single use: a redeemed ticket is gone whether or not the
   * session that follows succeeds, so a leaked one cannot be replayed.
   */
  private redeem(presented: string) {
    this.sweep();

    for (const [issued, ticket] of this.tickets) {
      if (!constantTimeEquals(issued, presented)) continue;
      this.tickets.delete(issued);
      return ticket;
    }

    return undefined;
  }

  private sweep() {
    const now = Date.now();
    for (const [issued, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(issued);
    }
  }

  stop() {
    this.tickets.clear();
    this.wss?.close();
    this.server?.close();
    this.server = undefined;
  }
}
