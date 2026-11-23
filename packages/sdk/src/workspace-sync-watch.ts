import { setTimeout as delay } from "node:timers/promises";
import { experimental_syncWorkspacePair } from "./workspace-sync-state.js";

export async function experimental_watchWorkspacePair(
  args: Parameters<typeof experimental_syncWorkspacePair>[0] & {
    onResult?(
      result: Awaited<ReturnType<typeof experimental_syncWorkspacePair>>,
    ): void;
  },
): Promise<void> {
  const controller = new AbortController();
  const externalSignal = args.signal ?? new AbortController().signal;
  const signal = AbortSignal.any([externalSignal, controller.signal]);
  let dirty = true;
  let wake: (() => void) | null = null;
  const request = () => {
    dirty = true;
    wake?.();
  };
  const synchronize = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await experimental_syncWorkspacePair({ ...args, signal });
      } catch (error) {
        const transient =
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "sync_source_changed");
        if (!transient || attempt >= 4 || signal.aborted) throw error;
        await delay(250, undefined, { signal });
      }
    }
  };
  const watch = async (endpoint: typeof args.left, revision: string) => {
    while (!signal.aborted) {
      const next = await endpoint.call(
        { action: "watch", rootPath: endpoint.rootPath, revision },
        signal,
      );
      if (next.action !== "watch")
        throw new Error(
          "This server does not support immediate workspace synchronization",
        );
      if (revision !== next.revision) {
        revision = next.revision;
        request();
      }
    }
  };
  const worker = async () => {
    while (!signal.aborted) {
      if (!dirty) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            signal.removeEventListener("abort", finish);
            wake = null;
            resolve();
          };
          wake = finish;
          signal.addEventListener("abort", finish, { once: true });
          if (dirty || signal.aborted) finish();
        });
      }
      await delay(250, undefined, { signal });
      dirty = false;
      const result = await synchronize();
      args.onResult?.(result);
    }
  };
  const safety = setInterval(request, 60_000);
  let tasks: Promise<void>[] = [];
  try {
    const initial = await synchronize();
    args.onResult?.(initial);
    if (Object.keys(initial.baseline).length === 0) {
      await Promise.all(
        [args.left, args.right].map(async (endpoint) => {
          const result = await endpoint.call(
            { action: "mkdir_root", rootPath: endpoint.rootPath },
            signal,
          );
          if (result.action !== "mkdir_root")
            throw new Error(
              "This server cannot initialize an empty project mirror",
            );
        }),
      );
    }
    const revisions = await Promise.all(
      [args.left, args.right].map(async (endpoint) => {
        const result = await endpoint.call(
          { action: "watch", rootPath: endpoint.rootPath, revision: null },
          signal,
        );
        if (result.action !== "watch")
          throw new Error(
            "This server does not support immediate workspace synchronization",
          );
        return result.revision;
      }),
    );
    tasks = [
      watch(args.left, revisions[0]!),
      watch(args.right, revisions[1]!),
      worker(),
    ];
    await Promise.all(tasks);
  } catch (error) {
    if (!externalSignal.aborted) throw error;
  } finally {
    controller.abort();
    clearInterval(safety);
    request();
    await Promise.allSettled(tasks);
  }
}
