import { z } from "zod";
import { threadEventSchema, rawThreadIdSchema } from "@bb/domain";

export const threadTransferPacketSchema = z
  .object({
    version: z.literal(1),
    transferId: z.string().min(1).max(256),
    threadId: rawThreadIdSchema,
    providerThreadId: z.string().uuid(),
    projectId: z.string().min(1),
    sourceProjectId: z.string().min(1),
    projectName: z.string().min(1),
    title: z.string().nullable(),
    model: z.string().nullable(),
    reasoningLevel: z.string().nullable(),
    sourceSequence: z.number().int().nonnegative(),
    events: z
      .array(
        z
          .object({
            event: threadEventSchema,
            createdAt: z.number().nonnegative(),
          })
          .strict(),
      )
      .max(100_000),
  })
  .strict()
  .refine((packet) => {
    const identity = packet.events
      .slice()
      .reverse()
      .find(({ event }) => event.type === "thread/identity")?.event;
    return (
      identity?.type === "thread/identity" &&
      identity.providerThreadId === packet.providerThreadId
    );
  }, "The native session must match the last thread identity")
  .refine(
    (packet) =>
      packet.events.every(
        ({ event }) =>
          !("threadId" in event) || event.threadId === packet.threadId,
      ),
    "Transfer events must belong to the selected thread",
  );
export type ThreadTransferPacket = z.infer<typeof threadTransferPacketSchema>;
export const threadTransferRequestSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("export"), threadId: rawThreadIdSchema })
    .strict(),
  z
    .object({
      action: z.literal("prepare"),
      packet: threadTransferPacketSchema,
      targetPath: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal("apply"),
      packet: threadTransferPacketSchema,
      targetPath: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("cancel"),
      threadId: rawThreadIdSchema,
      transferId: z.string().min(1),
    })
    .strict(),
]);
export type ThreadTransferRequest = z.infer<typeof threadTransferRequestSchema>;
export const threadTransferLocationSchema = z
  .object({
    hostId: z.string().min(1),
    projectPath: z.string().min(1),
    nativeRoot: z.string().min(1),
    storagePath: z.string().min(1),
  })
  .strict();
export const threadTransferResponseSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("export"),
      packet: threadTransferPacketSchema,
      location: threadTransferLocationSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("prepare"),
      projectId: z.string().min(1),
      location: threadTransferLocationSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("apply"),
      threadId: rawThreadIdSchema,
      projectId: z.string().min(1),
    })
    .strict(),
  z.object({ action: z.literal("cancel"), ok: z.literal(true) }).strict(),
]);
export type ThreadTransferResponse = z.infer<
  typeof threadTransferResponseSchema
>;
