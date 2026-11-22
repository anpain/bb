import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import {
  WORKSPACE_SYNC_CHUNK_BYTES,
  workspaceSyncOperationSchema,
} from "@bb/host-daemon-contract";
import { createWorkspaceSyncService } from "./workspace-sync.js";
import {
  experimental_synchronizeWorkspaces,
  experimental_syncWorkspacePair,
  type WorkspaceSyncBaseline,
} from "@bb/sdk/node";

const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const folder = await fs.mkdtemp(join(tmpdir(), "bb-sync-"));
  onTestFinished(() => fs.rm(folder, { recursive: true, force: true }));
  const root = join(folder, "project");
  const service = createWorkspaceSyncService(join(folder, "data"));
  const signal = new AbortController().signal;
  const run = (operation: Parameters<typeof service>[0]) =>
    service(operation, signal);
  const upload = async (
    file: string,
    bytes: Buffer,
    expectedSha256: string | null,
  ) => {
    const begun = await run({
      action: "begin",
      rootPath: root,
      path: file,
      expectedSha256,
      sizeBytes: bytes.length,
      sha256: sha(bytes),
      mode: 0o644,
    });
    if (begun.action !== "begin") throw new Error("Unexpected result");
    for (
      let offset = 0;
      offset < bytes.length;
      offset += WORKSPACE_SYNC_CHUNK_BYTES
    ) {
      await run({
        action: "chunk",
        uploadId: begun.uploadId,
        offset,
        data: bytes
          .subarray(offset, offset + WORKSPACE_SYNC_CHUNK_BYTES)
          .toString("base64"),
      });
    }
    return run({ action: "commit", uploadId: begun.uploadId });
  };
  return { folder, root, run, upload, service };
}

it("transfers binary files beyond the ordinary file API limit and includes hidden Git files", async () => {
  const { root, run, upload } = await fixture();
  const content = Buffer.alloc(26 * 1024 * 1024, 0xa5);
  expect(await upload("base.db", content, null)).toMatchObject({
    outcome: "written",
    currentSha256: sha(content),
  });
  await upload(".git/objects/object", Buffer.from("object"), null);
  const snapshot = await run({ action: "snapshot", rootPath: root });
  expect(snapshot).toMatchObject({
    action: "snapshot",
    rootExists: true,
    entries: expect.arrayContaining([
      expect.objectContaining({
        path: "base.db",
        sizeBytes: content.length,
        sha256: sha(content),
      }),
      expect.objectContaining({ path: ".git/objects/object" }),
    ]),
  });
  const read = await run({
    action: "read",
    rootPath: root,
    path: "base.db",
    sha256: sha(content),
    offset: content.length - 14,
    length: 14,
  });
  expect(read).toMatchObject({
    data: content.subarray(-14).toString("base64"),
  });
}, 30_000);

it("preserves a concurrent edit instead of publishing a stale upload", async () => {
  const { root, run, upload } = await fixture();
  await upload("code.py", Buffer.from("original"), null);
  const begun = await run({
    action: "begin",
    rootPath: root,
    path: "code.py",
    expectedSha256: sha("original"),
    sha256: sha("remote"),
    sizeBytes: 6,
    mode: 0o644,
  });
  if (begun.action !== "begin") throw new Error("Unexpected result");
  await run({
    action: "chunk",
    uploadId: begun.uploadId,
    offset: 0,
    data: Buffer.from("remote").toString("base64"),
  });
  await fs.writeFile(join(root, "code.py"), "manual edit");
  expect(
    await run({ action: "commit", uploadId: begun.uploadId }),
  ).toMatchObject({ outcome: "conflict", currentSha256: sha("manual edit") });
  expect(await fs.readFile(join(root, "code.py"), "utf8")).toBe("manual edit");
});

it("publishes read-only Git objects after flushing their open staging handle", async () => {
  const { root, run } = await fixture();
  const content = Buffer.from("read-only Git object");
  const begin = await run({
    action: "begin",
    rootPath: root,
    path: ".git/objects/pack/pack-test.pack",
    expectedSha256: null,
    sha256: sha(content),
    sizeBytes: content.length,
    mode: 0o444,
  });
  if (begin.action !== "begin") throw new Error("Unexpected result");
  await run({
    action: "chunk",
    uploadId: begin.uploadId,
    offset: 0,
    data: content.toString("base64"),
  });
  expect(
    await run({ action: "commit", uploadId: begin.uploadId }),
  ).toMatchObject({
    outcome: "written",
    currentSha256: sha(content),
  });
  const file = join(root, ".git/objects/pack/pack-test.pack");
  expect(await fs.readFile(file)).toEqual(content);
  expect((await fs.stat(file)).mode & 0o222).toBe(0);
  await fs.chmod(file, 0o600);
});

