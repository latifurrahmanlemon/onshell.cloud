import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { prisma } from "../../lib/prisma.js";
import { toPublicUser } from "../../lib/prisma-mappers.js";
import { handleRouteError } from "../../lib/reply.js";
import { createAudit } from "./auth.js";

// Avatars are stored inline as a base64 data URL (the client resizes to a small
// square before upload). Cap the payload so the MEDIUMTEXT column and request
// body stay reasonable — ~1.5MB of base64 is roughly a 1MB image.
const AVATAR_MAX_LENGTH = 1_500_000;
const AVATAR_DATA_URL = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

// Accent is a preset key (lowercase word) or a "#rrggbb" / "#rgb" hex.
const ACCENT_PATTERN = /^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})|[a-z]{2,20})$/;

const themePreferenceSchema = z
  .object({
    mode: z.enum(["light", "dark"]).optional(),
    accent: z.string().regex(ACCENT_PATTERN).optional()
  })
  .strict();

const updateProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    // "" or null clears the avatar; a data URL sets it.
    avatarUrl: z
      .string()
      .max(AVATAR_MAX_LENGTH)
      .refine((value) => value === "" || AVATAR_DATA_URL.test(value), {
        message: "avatar_must_be_image_data_url"
      })
      .nullable()
      .optional(),
    // null clears the saved theme; an object stores mode/accent.
    themePreference: themePreferenceSchema.nullable().optional()
  })
  .refine(
    (body) => body.name !== undefined || body.avatarUrl !== undefined || body.themePreference !== undefined,
    { message: "no_changes" }
  );

export async function registerProfileRoutes(app: FastifyInstance, config: RuntimeConfig) {
  app.patch("/profile", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request, config);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const body = updateProfileSchema.parse(request.body);

      const data: Prisma.UserUpdateInput = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.avatarUrl !== undefined) data.avatarUrl = body.avatarUrl ? body.avatarUrl : null;
      if (body.themePreference !== undefined) {
        data.themePreference = body.themePreference ?? Prisma.JsonNull;
      }

      const updated = await prisma.user.update({
        where: { id: user.id },
        data,
        include: { memberships: true }
      });

      // Keep the membership for the active organization first so toPublicUser
      // resolves the same role/org the caller is authenticated against.
      const memberships = [...updated.memberships].sort(
        (a, b) =>
          Number(b.organizationId === user.organizationId) - Number(a.organizationId === user.organizationId)
      );

      await createAudit({
        organizationId: user.organizationId,
        actorId: user.id,
        action: "profile.update",
        targetType: "user",
        targetId: user.id,
        ipAddress: request.ip,
        metadata: { fields: Object.keys(data) }
      });

      return { user: toPublicUser({ ...updated, memberships }) };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });
}
