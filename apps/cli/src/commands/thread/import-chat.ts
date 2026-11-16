import { readFile, stat } from "node:fs/promises";
import type { Command } from "commander";
import {
  chatImportMaxBytes,
  chatImportRequestSchema,
  previewChatImportContext,
} from "@bb/server-contract";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { outputJson } from "../helpers.js";

export function registerImportChatCommand(
  thread: Command,
  getUrl: () => string,
): void {
  thread
    .command("import-chat <file>")
    .description("Import or refresh a Codex or Kimi transcript JSON")
    .option("--json", "Print the result as JSON")
    .option(
      "--preview",
      "Estimate selected context tokens without importing or calling a model",
    )
    .action(
      action(
        async (
          file: string,
          options: { json?: boolean; preview?: boolean },
        ) => {
          const source = await stat(file);
          if (!source.isFile() || source.size > chatImportMaxBytes) {
            throw new Error("Choose a chat JSON file of at most 8 MiB.");
          }
          const payload: unknown = JSON.parse(await readFile(file, "utf8"));
          const chat = chatImportRequestSchema.parse(payload);
          const preview = previewChatImportContext(chat.messages, chat.context);
          if (options.preview) {
            if (!outputJson(options, preview))
              console.log(
                `${preview.messages} of ${preview.totalMessages} messages; approximately ${preview.estimatedTextTokens.min}–${preview.estimatedTextTokens.max} text tokens + ${preview.images} images on first continuation. Importing uses no model tokens. Exact usage depends on the model; image tokens and replies are excluded.`,
              );
            return;
          }
          const result =
            await createCliBbSdk(getUrl()).threads.importChat(chat);
          if (!outputJson(options, result)) {
            console.log(
              `${result.alreadyImported ? "Already imported" : "Imported"}: ${result.threadId}`,
            );
            console.log(
              chat.context?.mode && chat.context.mode !== "none"
                ? `Chosen history will use input tokens on first continuation (rough text estimate ${preview.estimatedTextTokens.min}–${preview.estimatedTextTokens.max}, plus images).`
                : "History saved for viewing. Imported context will not be sent to the model.",
            );
          }
        },
      ),
    );
}
