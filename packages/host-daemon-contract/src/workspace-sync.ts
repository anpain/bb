import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const relativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value
        .split("/")
        .every(
          (part) =>
            part !== "" &&
            part !== "." &&
            part !== ".." &&
            !/[\\:<>"|?*\u0000-\u001f]/u.test(part) &&
            !/[. ]$/u.test(part) &&
            !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(part),
        ),
    "Expected a relative path without traversal or drive prefixes",
  );
const rootPath = z.string().min(1).max(4096);
const uploadId = z.string().uuid();
export const WORKSPACE_SYNC_CHUNK_BYTES = 1024 * 1024;
export const workspaceSyncOperationSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("rmdir"), rootPath, path: relativePath })
    .strict(),
  z.object({ action: z.literal("snapshot"), rootPath }).strict(),
  z
    .object({
      action: z.literal("read"),
      rootPath,
      path: relativePath,
      sha256: digest,
      offset: z.number().int().nonnegative(),
      length: z.number().int().positive().max(WORKSPACE_SYNC_CHUNK_BYTES),
    })
    .strict(),
  z
    .object({
      action: z.literal("begin"),
      rootPath,
      path: relativePath,
      expectedSha256: digest.nullable(),
      sha256: digest,
      sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      mode: z.number().int().min(0).max(0o777),
    })
    .strict(),
  z
    .object({
      action: z.literal("chunk"),
      uploadId,
      offset: z.number().int().nonnegative(),
      data: z.string().max(Math.ceil(WORKSPACE_SYNC_CHUNK_BYTES / 3) * 4),
    })
    .strict(),
  z.object({ action: z.literal("commit"), uploadId }).strict(),
  z.object({ action: z.literal("abort"), uploadId }).strict(),
  z
    .object({ action: z.literal("mkdir"), rootPath, path: relativePath })
    .strict(),
  z
    .object({
      action: z.literal("remove"),
      rootPath,
      path: relativePath,
      expectedSha256: digest,
    })
    .strict(),
]);
export type WorkspaceSyncOperation = z.infer<
  typeof workspaceSyncOperationSchema
>;
export const workspaceSyncEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("file"),
      path: relativePath,
      sha256: digest,
      sizeBytes: z.number().int().nonnegative(),
      mode: z.number().int().min(0).max(0o777),
    })
    .strict(),
  z.object({ kind: z.literal("directory"), path: relativePath }).strict(),
]);
export type WorkspaceSyncEntry = z.infer<typeof workspaceSyncEntrySchema>;
export const workspaceSyncResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("rmdir"),
      outcome: z.enum(["written", "conflict"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("snapshot"),
      rootExists: z.boolean(),
      entries: z.array(workspaceSyncEntrySchema).max(100_000),
    })
    .strict(),
  z
    .object({
      action: z.literal("read"),
      data: z.string(),
      offset: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ action: z.literal("begin"), uploadId }).strict(),
  z
    .object({
      action: z.literal("chunk"),
      offset: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal("commit"),
      outcome: z.enum(["written", "conflict"]),
      currentSha256: digest.nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal("remove"),
      outcome: z.enum(["written", "conflict"]),
      currentSha256: digest.nullable(),
    })
    .strict(),
  z.object({ action: z.literal("abort"), ok: z.literal(true) }).strict(),
  z.object({ action: z.literal("mkdir"), ok: z.literal(true) }).strict(),
]);
export type WorkspaceSyncResult = z.infer<typeof workspaceSyncResultSchema>;
