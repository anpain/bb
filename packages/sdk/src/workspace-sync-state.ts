import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { withFileLock } from "@bb/config/file-lock";
import { workspaceSyncEntrySchema } from "@bb/host-daemon-contract";
import { z } from "zod";
import {
  experimental_synchronizeWorkspaces,
  type WorkspaceSyncBaseline,
} from "./workspace-sync.js";

const entriesSchema = z
  .record(z.string(), workspaceSyncEntrySchema)
  .refine(
    (entries) =>
      Object.entries(entries).every(([name, entry]) => name === entry.path),
    "Invalid sync checkpoint path",
  );
const stateSchema = z
  .object({
    version: z.literal(1),
    identity: z.string().min(1),
    leftRoot: z.string().min(1),
    rightRoot: z.string().min(1),
    entries: entriesSchema,
  })
  .strict();
const checkpointSchema = z
  .object({
    identity: z.string().min(1),
    path: z.string().min(1),
    entry: workspaceSyncEntrySchema.nullable(),
  })
  .strict()
  .refine(
    (entry) => entry.entry === null || entry.entry.path === entry.path,
    "Invalid checkpoint path",
  );

async function optionalText(file: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024)
      throw new Error("Invalid workspace synchronization state file");
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

export async function experimental_syncWorkspacePair(
  args: Omit<
    Parameters<typeof experimental_synchronizeWorkspaces>[0],
    "baseline" | "onCheckpoint"
  > & { identity: string; statePath: string },
) {
  const statePath = resolve(args.statePath);
  for (const root of [args.left.rootPath, args.right.rootPath]) {
    if (!isAbsolute(root)) continue;
    const within = relative(resolve(root), statePath);
    if (
      within === "" ||
      (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within))
    )
      throw new Error("Keep synchronization state outside the project folders");
  }
  const journalPath = `${statePath}.journal`;
  await fs.mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  return withFileLock({
    path: `${statePath}.lock`,
    timeoutMs: 1_000,
    work: async () => {
      const stored = await optionalText(statePath);
      const state = stateSchema.parse(
        stored === null
          ? {
              version: 1,
              identity: args.identity,
              leftRoot: args.left.rootPath,
              rightRoot: args.right.rootPath,
              entries: {},
            }
          : JSON.parse(stored),
      );
      if (
        state.identity !== args.identity ||
        state.leftRoot !== args.left.rootPath ||
        state.rightRoot !== args.right.rootPath
      )
        throw new Error(
          "This sync state belongs to another server or project folder",
        );
      if (stored === null)
        await fs.writeFile(statePath, JSON.stringify(state), {
          flag: "wx",
          mode: 0o600,
          flush: true,
        });
      const baseline: WorkspaceSyncBaseline = { ...state.entries };
      const journal = await optionalText(journalPath);
      if (journal !== null) {
        const complete = journal.lastIndexOf("\n") + 1;
        if (complete < journal.length)
          await fs.truncate(
            journalPath,
            Buffer.byteLength(journal.slice(0, complete)),
          );
        const records = journal.split("\n");
        records.pop();
        for (const record of records) {
          if (!record) continue;
          const checkpoint = checkpointSchema.parse(JSON.parse(record));
          if (checkpoint.identity !== args.identity)
            throw new Error("Sync checkpoint belongs to another server");
          if (checkpoint.entry) baseline[checkpoint.path] = checkpoint.entry;
          else delete baseline[checkpoint.path];
        }
      }
      const result = await experimental_synchronizeWorkspaces({
        ...args,
        baseline,
        onCheckpoint: async (checkpoint) => {
          await fs.appendFile(
            journalPath,
            `${JSON.stringify({ ...checkpoint, identity: args.identity })}\n`,
            { encoding: "utf8", mode: 0o600, flush: true },
          );
        },
      });
      const temporary = `${statePath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(
          temporary,
          JSON.stringify({ ...state, entries: result.baseline }),
          { flag: "wx", mode: 0o600, flush: true },
        );
        await fs.rename(temporary, statePath);
        await fs.writeFile(journalPath, "", { mode: 0o600, flush: true });
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return result;
    },
  });
}
