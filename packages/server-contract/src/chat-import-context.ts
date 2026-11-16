import type {
  ChatImportContext,
  ChatImportRequest,
} from "./api/thread-import.js";
import { z } from "zod";

export const chatImportMessageSummarySchema = z.object({
  role: z.enum(["user", "assistant"]),
  excerpt: z.string(),
  timestamp: z.number().nullable(),
  characters: z.number().nonnegative(),
  tokenUnits: z.number().nonnegative(),
  images: z.array(z.number().int().nonnegative()),
});
export type ChatImportMessageSummary = z.infer<
  typeof chatImportMessageSummarySchema
>;

export function summarizeChatImportMessages(
  messages: ChatImportRequest["messages"],
): ChatImportMessageSummary[] {
  const images = new Map<string, number>();
  return messages.map((message) => {
    let tokenUnits = 8;
    for (const char of message.text)
      tokenUnits += char.codePointAt(0)! < 128 ? 0.25 : 0.5;
    return {
      role: message.role,
      excerpt: message.text.slice(0, 200),
      timestamp: message.timestamp ?? null,
      characters: message.text.length,
      tokenUnits,
      images: (message.images ?? []).map((image) => {
        let id = images.get(image);
        if (id === undefined) {
          id = images.size;
          images.set(image, id);
        }
        return id;
      }),
    };
  });
}

export function selectChatImportContext<T>(
  messages: readonly T[],
  context: ChatImportContext,
): T[] {
  if (context.mode === "none") return [];
  return context.mode === "all"
    ? [...messages]
    : messages.slice(context.startMessage, context.endMessage);
}

export function previewChatImportContext(
  messages: ChatImportRequest["messages"],
  context: ChatImportContext = { mode: "none" },
) {
  return estimateChatImportContext(
    summarizeChatImportMessages(messages),
    context,
  );
}

export function estimateChatImportContext(
  messages: readonly ChatImportMessageSummary[],
  context: ChatImportContext,
) {
  const selected = selectChatImportContext(messages, context);
  let units = 0;
  let characters = 0;
  const images = new Set<number>();
  for (const message of selected) {
    characters += message.characters;
    units += message.tokenUnits;
    for (const image of message.images) images.add(image);
  }
  return {
    messages: selected.length,
    totalMessages: messages.length,
    characters,
    images: Math.min(images.size, 8),
    totalImages: images.size,
    estimatedTextTokens:
      selected.length === 0
        ? { min: 0, max: 0 }
        : {
            min: Math.ceil((units + 600) * 0.75),
            max: Math.ceil((units + 600) * 1.5),
          },
    mayExceedModelContext: characters > 120_000,
  };
}
