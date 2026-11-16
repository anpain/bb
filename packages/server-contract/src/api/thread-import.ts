import { z } from "zod";

export const chatImportMaxBytes = 8 * 1024 * 1024;
export const chatImportProviderSchema = z.enum(["codex", "acp-kimi"]);
export const chatImportContextSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("all") }).strict(),
  z
    .object({
      mode: z.literal("range"),
      startMessage: z.number().int().nonnegative(),
      endMessage: z.number().int().positive(),
    })
    .strict()
    .refine(
      (range) => range.startMessage < range.endMessage,
      "Choose a non-empty context range",
    ),
]);
export type ChatImportContext = z.infer<typeof chatImportContextSchema>;
export const chatImportRequestSchema = z
  .object({
    providerId: chatImportProviderSchema,
    sourceId: z.string().min(1).max(256),
    title: z.string().trim().min(1).max(200),
    projectId: z.string().min(1).optional(),
    context: chatImportContextSchema.optional(),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            text: z.string().min(1).max(chatImportMaxBytes),
            timestamp: z
              .number()
              .int()
              .nonnegative()
              .max(253_402_300_799_999)
              .optional(),
            images: z
              .array(z.string().min(1).max(chatImportMaxBytes))
              .max(100)
              .optional(),
          })
          .strict()
          .refine(
            (message) => message.role === "user" || !message.images?.length,
            "Image attachments must belong to user messages",
          ),
      )
      .min(1)
      .max(10_000),
  })
  .strict()
  .refine(
    (chat) =>
      chat.context?.mode !== "range" ||
      chat.context.endMessage <= chat.messages.length,
    "Context range exceeds the chat history",
  )
  .refine(
    (chat) =>
      chat.messages.reduce((size, message) => size + message.text.length, 0) <=
      chatImportMaxBytes,
    "Chat history exceeds the import limit",
  );
export type ChatImportRequest = z.infer<typeof chatImportRequestSchema>;

export const chatImportResponseSchema = z.object({
  threadId: z.string().min(1),
  alreadyImported: z.boolean(),
});
export type ChatImportResponse = z.infer<typeof chatImportResponseSchema>;
