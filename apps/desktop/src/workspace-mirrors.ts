import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  experimental_syncWorkspacePair,
  experimental_watchWorkspacePair,
  type BbSdk,
} from "@bb/sdk/node";

const sideSchema = z
  .object({
    serverId: z.string().min(1),
    hostId: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();
const mirrorSchema = z
  .object({ identity: z.string().min(1), left: sideSchema, right: sideSchema })
  .strict();
const mirrorsSchema = z.array(mirrorSchema).max(100);
type Mirror = z.infer<typeof mirrorSchema>;

export function createWorkspaceMirrors(options: {
  dataDir: string;
  client(serverId: string): Promise<BbSdk>;
  onError(message: string): void;
}) {
  const stateDir = join(options.dataDir, "workspace-sync");
  const configPath = join(stateDir, "mirrors.json");
  let mirrors: Mirror[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller = new AbortController();
  let work: Promise<void> | null = null;
  let selected: string | null = null;
  let reportedError: string | null = null;
  const load = async () => {
    if (mirrors !== null) return mirrors;
    try {
      mirrors = mirrorsSchema.parse(
        JSON.parse(await fs.readFile(configPath, "utf8")),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        mirrors = [];
      else throw error;
    }
    return mirrors;
  };
  const run = async (serverId: string, signal: AbortSignal, watch = false) => {
    const group = new AbortController();
    signal = AbortSignal.any([signal, group.signal]);
    let tasks: Promise<void>[] = [];
    try {
      tasks = (await load())
        .filter(
          (mirror) =>
            mirror.left.serverId === serverId ||
            mirror.right.serverId === serverId,
        )
        .map(async (mirror) => {
          const [left, right] = await Promise.all([
            options.client(mirror.left.serverId),
            options.client(mirror.right.serverId),
          ]);
          const [leftConfig, rightConfig] = await Promise.all([
            left.system.config({ signal }),
            right.system.config({ signal }),
          ]);
          if (
            leftConfig.primaryHostId !== mirror.left.hostId ||
            rightConfig.primaryHostId !== mirror.right.hostId
          )
            throw new Error(
              "A saved server now identifies a different machine. Synchronization stopped.",
            );
          await (
            watch
              ? experimental_watchWorkspacePair
              : experimental_syncWorkspacePair
          )({
            identity: mirror.identity,
            statePath: join(
              stateDir,
              `${createHash("sha256").update(mirror.identity).digest("hex")}.json`,
            ),
            signal,
            left: {
              rootPath: mirror.left.path,
              call: (operation, signal) =>
                left.files.experimental_sync(
                  { hostId: mirror.left.hostId, operation },
                  signal,
                ),
            },
            right: {
              rootPath: mirror.right.path,
              call: (operation, signal) =>
                right.files.experimental_sync(
                  { hostId: mirror.right.hostId, operation },
                  signal,
                ),
            },
          });
        });
      await Promise.all(tasks);
    } finally {
      group.abort();
      await Promise.allSettled(tasks);
    }
  };
  const schedule = (delay = 0) => {
    if (selected === null || selected === "builtin") return;
    timer = setTimeout(() => {
      timer = null;
      if (selected === null) return;
      const signal = controller.signal;
      work = run(selected, signal, true)
        .then(() => {
          reportedError = null;
        })
        .catch((error: unknown) => {
          if (signal.aborted) return;
          const message =
            error instanceof Error
              ? error.message
              : "Workspace synchronization failed";
          if (reportedError !== message) options.onError(message);
          reportedError = message;
        })
        .finally(() => {
          work = null;
          if (!signal.aborted) schedule(5_000);
        });
    }, delay);
  };
  return {
    stateDir,
    async remember(mirror: Mirror) {
      const records = await load();
      const parsed = mirrorSchema.parse(mirror);
      const next = [
        ...records.filter((item) => item.identity !== parsed.identity),
        parsed,
      ];
      mirrorsSchema.parse(next);
      await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
      const temporary = `${configPath}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(next), {
        mode: 0o600,
        flush: true,
      });
      await fs.rename(temporary, configPath);
      mirrors = next;
    },
    start(serverId: string) {
      if (timer !== null) clearTimeout(timer);
      controller.abort();
      controller = new AbortController();
      selected = serverId;
      schedule();
    },
    async stop(finalSync = false) {
      const previous = selected;
      selected = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      controller.abort();
      await work;
      if (finalSync && previous !== null && previous !== "builtin") {
        try {
          await run(previous, AbortSignal.timeout(15_000));
        } catch (error) {
          options.onError(
            error instanceof Error
              ? error.message
              : "Final synchronization failed",
          );
        }
      }
    },
  };
}
