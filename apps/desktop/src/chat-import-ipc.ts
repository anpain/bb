import { z } from "zod";

export const chatImportSubmitChannel = "bb-desktop:chat-import:submit";
export const chatImportCloseChannel = "bb-desktop:chat-import:close";
export const chatImportSubmissionSchema = z
  .object({
    selected: z.array(z.number().int().nonnegative()).min(1).max(100),
    copyToServer: z.boolean(),
  })
  .strict();
export const chatImportFeedbackSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});
