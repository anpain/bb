import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { transferCodexNativeSession } from "./native-session-transfer.js";

afterEach(() => vi.unstubAllEnvs());
const id = "01a1f9fd-9acd-79e2-9656-7f6fa5396773";
const parentId = "01a1f9fd-9acd-79e2-9656-7f6fa5396774";
const signal = new AbortController().signal;
async function fixture() {
  const folder = await fs.mkdtemp(join(tmpdir(), "bb-native-transfer-"));
  onTestFinished(() => fs.rm(folder, { recursive: true, force: true }));
  const original = join(folder, "original");
  const dataDir = join(folder, "plugin-data");
  await fs.mkdir(join(original, "sessions"), { recursive: true });
  vi.stubEnv("CODEX_HOME", original);
  return {
    original,
    dataDir,
    input: {
      threadId: "thr_testnative",
      providerThreadId: id,
      nativeHome: null,
    },
  };
}
const rollout = (id: string, parent: string | null) =>
  `${JSON.stringify({ type: "session_meta", payload: { id, forked_from_id: parent } })}\n${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Retain the native conversation" }] } })}\n`;

it("exports native history and lineage, including zstd bytes in a .jsonl file, without copying credentials", async () => {
  const { original, dataDir, input } = await fixture();
  await fs.writeFile(
    join(original, "auth.json"),
    "private credentials stay here",
  );
  await fs.writeFile(
    join(original, "sessions", `rollout-2026-11-21-${id}.jsonl`),
    zstdCompressSync(Buffer.from(rollout(id, parentId))),
  );
  await fs.writeFile(
    join(original, "sessions", `rollout-2026-11-21-${parentId}.jsonl`),
    rollout(parentId, null),
  );
  const exported = await transferCodexNativeSession(
    { ...input, action: "export" },
    dataDir,
    signal,
  );
  expect(await fs.readdir(exported.rootPath)).toEqual(["sessions"]);
  const names = await fs.readdir(join(exported.rootPath, "sessions"));
  expect(names).toHaveLength(2);
  expect(
    await fs.readFile(
      join(exported.rootPath, "sessions", `rollout-2026-11-21-${id}.jsonl`),
      "utf8",
    ),
  ).toContain("Retain the native conversation");
  const activated = await transferCodexNativeSession(
    { ...input, action: "activate" },
    dataDir,
    signal,
  );
  expect(await fs.readdir(activated.nativeHome)).toEqual([
    "config.toml",
    "sessions",
  ]);
  await expect(
    fs.stat(join(activated.nativeHome, "auth.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await fs.readFile(join(activated.nativeHome, "config.toml"), "utf8"),
  ).toContain("enabled = false");
});

it("rejects unrelated homes and history that belongs to a different native thread", async () => {
  const { original, dataDir, input } = await fixture();
  await expect(
    transferCodexNativeSession(
      { ...input, action: "export", nativeHome: original },
      dataDir,
      signal,
    ),
  ).rejects.toThrow("not created for this thread");
  await fs.writeFile(
    join(original, "sessions", `rollout-2026-11-21-${id}.jsonl`),
    rollout(parentId, null),
  );
  await expect(
    transferCodexNativeSession({ ...input, action: "export" }, dataDir, signal),
  ).rejects.toThrow("identity mismatch");
});