it("verifies uploaded bytes, ordering, and cancellation before publishing", async () => {
  const { root, run } = await fixture();
  const begin = await run({
    action: "begin",
    rootPath: root,
    path: "file",
    expectedSha256: null,
    sha256: sha("ab"),
    sizeBytes: 2,
    mode: 0o644,
  });
  if (begin.action !== "begin") throw new Error("Unexpected result");
  await expect(
    run({
      action: "chunk",
      uploadId: begin.uploadId,
      offset: 1,
      data: Buffer.from("ab").toString("base64"),
    }),
  ).rejects.toThrow("Invalid upload");
  await run({
    action: "chunk",
    uploadId: begin.uploadId,
    offset: 0,
    data: Buffer.from("xx").toString("base64"),
  });
  await expect(
    run({ action: "commit", uploadId: begin.uploadId }),
  ).rejects.toThrow("SHA-256");
  await expect(fs.stat(join(root, "file"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    run({ action: "commit", uploadId: begin.uploadId }),
  ).rejects.toThrow("expired");
});

it("does not follow linked paths or accept traversal", async () => {
  const { folder, root, run, upload } = await fixture();
  await fs.mkdir(root);
  const outside = join(folder, "outside");
  await fs.mkdir(outside);
  await fs.symlink(
    outside,
    join(root, "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(run({ action: "snapshot", rootPath: root })).rejects.toThrow(
    "Unsupported sync entry",
  );
  await expect(upload("link/file", Buffer.from("no"), null)).rejects.toThrow(
    "symlinks",
  );
  expect(
    workspaceSyncOperationSchema.safeParse({
      action: "mkdir",
      rootPath: root,
      path: "../outside",
    }).success,
  ).toBe(false);
  await expect(fs.stat(join(outside, "file"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("backs up overwritten and deleted files and detects conflicting deletions", async () => {
  const { folder, root, run, upload } = await fixture();
  await upload("code", Buffer.from("first"), null);
  await upload("code", Buffer.from("second"), sha("first"));
  expect(
    await run({
      action: "remove",
      rootPath: root,
      path: "code",
      expectedSha256: sha("first"),
    }),
  ).toMatchObject({ outcome: "conflict" });
  expect(
    await run({
      action: "remove",
      rootPath: root,
      path: "code",
      expectedSha256: sha("second"),
    }),
  ).toMatchObject({ outcome: "written" });
  const key = sha(join(root, "code"));
  expect(
    await fs.readFile(
      join(folder, "data", "workspace-sync", "backups", key, sha("first")),
      "utf8",
    ),
  ).toBe("first");
  expect(
    await fs.readFile(
      join(folder, "data", "workspace-sync", "backups", key, sha("second")),
      "utf8",
    ),
  ).toBe("second");
});

it("mirrors files and empty directories both ways and propagates deliberate deletions", async () => {
  const { folder, root, service, upload } = await fixture();
  const remote = join(folder, "remote");
  const other = createWorkspaceSyncService(join(folder, "other-data"));
  const left = { rootPath: root, call: service };
  const right = { rootPath: remote, call: other };
  await upload("a.py", Buffer.from("first"), null);
  await upload("empty-file", Buffer.alloc(0), null);
  await fs.mkdir(join(root, "empty-dir"));
  const first = await experimental_synchronizeWorkspaces({
    left,
    right,
    baseline: {},
  });
  expect(await fs.readFile(join(remote, "a.py"), "utf8")).toBe("first");
  expect((await fs.stat(join(remote, "empty-dir"))).isDirectory()).toBe(true);
  expect((await fs.stat(join(remote, "empty-file"))).size).toBe(0);
  await fs.writeFile(join(root, "a.py"), "local edit");
  await fs.writeFile(join(remote, "remote.py"), "server edit");
  await fs.unlink(join(root, "empty-file"));
  await fs.rmdir(join(remote, "empty-dir"));
  const second = await experimental_synchronizeWorkspaces({
    left,
    right,
    baseline: first.baseline,
  });
  expect(second).toMatchObject({ copied: 2, removed: 1 });
  expect(await fs.readFile(join(remote, "a.py"), "utf8")).toBe("local edit");
  expect(await fs.readFile(join(root, "remote.py"), "utf8")).toBe(
    "server edit",
  );
  await expect(fs.stat(join(remote, "empty-file"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(fs.stat(join(root, "empty-dir"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("stops the entire sync plan for a conflict and never treats a missing root as mass deletion", async () => {
  const { folder, root, service, upload } = await fixture();
  const remote = join(folder, "remote");
  const left = { rootPath: root, call: service };
  const right = {
    rootPath: remote,
    call: createWorkspaceSyncService(join(folder, "other-data")),
  };
  await upload("code", Buffer.from("base"), null);
  const first = await experimental_synchronizeWorkspaces({
    left,
    right,
    baseline: {},
  });
  await fs.writeFile(join(root, "code"), "local");
  await fs.writeFile(join(remote, "code"), "remote");
  await fs.writeFile(join(root, "new-file"), "not yet copied");
  await expect(
    experimental_synchronizeWorkspaces({
      left,
      right,
      baseline: first.baseline,
    }),
  ).rejects.toMatchObject({ paths: ["code"] });
  expect(await fs.readFile(join(root, "code"), "utf8")).toBe("local");
  expect(await fs.readFile(join(remote, "code"), "utf8")).toBe("remote");
  await expect(fs.stat(join(remote, "new-file"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await fs.rename(remote, join(folder, "temporarily-missing"));
  await expect(
    experimental_synchronizeWorkspaces({
      left,
      right,
      baseline: first.baseline,
    }),
  ).rejects.toThrow("folder is missing");
  expect(await fs.readFile(join(root, "code"), "utf8")).toBe("local");
});

it("uses completed checkpoints after a connection failure so a later local edit can sync", async () => {
  const { folder, root, service, upload } = await fixture();
  const remote = join(folder, "remote");
  const left = { rootPath: root, call: service };
  const right = {
    rootPath: remote,
    call: createWorkspaceSyncService(join(folder, "other-data")),
  };
  await upload("a", Buffer.from("base-a"), null);
  await upload("b", Buffer.from("base-b"), null);
  const first = await experimental_synchronizeWorkspaces({
    left,
    right,
    baseline: {},
  });
  await fs.writeFile(join(root, "a"), "new-a");
  await fs.writeFile(join(root, "b"), "new-b");
  const saved: WorkspaceSyncBaseline = { ...first.baseline };
  const brokenLeft = {
    rootPath: root,
    call: async (
      operation: Parameters<typeof service>[0],
      signal: AbortSignal,
    ) => {
      if (operation.action === "read" && operation.path === "b")
        throw new Error("Connection lost");
      return service(operation, signal);
    },
  };
  await expect(
    experimental_synchronizeWorkspaces({
      left: brokenLeft,
      right,
      baseline: saved,
      onCheckpoint: async ({ path, entry }) => {
        if (entry) saved[path] = entry;
        else delete saved[path];
      },
    }),
  ).rejects.toThrow("Connection lost");
  expect(await fs.readFile(join(remote, "a"), "utf8")).toBe("new-a");
  await fs.writeFile(join(root, "a"), "next-a");
  await experimental_synchronizeWorkspaces({ left, right, baseline: saved });
  expect(await fs.readFile(join(remote, "a"), "utf8")).toBe("next-a");
  expect(await fs.readFile(join(remote, "b"), "utf8")).toBe("new-b");
});

it("recovers a durable pair after an interrupted transfer and a torn last journal record", async () => {
  const { folder, root, service, upload } = await fixture();
  const remote = join(folder, "remote");
  const left = { rootPath: root, call: service };
  const right = {
    rootPath: remote,
    call: createWorkspaceSyncService(join(folder, "other-data")),
  };
  const statePath = join(folder, "state", "pair.json");
  const identity = "test-pair";
  await upload("a", Buffer.from("old-a"), null);
  await upload("b", Buffer.from("old-b"), null);
  await experimental_syncWorkspacePair({ left, right, statePath, identity });
  await fs.writeFile(join(root, "a"), "new-a");
  await fs.writeFile(join(root, "b"), "new-b");
  const broken = {
    rootPath: root,
    call: async (
      operation: Parameters<typeof service>[0],
      signal: AbortSignal,
    ) => {
      if (operation.action === "read" && operation.path === "b")
        throw new Error("Network disconnected");
      return service(operation, signal);
    },
  };
  await expect(
    experimental_syncWorkspacePair({
      left: broken,
      right,
      statePath,
      identity,
    }),
  ).rejects.toThrow("Network disconnected");
  expect(await fs.readFile(`${statePath}.journal`, "utf8")).toContain(
    '"path":"a"',
  );
  await fs.appendFile(`${statePath}.journal`, '{"partial":');
  await fs.writeFile(join(root, "a"), "next-a");
  await experimental_syncWorkspacePair({ left, right, statePath, identity });
  expect(await fs.readFile(join(remote, "a"), "utf8")).toBe("next-a");
  expect(await fs.readFile(join(remote, "b"), "utf8")).toBe("new-b");
  expect(await fs.readFile(`${statePath}.journal`, "utf8")).toBe("");
  await expect(
    experimental_syncWorkspacePair({
      left,
      right,
      statePath,
      identity: "different-server",
    }),
  ).rejects.toThrow("another server");
});
