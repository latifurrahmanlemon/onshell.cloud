import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

/** A retry keeps the same row ID, scoped to the authenticated account/workspace. */
export function offlineEntityId(
  request: Pick<FastifyRequest, "headers">,
  actor: { id: string; organizationId: string },
) {
  const value = request.headers["x-onshell-offline-id"];
  if (value === undefined) return undefined;
  const nonce = z.string().uuid().parse(value);
  const organization = request.headers["x-onshell-offline-organization"];
  if (organization !== undefined)
    z.literal(actor.organizationId).parse(organization);
  return `offline-${createHash("sha256")
    .update(JSON.stringify([actor.organizationId, actor.id, nonce]))
    .digest("hex")
    .slice(0, 40)}`;
}
