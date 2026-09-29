import { offlineEntityId } from "../../lib/offline-id.js";
import type { FastifyInstance } from "fastify";
import type { Note, NoteRevision, Prisma } from "@prisma/client";
import { z } from "zod";
import { NOTE_COLORS } from "@onshell/shared";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { prisma } from "../../lib/prisma.js";
import { handleRouteError } from "../../lib/reply.js";

const paramsSchema = z.object({ noteId: z.string().min(1) });
const colorSchema = z.enum(NOTE_COLORS);
const titleSchema = z.string().trim().max(200);
const bodySchema = z.string().max(20000);
const createSchema = z.object({
  title: titleSchema.default(""),
  body: bodySchema.default(""),
  color: colorSchema.default("default"),
  pinned: z.boolean().default(false)
}).refine((note) => note.title.length > 0 || note.body.trim().length > 0, { message: "A note needs a title or some text." });
const patchSchema = z.object({
  title: titleSchema.optional(),
  body: bodySchema.optional(),
  color: colorSchema.optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  trashed: z.boolean().optional()
}).refine((body) => Object.values(body).some((value) => value !== undefined));

function payload(note: Note) {
  const { trashedAt, ...rest } = note;
  return { ...rest, trashed: Boolean(trashedAt), trashedAt: trashedAt?.toISOString(), createdAt: note.createdAt.toISOString(), updatedAt: note.updatedAt.toISOString() };
}

function revisionPayload(revision: NoteRevision & { actor: { name: string } }) {
  const { actor, ...rest } = revision;
  return { ...rest, actorName: actor.name, createdAt: revision.createdAt.toISOString() };
}

/** Names the change so the history reads as a timeline rather than a diff dump. */
function describeChange(before: Note, patch: z.infer<typeof patchSchema>) {
  if (patch.trashed !== undefined && patch.trashed !== Boolean(before.trashedAt)) return patch.trashed ? "trashed" : "restored";
  if (patch.archived !== undefined && patch.archived !== before.archived) return patch.archived ? "archived" : "unarchived";
  if ((patch.title !== undefined && patch.title !== before.title) || (patch.body !== undefined && patch.body !== before.body)) return "edited";
  if (patch.pinned !== undefined && patch.pinned !== before.pinned) return patch.pinned ? "pinned" : "unpinned";
  if (patch.color !== undefined && patch.color !== before.color) return "recolored";
  return undefined;
}

function snapshot(note: Note, actorId: string, action: string): Prisma.NoteRevisionUncheckedCreateInput {
  return { noteId: note.id, actorId, action, title: note.title, body: note.body, color: note.color, pinned: note.pinned, archived: note.archived, trashed: Boolean(note.trashedAt) };
}

export async function registerNoteRoutes(app: FastifyInstance) {
  app.get("/notes", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      const notes = await prisma.note.findMany({
        where: { organizationId: actor.organizationId, ownerId: actor.id },
        orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }]
      });
      return { notes: notes.map(payload) };
    } catch (error) { return handleRouteError(reply, error); }
  });

  app.post("/notes", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      const body = createSchema.parse(request.body);
      const offlineId = offlineEntityId(request, actor);
      if (offlineId) {
        const existing = await prisma.note.findFirst({ where: { id: offlineId, organizationId: actor.organizationId } });
        if (existing) return reply.code(200).send(payload(existing));
      }
      const note = await prisma.$transaction(async (tx) => {
        const created = await tx.note.create({ data: { id: offlineId, organizationId: actor.organizationId, ownerId: actor.id, ...body } });
        await tx.noteRevision.create({ data: snapshot(created, actor.id, "created") });
        return created;
      });
      return reply.code(201).send(payload(note));
    } catch (error) { return handleRouteError(reply, error); }
  });

  app.patch("/notes/:noteId", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      const { noteId } = paramsSchema.parse(request.params);
      const body = patchSchema.parse(request.body);
      const existing = await prisma.note.findFirst({ where: { id: noteId, organizationId: actor.organizationId, ownerId: actor.id } });
      if (!existing) return reply.code(404).send({ error: "note_not_found" });
      const action = describeChange(existing, body);
      if (!action) return payload(existing);
      const { trashed, ...fields } = body;
      const note = await prisma.$transaction(async (tx) => {
        const updated = await tx.note.update({
          where: { id: existing.id },
          data: { ...fields, ...(trashed !== undefined && { trashedAt: trashed ? new Date() : null }) }
        });
        await tx.noteRevision.create({ data: snapshot(updated, actor.id, action) });
        return updated;
      });
      return payload(note);
    } catch (error) { return handleRouteError(reply, error); }
  });

  app.get("/notes/:noteId/history", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      const { noteId } = paramsSchema.parse(request.params);
      const note = await prisma.note.findFirst({ where: { id: noteId, organizationId: actor.organizationId, ownerId: actor.id }, select: { id: true } });
      if (!note) return reply.code(404).send({ error: "note_not_found" });
      const revisions = await prisma.noteRevision.findMany({
        where: { noteId: note.id },
        orderBy: { createdAt: "desc" },
        take: 200,
        include: { actor: { select: { name: true } } }
      });
      return { revisions: revisions.map(revisionPayload) };
    } catch (error) { return handleRouteError(reply, error); }
  });

  /** Permanent removal; the UI only offers it from the trash. Its history goes with it. */
  app.delete("/notes/:noteId", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      const { noteId } = paramsSchema.parse(request.params);
      const deleted = await prisma.note.deleteMany({ where: { id: noteId, organizationId: actor.organizationId, ownerId: actor.id } });
      if (deleted.count === 0) return reply.code(404).send({ error: "note_not_found" });
      return { ok: true };
    } catch (error) { return handleRouteError(reply, error); }
  });
}
