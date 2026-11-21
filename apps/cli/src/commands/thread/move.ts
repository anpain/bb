import { join } from "node:path";
import { homedir } from "node:os";
import type { Command } from "commander";
import { createNodeBbSdk, experimental_moveThread } from "@bb/sdk/node";
import { action } from "../../action.js";
import { outputJson } from "../helpers.js";

export function registerMoveThreadCommand(
  thread: Command,
  getUrl: () => string,
): void {
  thread
    .command("move <id>")
    .description(
      "Move an idle native Codex thread and its project to another bb server",
    )
    .requiredOption(
      "--to-server <url>",
      "Target bb server (open its SSH forward first)",
    )
    .option(
      "--target-path <path>",
      "Absolute project folder on the target machine",
    )
    .option("--state-dir <path>", "Local synchronization state folder")
    .option("--json", "Print transfer result as JSON")
    .action(
      action(
        async (
          threadId: string,
          options: {
            toServer: string;
            targetPath?: string;
            stateDir?: string;
            json?: boolean;
          },
        ) => {
          const source = createNodeBbSdk({
            baseUrl: getUrl(),
            timeoutMs: 180_000,
          });
          const target = createNodeBbSdk({
            baseUrl: options.toServer,
            timeoutMs: 180_000,
          });
          const moved = await experimental_moveThread({
            source: { id: getUrl(), sdk: source },
            target: { id: options.toServer, sdk: target },
            threadId,
            stateDir:
              options.stateDir ?? join(homedir(), ".bb", "workspace-sync"),
            targetPath: options.targetPath,
            onProgress: options.json
              ? undefined
              : (value) => {
                  if (value.path === null) console.error(value.phase);
                },
          });
          if (!outputJson(options, moved))
            console.log(
              `Moved ${moved.threadId} to project ${moved.projectId}. The native session is ready to resume; no model was called.`,
            );
        },
      ),
    );
}
