import { readFile, stat } from "node:fs/promises";
import type { Command } from "commander";
import {
  chatImportMaxBytes,
  chatImportRequestSchema,
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
    .description("Import one Codex or Kimi transcript JSON into Personal")
    .option("--json", "Print the result as JSON")
    .action(
      action(async (file: string, options: { json?: boolean }) => {
        const source = await stat(file);
        if (!source.isFile() || source.size > chatImportMaxBytes) {
          throw new Error("Choose a chat JSON file of at most 8 MiB.");
        }
        const payload: unknown = JSON.parse(await readFile(file, "utf8"));
        const chat = chatImportRequestSchema.parse(payload);
        const result = await createCliBbSdk(getUrl()).threads.importChat(chat);
        if (!outputJson(options, result)) {
          console.log(
            `${result.alreadyImported ? "Already imported" : "Imported"}: ${result.threadId}`,
          );
        }
      }),
    );
}
