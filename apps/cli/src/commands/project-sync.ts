import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import {
  createNodeBbSdk,
  experimental_syncWorkspacePair,
  experimental_watchWorkspacePair,
} from "@bb/sdk/node";
import { action } from "../action.js";
import { outputJson } from "./helpers.js";

export function registerProjectSyncCommand(
  project: Command,
  getUrl: () => string,
): void {
  project
    .command("sync <source-path>")
    .description(
      "Mirror a project directory between two bb servers without overwriting conflicts",
    )
    .requiredOption("--to-server <url>", "Other bb server URL")
    .requiredOption(
      "--target-path <path>",
      "Absolute directory on the other server",
    )
    .option(
      "--source-host <id>",
      "Source machine (defaults to the source server's primary machine)",
    )
    .option(
      "--target-host <id>",
      "Target machine (defaults to the target server's primary machine)",
    )
    .option(
      "--state <path>",
      "Local synchronization state file, outside both project folders",
    )
    .option("--watch", "Synchronize on file changes until interrupted")
    .option("--json", "Print synchronization summaries as JSON")
    .action(
      action(
        async (
          sourcePath: string,
          options: {
            toServer: string;
            targetPath: string;
            sourceHost?: string;
            targetHost?: string;
            state?: string;
            watch?: boolean;
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
          const [sourceConfig, targetConfig] = await Promise.all([
            source.system.config(),
            target.system.config(),
          ]);
          const sourceHost = options.sourceHost ?? sourceConfig.primaryHostId;
          const targetHost = options.targetHost ?? targetConfig.primaryHostId;
          if (!sourceHost || !targetHost)
            throw new Error(
              "Both servers must have a primary execution machine",
            );
          if (sourceHost === targetHost && sourcePath === options.targetPath)
            throw new Error("Choose two different project folders");
          const identity = JSON.stringify([
            sourceHost,
            sourcePath,
            targetHost,
            options.targetPath,
          ]);
          const key = createHash("sha256").update(identity).digest("hex");
          const statePath =
            options.state ??
            join(homedir(), ".bb", "workspace-sync", `${key}.json`);
          const controller = new AbortController();
          const stop = () => controller.abort();
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
          let first = true;
          let lastProgress = 0;
          try {
            const onResult = (
              result: Awaited<
                ReturnType<typeof experimental_syncWorkspacePair>
              >,
            ) => {
              const summary = {
                copied: result.copied,
                removed: result.removed,
                statePath,
              };
              if (first || result.copied || result.removed || options.json) {
                if (!outputJson(options, summary))
                  console.log(
                    `Synchronized: ${result.copied} files copied, ${result.removed} files removed. State: ${statePath}`,
                  );
              }
              first = false;
            };
            const args = {
              identity,
              statePath,
              signal: controller.signal,
              onProgress: options.json
                ? undefined
                : (value) => {
                    if (
                      Date.now() - lastProgress < 1000 &&
                      value.stage !== "complete"
                    )
                      return;
                    lastProgress = Date.now();
                    console.error(
                      `${value.stage}: ${value.completedFiles}/${value.totalFiles} files, ${value.bytes}/${value.totalBytes} bytes${value.path ? ` · ${value.path}` : ""}`,
                    );
                  },
              left: {
                rootPath: sourcePath,
                call: (operation, signal) =>
                  source.files.experimental_sync(
                    { hostId: sourceHost, operation },
                    signal,
                  ),
              },
              right: {
                rootPath: options.targetPath,
                call: (operation, signal) =>
                  target.files.experimental_sync(
                    { hostId: targetHost, operation },
                    signal,
                  ),
              },
            } satisfies Parameters<typeof experimental_syncWorkspacePair>[0];
            if (options.watch)
              await experimental_watchWorkspacePair({ ...args, onResult });
            else onResult(await experimental_syncWorkspacePair(args));
          } catch (error) {
            if (!controller.signal.aborted) throw error;
          } finally {
            process.removeListener("SIGINT", stop);
            process.removeListener("SIGTERM", stop);
          }
        },
      ),
    );
}
