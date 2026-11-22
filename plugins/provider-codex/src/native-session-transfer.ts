import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createInterface } from "node:readline";
import { createZstdDecompress } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { z } from "zod";
import type { StandardSchemaV1InferInput } from "@get-bb/plugin-sdk";
import { internal_DO_NOT_USE_nativeSessionTransferInputSchema } from "@get-bb/plugin-sdk/host";
import { resolveCodexHome } from "./codex-home.js";

type TransferInput = StandardSchemaV1InferInput<
  typeof internal_DO_NOT_USE_nativeSessionTransferInputSchema
>;
const metaSchema = z.object({
  type: z.literal("session_meta"),
  payload: z
    .object({
      id: z.string(),
      forked_from_id: z.string().nullable().optional(),
      parent_thread_id: z.string().nullable().optional(),
    })
    .passthrough(),
});
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

async function assertDirectory(root: string) {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Native session roots must be real directories");
}

export async function transferCodexNativeSession(
  input: TransferInput,
  dataDir: string,
  signal: AbortSignal,
) {
  if (!uuidPattern.test(input.providerThreadId))
    throw new Error("Select a native Codex thread before moving it");
  const managed = path.join(dataDir, "portable-sessions", input.threadId);
  const stage = path.join(dataDir, "session-transfers", input.threadId);
  const expectedHome = path.join(managed, "home");
  if (
    input.nativeHome !== null &&
    path.resolve(input.nativeHome) !== path.resolve(expectedHome)
  )
    throw new Error("This native session home was not created for this thread");
  if (input.action === "prepare") {
    await fs.mkdir(stage, { recursive: true, mode: 0o700 });
    return { rootPath: stage, nativeHome: expectedHome };
  }
  if (input.action === "activate") {
    await assertDirectory(stage);
    const sessionDir = path.join(stage, "sessions");
    await assertDirectory(sessionDir);
    const names = await fs.readdir(sessionDir);
    if (
      names.length === 0 ||
      names.length > 64 ||
      !names.some((name) => name.includes(input.providerThreadId))
    )
      throw new Error("The transferred native session is incomplete");
    for (const name of names) {
      if (!/^rollout-[a-zA-Z0-9_-]+\.jsonl$/u.test(name))
        throw new Error("Unexpected native session file");
      const date = /^rollout-(\d{4})-(\d{2})-(\d{2})(?:T|-)/u.exec(name);
      if (!date)
        throw new Error("Native session filename must contain its date");
      const destination = path.join(
        expectedHome,
        "sessions",
        date[1]!,
        date[2]!,
        date[3]!,
      );
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      const file = path.join(sessionDir, name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(
          "Native history cannot contain linked or special files",
        );
      const temporary = path.join(destination, `.${name}.incoming`);
      await fs.copyFile(file, temporary);
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, path.join(destination, name));
    }
    for (const name of await fs.readdir(expectedHome)) {
      if (
        /^(?:state_\d+|thread_history_\d+)\.sqlite(?:-wal|-shm)?$/u.test(name)
      )
        await fs.unlink(path.join(expectedHome, name));
    }
    const config = path.join(expectedHome, "config.toml");
    await fs.writeFile(
      config,
      "[analytics]\nenabled = false\n[feedback]\nenabled = false\n",
      { mode: 0o600 },
    );
    return { rootPath: stage, nativeHome: expectedHome };
  }
  const sourceHome =
    input.nativeHome ?? resolveCodexHome(os.homedir(), process.env);
  const candidates: string[] = [];
  const walk = async (root: string) => {
    const entries = await fs
      .readdir(root, { withFileTypes: true })
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [];
        throw error;
      });
    for (const entry of entries) {
      signal.throwIfAborted();
      if (entry.isSymbolicLink()) continue;
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (
        entry.isFile() &&
        /^rollout-.*\.jsonl(?:\.zst)?$/u.test(entry.name)
      )
        candidates.push(full);
      if (candidates.length > 100_000)
        throw new Error("Too many native Codex sessions to inspect");
    }
  };
  await Promise.all([
    walk(path.join(sourceHome, "sessions")),
    walk(path.join(sourceHome, "archived_sessions")),
  ]);
  await fs.mkdir(stage, { recursive: true, mode: 0o700 });
  const sessions = path.join(stage, "sessions");
  await fs.mkdir(sessions, { recursive: true, mode: 0o700 });
  const wanted = [input.providerThreadId];
  const exported = new Set<string>();
  for (const id of wanted) {
    if (exported.has(id)) continue;
    if (!uuidPattern.test(id) || exported.size >= 64)
      throw new Error("Unsupported native session lineage");
    const matches = candidates.filter((file) =>
      path.basename(file).includes(id),
    );
    const exact = matches.filter(
      (file) =>
        path
          .basename(file)
          .replace(/\.zst$/u, "")
          .endsWith(`-${id}.jsonl`) ||
        path
          .basename(file)
          .replace(/\.zst$/u, "")
          .endsWith(`_${id}.jsonl`),
    );
    const plain = (exact.length ? exact : matches).find((file) =>
      file.endsWith(".jsonl"),
    );
    const source = plain ?? exact[0] ?? matches[0];
    if (!source)
      throw new Error(
        `Native Codex history is missing for ${id}. Importing display history cannot restore a native session.`,
      );
    const destination = path.join(
      sessions,
      path.basename(source).replace(/\.zst$/u, ""),
    );
    const before = await fs.stat(source, { bigint: true });
    if (before.size > 512n * 1024n * 1024n)
      throw new Error("Native session exceeds the 512 MiB transfer limit");
    const header = await fs.open(source, "r");
    const magic = Buffer.alloc(4);
    try {
      await header.read(magic, 0, 4, 0);
    } finally {
      await header.close();
    }
    if (magic.equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) {
      let size = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          callback(
            size > 512 * 1024 * 1024
              ? new Error("Expanded native session exceeds 512 MiB")
              : null,
            chunk,
          );
        },
      });
      await pipeline(
        createReadStream(source),
        createZstdDecompress(),
        limit,
        createWriteStream(destination, { mode: 0o600 }),
        { signal },
      );
    } else await fs.copyFile(source, destination);
    const after = await fs.stat(source, { bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error(
        "Native Codex history changed during transfer; stop the active thread and retry",
      );
    const stream = createReadStream(destination);
    const reader = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    let found = false;
    try {
      for await (const line of reader) {
        signal.throwIfAborted();
        const parsed = metaSchema.safeParse(JSON.parse(line));
        if (!parsed.success) continue;
        if (parsed.data.payload.id !== id)
          throw new Error("Native session identity mismatch");
        const parent =
          parsed.data.payload.forked_from_id ??
          parsed.data.payload.parent_thread_id;
        if (parent) wanted.push(parent);
        found = true;
        break;
      }
    } finally {
      reader.close();
      stream.destroy();
    }
    if (!found) throw new Error("Native session metadata is missing");
    exported.add(id);
  }
  for (const name of await fs.readdir(sessions)) {
    if (![...exported].some((id) => name.includes(id)))
      await fs.unlink(path.join(sessions, name));
  }
  return { rootPath: stage, nativeHome: expectedHome };
}
