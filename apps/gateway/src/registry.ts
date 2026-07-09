import { randomUUID } from "node:crypto";
import type { SessionProtocol, SessionStatus } from "@onshell/shared";

export interface GatewaySession {
  id: string;
  protocol: SessionProtocol;
  hostId: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  websocketPath?: string;
  metadata?: Record<string, unknown>;
}

const sessions = new Map<string, GatewaySession>();

export function createGatewaySession(input: Omit<GatewaySession, "id" | "createdAt" | "updatedAt" | "status">) {
  const now = new Date().toISOString();
  const session: GatewaySession = {
    id: `gw_${randomUUID()}`,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ...input
  };

  sessions.set(session.id, session);
  return session;
}

export function getGatewaySession(id: string) {
  return sessions.get(id);
}

export function listGatewaySessions() {
  return [...sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateGatewaySession(id: string, patch: Partial<GatewaySession>) {
  const session = sessions.get(id);
  if (!session) return undefined;

  const updated: GatewaySession = {
    ...session,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  sessions.set(id, updated);
  return updated;
}

