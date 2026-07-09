import net from "node:net";
import type { RuntimeConfig } from "@onshell/config";
import { getGatewaySession } from "../registry.js";

function encodeElement(value: string) {
  return `${value.length}.${value}`;
}

function encodeInstruction(opcode: string, params: string[] = []) {
  return `${[opcode, ...params].map(encodeElement).join(",")};`;
}

function parseInstruction(buffer: string) {
  const elements: string[] = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    const dot = buffer.indexOf(".", cursor);
    if (dot === -1) break;

    const length = Number.parseInt(buffer.slice(cursor, dot), 10);
    if (!Number.isFinite(length)) break;

    const start = dot + 1;
    const value = buffer.slice(start, start + length);
    elements.push(value);

    cursor = start + length;
    const separator = buffer[cursor];
    cursor += 1;
    if (separator === ";") break;
  }

  return {
    opcode: elements[0],
    params: elements.slice(1)
  };
}

function valueForArg(name: string, metadata: Record<string, unknown>) {
  const map: Record<string, string> = {
    hostname: String(metadata.address ?? ""),
    port: String(metadata.port ?? 3389),
    username: String(metadata.username ?? ""),
    password: String(metadata.password ?? ""),
    domain: String(metadata.domain ?? ""),
    security: String(metadata.security ?? "any"),
    "ignore-cert": "true",
    "enable-wallpaper": "false",
    "enable-theming": "false",
    "enable-font-smoothing": "true",
    "enable-full-window-drag": "false",
    "enable-desktop-composition": "false"
  };

  return map[name] ?? "";
}

export function createGuacdTunnel(
  sessionId: string,
  config: RuntimeConfig,
  onDisplayData: (chunk: Buffer) => void,
  onError: (error: Error) => void,
  onClose: () => void
) {
  const session = getGatewaySession(sessionId);
  if (!session || session.protocol !== "rdp") {
    throw new Error("RDP session not found");
  }

  const socket = net.connect({
    host: config.guacdHost,
    port: config.guacdPort
  });
  const metadata = session.metadata ?? {};
  let handshakeBuffer = "";
  let handshakeComplete = false;

  socket.on("connect", () => {
    socket.write(encodeInstruction("select", ["rdp"]));
  });

  socket.on("error", onError);
  socket.on("close", onClose);

  socket.on("data", (chunk) => {
    if (handshakeComplete) {
      onDisplayData(chunk);
      return;
    }

    handshakeBuffer += chunk.toString("utf8");
    if (!handshakeBuffer.includes(";")) return;

    const instruction = parseInstruction(handshakeBuffer);
    if (instruction.opcode !== "args") return;

    const width = String(metadata.width ?? 1280);
    const height = String(metadata.height ?? 720);
    const dpi = "96";
    socket.write(encodeInstruction("size", [width, height, dpi]));
    socket.write(encodeInstruction("audio", []));
    socket.write(encodeInstruction("video", []));
    socket.write(encodeInstruction("image", ["image/png", "image/jpeg"]));
    socket.write(encodeInstruction("connect", instruction.params.map((name) => valueForArg(name, metadata))));
    handshakeComplete = true;
  });

  return socket;
}
