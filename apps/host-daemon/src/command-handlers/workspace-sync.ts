import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hashFile, publishFileWithoutReplacing } from "@bb/file-transfer";
import {
  WORKSPACE_SYNC_CHUNK_BYTES,
  type WorkspaceSyncEntry,
  type WorkspaceSyncOperation,
  type WorkspaceSyncResult,
} from "@bb/host-daemon-contract";
import { CommandDispatchError } from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";
import { runInSerialLane } from "../serial-lane.js";

function invalid(message: string): never {
  throw new CommandDispatchError("invalid_path", message);
}

async function info(file: string) {
  try {
    return await fs.lstat(file, { bigint: true });
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function directory(value: string, create: boolean): Promise<string> {
  if (!path.isAbsolute(value) || path.resolve(value) === path.parse(value).root)
    invalid(
      "A project directory must be absolute and cannot be a filesystem root",
    );
  const absolute = path.resolve(value);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current, part);
    let stat = await info(current);
    if (stat === null && create) {
      await fs.mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
        if (!isFsErrorWithCode(error, "EEXIST")) throw error;
      });
      stat = await info(current);
    }
    if (stat === null)
      throw Object.assign(new Error(`Directory does not exist: ${current}`), {
        code: "ENOENT",
      });
    if (stat.isSymbolicLink() || !stat.isDirectory())
      invalid(`Sync directories cannot contain symlinks: ${current}`);
  }
  return absolute;
}

