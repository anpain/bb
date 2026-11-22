import { createHash } from "node:crypto";
import {
  WORKSPACE_SYNC_CHUNK_BYTES,
  type WorkspaceSyncEntry,
  type WorkspaceSyncOperation,
  type WorkspaceSyncResult,
} from "@bb/host-daemon-contract";

export interface WorkspaceSyncEndpoint {
  rootPath: string;
  call(
    operation: WorkspaceSyncOperation,
    signal: AbortSignal,
  ): Promise<WorkspaceSyncResult>;
}
export type WorkspaceSyncBaseline = Record<string, WorkspaceSyncEntry>;
export interface WorkspaceSyncCheckpoint {
  path: string;
  entry: WorkspaceSyncEntry | null;
}
export interface WorkspaceSyncProgress {
  stage: "checking" | "directories" | "copying" | "finalizing" | "complete";
  path: string | null;
  bytes: number;
  totalBytes: number;
  completedFiles: number;
  totalFiles: number;
}
export class WorkspaceSyncConflictError extends Error {
  constructor(readonly paths: readonly string[]) {
    super(
      `Synchronization stopped because both copies changed: ${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ` and ${paths.length - 10} more` : ""}`,
    );
    this.name = "WorkspaceSyncConflictError";
  }
}
type FileEntry = Extract<WorkspaceSyncEntry, { kind: "file" }>;
function same(
  left: WorkspaceSyncEntry | undefined,
  right: WorkspaceSyncEntry | undefined,
): boolean {
  return (
    left?.kind === right?.kind &&
    (left?.kind !== "file" ||
      (right?.kind === "file" && left.sha256 === right.sha256))
  );
}
function subtreeChanged(
  entries: Map<string, WorkspaceSyncEntry>,
  baseline: Readonly<WorkspaceSyncBaseline>,
  root: string,
): boolean {
  const names = new Set([...entries.keys(), ...Object.keys(baseline)]);
  return [...names].some(
    (name) =>
      name.startsWith(`${root}/`) && !same(entries.get(name), baseline[name]),
  );
}
async function parallel<T>(
  items: T[],
  signal: AbortSignal,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  let failed = false;
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (!failed) {
        const item = items[index++];
        if (item === undefined) return;
        try {
          signal.throwIfAborted();
          await work(item);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const failure = outcomes.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

async function copyFile(
  source: WorkspaceSyncEndpoint,
  destination: WorkspaceSyncEndpoint,
  entry: FileEntry,
  previous: FileEntry | undefined,
  signal: AbortSignal,
  progress:
    | ((value: { path: string; bytes: number; totalBytes: number }) => void)
    | undefined,
): Promise<void> {
  const begun = await destination.call(
    {
      action: "begin",
      rootPath: destination.rootPath,
      path: entry.path,
      expectedSha256: previous?.sha256 ?? null,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      mode: previous?.mode ?? entry.mode,
    },
    signal,
  );
  if (begun.action !== "begin") throw new Error("Unexpected upload response");
  try {
    progress?.({ path: entry.path, bytes: 0, totalBytes: entry.sizeBytes });
    let offset = 0;
    const hash = createHash("sha256");
    do {
      const result = await source.call(
        {
          action: "read",
          rootPath: source.rootPath,
          path: entry.path,
          sha256: entry.sha256,
          offset,
          length: Math.max(
            1,
            Math.min(WORKSPACE_SYNC_CHUNK_BYTES, entry.sizeBytes - offset),
          ),
        },
        signal,
      );
      if (result.action !== "read" || result.offset !== offset)
        throw new Error("Unexpected file chunk response");
      const bytes = Buffer.from(result.data, "base64");
      if (
        bytes.toString("base64") !== result.data ||
        offset + bytes.length > entry.sizeBytes ||
        (bytes.length === 0 && offset < entry.sizeBytes)
      )
        throw new Error(`Invalid file chunk for ${entry.path}`);
      hash.update(bytes);
      if (bytes.length > 0) {
        const uploaded = await destination.call(
          {
            action: "chunk",
            uploadId: begun.uploadId,
            offset,
            data: result.data,
          },
          signal,
        );
        offset += bytes.length;
        if (uploaded.action !== "chunk" || uploaded.offset !== offset)
          throw new Error("Unexpected upload offset");
      }
      progress?.({
        path: entry.path,
        bytes: offset,
        totalBytes: entry.sizeBytes,
      });
    } while (offset < entry.sizeBytes);
    if (hash.digest("hex") !== entry.sha256)
      throw new Error(`File changed during transfer: ${entry.path}`);
    const result = await destination.call(
      { action: "commit", uploadId: begun.uploadId },
      signal,
    );
    if (
      result.action !== "commit" ||
      result.outcome !== "written" ||
      result.currentSha256 !== entry.sha256
    )
      throw new WorkspaceSyncConflictError([entry.path]);
  } finally {
    await destination
      .call(
        { action: "abort", uploadId: begun.uploadId },
        AbortSignal.timeout(10_000),
      )
      .catch(() => undefined);
  }
}

export async function experimental_synchronizeWorkspaces(args: {
  left: WorkspaceSyncEndpoint;
  right: WorkspaceSyncEndpoint;
  baseline: Readonly<WorkspaceSyncBaseline>;
  signal?: AbortSignal;
  onCheckpoint?(checkpoint: WorkspaceSyncCheckpoint): Promise<void>;
  onProgress?(progress: WorkspaceSyncProgress): void;
}): Promise<{
  baseline: WorkspaceSyncBaseline;
  copied: number;
  removed: number;
}> {
  const signal = args.signal ?? new AbortController().signal;
  args.onProgress?.({
    stage: "checking",
    path: null,
    bytes: 0,
    totalBytes: 0,
    completedFiles: 0,
    totalFiles: 0,
  });
  const [left, right] = await Promise.all([
    args.left.call(
      { action: "snapshot", rootPath: args.left.rootPath },
      signal,
    ),
    args.right.call(
      { action: "snapshot", rootPath: args.right.rootPath },
      signal,
    ),
  ]);
  if (left?.action !== "snapshot" || right?.action !== "snapshot")
    throw new Error("This server does not support workspace synchronization");
  if (
    (!left.rootExists || !right.rootExists) &&
    Object.keys(args.baseline).length > 0
  )
    throw new Error(
      "A synchronized project folder is missing. Synchronization stopped to preserve the remaining copy.",
    );
  if (!left.rootExists && !right.rootExists)
    throw new Error(
      "At least one project folder must exist before synchronization",
    );
  const a = new Map(left.entries.map((entry) => [entry.path, entry]));
  const b = new Map(right.entries.map((entry) => [entry.path, entry]));
  const names = [
    ...new Set([...a.keys(), ...b.keys(), ...Object.keys(args.baseline)]),
  ].sort();
  const portable = new Map<string, string>();
  const conflicts = new Set<string>();
  const directories: {
    endpoint: WorkspaceSyncEndpoint;
    path: string;
    create: boolean;
  }[] = [];
  const files: {
    source: WorkspaceSyncEndpoint;
    destination: WorkspaceSyncEndpoint;
    entry: FileEntry | null;
    previous: FileEntry | undefined;
    path: string;
  }[] = [];
  const baseline: WorkspaceSyncBaseline = { ...args.baseline };
  for (const name of names) {
    const key = name.toLowerCase();
    const earlier = portable.get(key);
    if (earlier !== undefined && earlier !== name) {
      conflicts.add(earlier);
      conflicts.add(name);
    }
    portable.set(key, name);
    const one = a.get(name);
    const two = b.get(name);
    const base = args.baseline[name];
    if (same(one, two)) {
      if (one) baseline[name] = one;
      else delete baseline[name];
      continue;
    }
    if (
      (one && two && one.kind !== two.kind) ||
      (one && base && one.kind !== base.kind) ||
      (two && base && two.kind !== base.kind)
    ) {
      conflicts.add(name);
      continue;
    }
    const existing = one ?? two;
    if (existing?.kind === "directory") {
      if (base?.kind === "directory") {
        if (subtreeChanged(one ? a : b, args.baseline, name))
          conflicts.add(name);
        else
          directories.push({
            endpoint: one ? args.left : args.right,
            path: name,
            create: false,
          });
      } else
        directories.push({
          endpoint: one ? args.right : args.left,
          path: name,
          create: true,
        });
      continue;
    }
    if (one && two && !same(one, base) && !same(two, base)) {
      conflicts.add(name);
      continue;
    }
    if ((!one || !two) && base && !same(existing, base)) {
      conflicts.add(name);
      continue;
    }
    const useLeft = base === undefined ? Boolean(one) : !same(one, base);
    const selected = useLeft ? one : two;
    const previous = useLeft ? two : one;
    if (selected?.kind === "directory" || previous?.kind === "directory")
      throw new Error("Invalid sync plan");
    files.push({
      source: useLeft ? args.left : args.right,
      destination: useLeft ? args.right : args.left,
      entry: selected ?? null,
      previous,
      path: name,
    });
  }
  if (conflicts.size > 0) throw new WorkspaceSyncConflictError([...conflicts]);
  const totalBytes = files.reduce(
    (sum, item) => sum + (item.entry?.sizeBytes ?? 0),
    0,
  );
  let bytes = 0;
  let completedFiles = 0;
  const offsets = new Map<string, number>();
  const report = (stage: WorkspaceSyncProgress["stage"], path: string | null) =>
    args.onProgress?.({
      stage,
      path,
      bytes,
      totalBytes,
      completedFiles,
      totalFiles: files.length,
    });
  report("directories", null);
  let checkpointTail = Promise.resolve();
  const checkpoint = async (name: string, entry: WorkspaceSyncEntry | null) => {
    if (entry) baseline[name] = entry;
    else delete baseline[name];
    checkpointTail = checkpointTail.then(() =>
      args.onCheckpoint?.({ path: name, entry }),
    );
    await checkpointTail;
  };
  await parallel(
    directories.filter((item) => item.create),
    signal,
    async (item) => {
      const result = await item.endpoint.call(
        { action: "mkdir", rootPath: item.endpoint.rootPath, path: item.path },
        signal,
      );
      if (result.action !== "mkdir")
        throw new Error("Unexpected directory sync response");
      await checkpoint(item.path, { kind: "directory", path: item.path });
      report("directories", item.path);
    },
  );
  let copied = 0;
  let removed = 0;
  report("copying", null);
  await parallel(files, signal, async (item) => {
    if (item.entry === null) {
      if (!item.previous) return;
      const result = await item.destination.call(
        {
          action: "remove",
          rootPath: item.destination.rootPath,
          path: item.path,
          expectedSha256: item.previous.sha256,
        },
        signal,
      );
      if (result.action !== "remove" || result.outcome !== "written")
        throw new WorkspaceSyncConflictError([item.path]);
      await checkpoint(item.path, null);
      removed++;
    } else {
      await copyFile(
        item.source,
        item.destination,
        item.entry,
        item.previous,
        signal,
        (value) => {
          const previous = offsets.get(item.path) ?? 0;
          bytes += value.bytes - previous;
          offsets.set(item.path, value.bytes);
          report("copying", item.path);
        },
      );
      await checkpoint(item.path, item.entry);
      copied++;
    }
    completedFiles++;
    report("copying", item.path);
  });
  report("finalizing", null);
  for (const item of directories
    .filter((value) => !value.create)
    .sort((one, two) => two.path.length - one.path.length)) {
    const result = await item.endpoint.call(
      { action: "rmdir", rootPath: item.endpoint.rootPath, path: item.path },
      signal,
    );
    if (result.action !== "rmdir" || result.outcome !== "written")
      throw new WorkspaceSyncConflictError([item.path]);
    await checkpoint(item.path, null);
    report("finalizing", item.path);
  }
  report("complete", null);
  return { baseline, copied, removed };
}
