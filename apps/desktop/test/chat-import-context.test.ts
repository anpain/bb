import { expect, it } from "vitest";
import {
  previewChatImportContext,
  summarizeChatImportMessages,
  estimateChatImportContext,
} from "@bb/server-contract";
import { chatImportSubmissionSchema } from "../src/chat-import-ipc.js";

it("estimates only explicitly selected text and unique images without exposing source images in previews", () => {
  const messages = [
    {
      role: "user" as const,
      text: "older ".repeat(1000),
      images: ["old-image"],
    },
    {
      role: "assistant" as const,
      text: "новый ответ".repeat(100),
      timestamp: 1_700_000_000_000,
    },
    {
      role: "user" as const,
      text: "latest ".repeat(100),
      images: ["image", "image"],
    },
  ];
  expect(previewChatImportContext(messages).estimatedTextTokens).toEqual({
    min: 0,
    max: 0,
  });
  const all = previewChatImportContext(messages, { mode: "all" });
  const range = previewChatImportContext(messages, {
    mode: "range",
    startMessage: 1,
    endMessage: 3,
  });
  expect(range.messages).toBe(2);
  expect(range.images).toBe(1);
  expect(range.estimatedTextTokens.min).toBeGreaterThan(0);
  expect(range.estimatedTextTokens.max).toBeLessThan(
    all.estimatedTextTokens.max,
  );
  expect(range.estimatedTextTokens.max).toBeGreaterThan(
    range.estimatedTextTokens.min,
  );
  const summaries = summarizeChatImportMessages(messages);
  expect(
    estimateChatImportContext(summaries, {
      mode: "range",
      startMessage: 1,
      endMessage: 3,
    }),
  ).toEqual(range);
  expect(summaries[0]?.excerpt.length).toBe(200);
  expect(JSON.stringify(summaries)).not.toContain("old-image");
  expect(summaries[0]?.timestamp).toBeNull();
  expect(summaries[1]?.timestamp).toBe(messages[1]?.timestamp);
});

it("requires a reviewed context selection for every selected chat", () => {
  expect(
    chatImportSubmissionSchema.safeParse({
      selected: [1],
      copyToServer: false,
      contexts: [{ index: 1, context: { mode: "none" } }],
    }).success,
  ).toBe(true);
  expect(
    chatImportSubmissionSchema.safeParse({
      selected: [1],
      copyToServer: false,
      contexts: [{ index: 1, context: { mode: "all" } }],
    }).success,
  ).toBe(false);
  expect(
    chatImportSubmissionSchema.safeParse({
      selected: [1, 2],
      copyToServer: false,
      contexts: [
        { index: 1, context: { mode: "none" } },
        { index: 1, context: { mode: "none" } },
      ],
    }).success,
  ).toBe(false);
});