async function target(
  root: string,
  relative: string,
  create: boolean,
): Promise<string> {
  const resolved = await directory(root, create);
  const parts = relative.split("/");
  if (
    !parts.every(
      (part) => part && part !== "." && part !== ".." && !/[\\:\0]/u.test(part),
    )
  )
    invalid("Invalid sync path");
  const result = path.join(resolved, ...parts);
  if (path.dirname(result) !== resolved)
    await directory(path.dirname(result), create);
  const stat = await info(result);
  if (
    stat !== null &&
    (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
  )
    invalid(`Unsupported sync entry: ${relative}`);
  return result;
}

export function createWorkspaceSyncService(dataDir: string) {
  const hashes = new Map<string, { signature: string; sha256: string }>();
  const lanes = new Map<string, Promise<void>>();
  const uploads = new Map<
    string,
    {
      operation: Extract<WorkspaceSyncOperation, { action: "begin" }>;
      file: string;
      destination: string;
      offset: number;
      touched: number;
    }
  >();
  const digest = async (file: string): Promise<string | null> => {
    const stat = await info(file);
    if (stat === null) return null;
    if (!stat.isFile() || stat.isSymbolicLink())
      invalid(`Expected a regular file: ${file}`);
    const signature = [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ].join(":");
    const cached = hashes.get(file);
    if (cached?.signature === signature) return cached.sha256;
    const result = await hashFile(file);
    const after = await info(file);
    if (
      after === null ||
      [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(
        ":",
      ) !== signature
    )
      throw new CommandDispatchError(
        "sync_source_changed",
        `File changed during snapshot: ${file}`,
      );
    if (hashes.size > 100_000) hashes.clear();
    hashes.set(file, { signature, sha256: result.sha256 });
    return result.sha256;
  };
  const backup = async (file: string, expected: string) => {
    const key = createHash("sha256").update(file).digest("hex");
    const folder = path.join(dataDir, "workspace-sync", "backups", key);
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const destination = path.join(folder, expected);
    await fs
      .copyFile(file, destination, fs.constants.COPYFILE_EXCL)
      .catch((error: unknown) => {
        if (!isFsErrorWithCode(error, "EEXIST")) throw error;
      });
    await fs.chmod(destination, 0o600);
    if ((await hashFile(destination)).sha256 !== expected)
      throw new CommandDispatchError(
        "sync_source_changed",
        "File changed while preserving its previous version",
      );
    const versions = await Promise.all(
      (await fs.readdir(folder)).map(async (name) => ({
        name,
        time: (await fs.stat(path.join(folder, name))).mtimeMs,
      })),
    );
    for (const version of versions.sort((a, b) => b.time - a.time).slice(10))
      await fs.unlink(path.join(folder, version.name));
  };
  const clean = async (id: string) => {
    const upload = uploads.get(id);
    if (upload === undefined) return;
    uploads.delete(id);
    await fs.rm(upload.file, { force: true });
  };
  return async function run(
    operation: WorkspaceSyncOperation,
    signal: AbortSignal,
  ): Promise<WorkspaceSyncResult> {
    signal.throwIfAborted();
    if ("rootPath" in operation) {
      const relativeData = path.relative(
        path.resolve(operation.rootPath),
        path.resolve(dataDir),
      );
      if (
        relativeData === "" ||
        (relativeData !== ".." &&
          !relativeData.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relativeData))
      )
        invalid(
          "A project mirror cannot contain bb's own data or backup directory",
        );
    }
    for (const [id, upload] of uploads)
      if (Date.now() - upload.touched > 30 * 60_000) await clean(id);
    switch (operation.action) {
      case "snapshot": {
        const entries: WorkspaceSyncEntry[] = [];
        let root: string;
        try {
          root = await directory(operation.rootPath, false);
        } catch (error) {
          if (isFsErrorWithCode(error, "ENOENT"))
            return { action: "snapshot", rootExists: false, entries };
          throw error;
        }
        const walk = async (folder: string, prefix: string) => {
          for (const entry of await fs.readdir(folder, {
            withFileTypes: true,
          })) {
            signal.throwIfAborted();
            if (entries.length >= 100_000)
              invalid("Project exceeds the 100000-entry sync limit");
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            const file = await target(root, relative, false);
            if (entry.isDirectory()) {
              entries.push({ kind: "directory", path: relative });
              await walk(file, relative);
            } else if (entry.isFile()) {
              const sha256 = await digest(file);
              const stat = await info(file);
              if (stat === null || sha256 === null)
                throw new CommandDispatchError(
                  "sync_source_changed",
                  `File disappeared: ${relative}`,
                );
              entries.push({
                kind: "file",
                path: relative,
                sha256,
                sizeBytes: Number(stat.size),
                mode: Number(stat.mode & 0o777n),
              });
            } else
              invalid(
                `Sync does not follow symlinks or special files: ${relative}`,
              );
          }
        };
        await walk(root, "");
        return { action: "snapshot", rootExists: true, entries };
      }
      case "read": {
        const file = await target(operation.rootPath, operation.path, false);
        if ((await digest(file)) !== operation.sha256)
          throw new CommandDispatchError(
            "sync_source_changed",
            `File changed: ${operation.path}`,
          );
        const handle = await fs.open(file, "r");
        try {
          const before = await handle.stat({ bigint: true });
          const buffer = Buffer.alloc(operation.length);
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            operation.offset,
          );
          const after = await handle.stat({ bigint: true });
          if (
            before.mtimeNs !== after.mtimeNs ||
            before.ctimeNs !== after.ctimeNs ||
            (await digest(file)) !== operation.sha256
          )
            throw new CommandDispatchError(
              "sync_source_changed",
              `File changed while reading: ${operation.path}`,
            );
          return {
            action: "read",
            data: buffer.subarray(0, bytesRead).toString("base64"),
            offset: operation.offset,
          };
        } finally {
          await handle.close();
        }
      }
      case "mkdir": {
        const file = await target(operation.rootPath, operation.path, true);
        await directory(file, true);
        return { action: "mkdir", ok: true };
      }
      case "rmdir": {
        try {
          const file = await target(operation.rootPath, operation.path, false);
          await fs.rmdir(file);
          return { action: "rmdir", outcome: "written" };
        } catch (error) {
          if (isFsErrorWithCode(error, "ENOENT"))
            return { action: "rmdir", outcome: "written" };
          if (
            isFsErrorWithCode(error, "ENOTEMPTY") ||
            isFsErrorWithCode(error, "ENOTDIR")
          )
            return { action: "rmdir", outcome: "conflict" };
          throw error;
        }
      }
      case "begin": {
        if (uploads.size >= 16)
          throw new CommandDispatchError(
            "sync_busy",
            "Too many concurrent file uploads",
          );
        const destination = await target(
          operation.rootPath,
          operation.path,
          true,
        );
        const root = path.resolve(operation.rootPath);
        const key = createHash("sha256")
          .update(root)
          .digest("hex")
          .slice(0, 20);
        const stageRoot = await directory(
          path.join(path.dirname(root), `.bb-sync-${key}`),
          true,
        );
        const uploadId = randomUUID();
        const file = path.join(stageRoot, uploadId);
        await fs.writeFile(file, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
        uploads.set(uploadId, {
          operation,
          destination,
          file,
          offset: 0,
          touched: Date.now(),
        });
        return { action: "begin", uploadId };
      }
      case "abort": {
        await clean(operation.uploadId);
        return { action: "abort", ok: true };
      }
      case "chunk":
      case "commit": {
        return runInSerialLane(lanes, operation.uploadId, async () => {
          const upload = uploads.get(operation.uploadId);
          if (upload === undefined)
            throw new CommandDispatchError(
              "sync_upload_missing",
              "File upload expired; retry synchronization",
            );
          upload.touched = Date.now();
          if (operation.action === "chunk") {
            const contents = Buffer.from(operation.data, "base64");
            if (
              contents.toString("base64") !== operation.data ||
              contents.length > WORKSPACE_SYNC_CHUNK_BYTES ||
              contents.length === 0 ||
              upload.offset !== operation.offset ||
              upload.offset + contents.length > upload.operation.sizeBytes
            )
              invalid("Invalid upload chunk or offset");
            await fs.appendFile(upload.file, contents);
            upload.offset += contents.length;
            return { action: "chunk", offset: upload.offset };
          }
          try {
            const verified = await hashFile(upload.file);
            if (
              verified.sha256 !== upload.operation.sha256 ||
              verified.sizeBytes !== upload.operation.sizeBytes
            )
              throw new CommandDispatchError(
                "sync_invalid_content",
                "Uploaded file did not match its SHA-256 and size",
              );
            return await runInSerialLane(
              lanes,
              upload.destination,
              async () => {
                const destination = await target(
                  upload.operation.rootPath,
                  upload.operation.path,
                  true,
                );
                const expected = upload.operation.expectedSha256;
                let current = await digest(destination);
                if (current !== expected)
                  return {
                    action: "commit",
                    outcome: "conflict",
                    currentSha256: current,
                  };
                if (current !== null) await backup(destination, current);
                current = await digest(destination);
                if (current !== expected)
                  return {
                    action: "commit",
                    outcome: "conflict",
                    currentSha256: current,
                  };
                const handle = await fs.open(upload.file, "r+");
                try {
                  await handle.chmod(upload.operation.mode);
                  await handle.sync();
                } finally {
                  await handle.close();
                }
                if (expected === null) {
                  if (
                    !(await publishFileWithoutReplacing(
                      upload.file,
                      destination,
                    ))
                  )
                    return {
                      action: "commit",
                      outcome: "conflict",
                      currentSha256: await digest(destination),
                    };
                } else await fs.rename(upload.file, destination);
                hashes.delete(destination);
                return {
                  action: "commit",
                  outcome: "written",
                  currentSha256: verified.sha256,
                };
              },
            );
          } finally {
            await clean(operation.uploadId);
          }
        });
      }
      case "remove": {
        const file = await target(operation.rootPath, operation.path, false);
        return runInSerialLane(lanes, file, async () => {
          let current = await digest(file);
          if (current === null)
            return {
              action: "remove",
              outcome: "written",
              currentSha256: null,
            };
          if (current !== operation.expectedSha256)
            return {
              action: "remove",
              outcome: "conflict",
              currentSha256: current,
            };
          await backup(file, current);
          current = await digest(file);
          if (current !== operation.expectedSha256)
            return {
              action: "remove",
              outcome: "conflict",
              currentSha256: current,
            };
          await fs.unlink(file);
          hashes.delete(file);
          return { action: "remove", outcome: "written", currentSha256: null };
        });
      }
    }
  };
}

const services = new Map<
  string,
  ReturnType<typeof createWorkspaceSyncService>
>();
export function runWorkspaceSync(
  operation: WorkspaceSyncOperation,
  dataDir: string,
  signal: AbortSignal,
): Promise<WorkspaceSyncResult> {
  let service = services.get(dataDir);
  if (service === undefined) {
    service = createWorkspaceSyncService(dataDir);
    services.set(dataDir, service);
  }
  return service(operation, signal);
}
