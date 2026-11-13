import { z } from "zod";

export const chatImportMaxBytes = 8 * 1024 * 1024;
export const chatImportProviderSchema = z.enum(["codex", "acp-kimi"]);
export const chatImportRequestSchema = z
  .object({
    providerId: chatImportProviderSchema,
    sourceId: z.string().min(1).max(256),
    title: z.string().trim().min(1).max(200),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            text: z.string().min(1).max(chatImportMaxBytes),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict()
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
