import { watch, type FSWatcher } from "node:fs";
import { randomUUID } from "node:crypto";

export function createWorkspaceSyncWatch() {
  const entries = new Map<
    string,
    {
      watcher: FSWatcher;
      revision: string;
      error: Error | null;
      listeners: Set<() => void>;
      expiry: ReturnType<typeof setTimeout>;
    }
  >();
  return async (root: string, revision: string | null, signal: AbortSignal) => {
    signal.throwIfAborted();
    let entry = entries.get(root);
    if (!entry) {
      if (entries.size >= 100) throw new Error("Too many project watches");
      const watcher = watch(root, { recursive: true, persistent: false });
      const current: NonNullable<ReturnType<typeof entries.get>> = {
        watcher,
        revision: randomUUID(),
        error: null,
        listeners: new Set<() => void>(),
        expiry: setTimeout(() => {}, 0),
      };
      const notify = () => {
        current.revision = randomUUID();
        for (const listener of [...current.listeners]) listener();
      };
      watcher.on("change", notify);
      watcher.on("error", (error) => {
        current.error = error;
        notify();
      });
      entries.set(root, current);
      entry = current;
    }
    const current = entry;
    clearTimeout(current.expiry);
    current.expiry = setTimeout(() => {
      current.watcher.close();
      entries.delete(root);
      for (const listener of [...current.listeners]) listener();
    }, 60_000);
    current.expiry.unref();
    if (revision === current.revision && !current.error) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          current.listeners.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, 15_000);
        current.listeners.add(finish);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
    }
    signal.throwIfAborted();
    if (current.error) {
      clearTimeout(current.expiry);
      current.watcher.close();
      entries.delete(root);
      throw current.error;
    }
    return current.revision;
  };
}
