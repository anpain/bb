import { z } from "zod";
import {
  chatImportContextSchema,
  chatImportMessageSummarySchema,
} from "@bb/server-contract";

export const chatImportSubmitChannel = "bb-desktop:chat-import:submit";
export const chatImportCloseChannel = "bb-desktop:chat-import:close";
export const chatImportPreviewChannel = "bb-desktop:chat-import:preview";
export const chatImportPreviewSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    sourceHash: z.string(),
    messages: z.array(chatImportMessageSummarySchema),
  }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);
export const chatImportSubmissionSchema = z
  .object({
    selected: z.array(z.number().int().nonnegative()).min(1).max(100),
    copyToServer: z.boolean(),
    contexts: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            context: chatImportContextSchema,
            sourceHash: z.string().optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .refine(
    (data) =>
      data.contexts.length === data.selected.length &&
      new Set(data.contexts.map((item) => item.index)).size ===
        data.selected.length &&
      data.contexts.every(
        (item) =>
          data.selected.includes(item.index) &&
          (item.context.mode === "none" || item.sourceHash !== undefined),
      ),
    "Review context for every selected chat",
  );
export const chatImportFeedbackSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});
