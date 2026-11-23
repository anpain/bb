import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { getAppSettings, setAppSettings } from "@bb/db";
import {
  mergeExecutionInstructions,
  maybeGenerateExecutionInstructions,
  generateThreadExecutionInstructions,
  currentExecutionInstructions,
} from "../../src/services/threads/execution-instructions.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

it("preserves user text, replaces only its own block and rejects malformed blocks", () => {
  const original = "# My project\r\n\r\nNever delete this.\r\n";
  const first = mergeExecutionInstructions(original);
  expect(first.startsWith(original)).toBe(true);
  expect(mergeExecutionInstructions(first)).toBe(first);
  expect(mergeExecutionInstructions(`${first}\nUser footer\n`)).toBe(
    `${first}\nUser footer\n`,
  );
  expect(() =>
    mergeExecutionInstructions(
      "before\n<!-- bb:execution-context:start -->\nno end",
    ),
  ).toThrow("preserved");
  expect(first).toContain("request_access");
  expect(first).toContain("only after a Local/VPS handoff");
});

it("respects disabled auto generation, supports manual generation and guards concurrent user edits", async () => {
  await withTestHarness(async (harness) => {
    const seeded = seedThreadFixture(harness);
    const files = new Map<string, string>();
    const writes: string[] = [];
    let conflict = false;
    const responder = registerHostRpcResponder(harness, {
      hostId: seeded.host.id,
      sessionId: seeded.session.id,
      handle({ command }) {
        if (command.type === "host.read_file") {
          const content = files.get(command.path);
          if (content === undefined)
            return {
              ok: false,
              errorCode: "ENOENT",
              errorMessage: "File does not exist",
            };
          return {
            ok: true,
            result: {
              path: command.path,
              content,
              contentEncoding: "utf8",
              sizeBytes: Buffer.byteLength(content),
              sha256: createHash("sha256").update(content).digest("hex"),
            },
          };
        }
        if (command.type === "host.write_file") {
          const existing = files.get(command.path);
          const sha256 =
            existing === undefined
              ? null
              : createHash("sha256").update(existing).digest("hex");
          if (conflict || sha256 !== command.expectedSha256)
            return {
              ok: true,
              result: { outcome: "conflict", currentSha256: sha256 },
            };
          writes.push(command.path);
          files.set(command.path, command.content);
          return {
            ok: true,
            result: {
              outcome: "written",
              sha256: createHash("sha256")
                .update(command.content)
                .digest("hex"),
              sizeBytes: Buffer.byteLength(command.content),
            },
          };
        }
        throw new Error(`Unexpected command ${command.type}`);
      },
    });
    try {
      setAppSettings(harness.db, {
        ...getAppSettings(harness.db),
        generateExecutionInstructions: false,
      });
      await maybeGenerateExecutionInstructions(harness.deps, seeded.thread.id);
      expect(responder.requests).toHaveLength(0);
      const result = await generateThreadExecutionInstructions(
        harness.deps,
        seeded.thread.id,
      );
      expect(result.files).toHaveLength(2);
      const agent = result.files[0]!;
      const claude = result.files[1]!;
      expect(agent.endsWith("AGENTS.md")).toBe(true);
      expect(claude.endsWith("CLAUDE.md")).toBe(true);
      files.set(agent, `User prefix\n${files.get(agent)}\nUser suffix`);
      files.set(claude, "Existing Claude instructions\n");
      await generateThreadExecutionInstructions(harness.deps, seeded.thread.id);
      expect(files.get(agent)).toMatch(/^User prefix\n/u);
      expect(files.get(agent)).toMatch(/User suffix$/u);
      expect(files.get(claude)).toMatch(/^Existing Claude instructions\n/u);
      const count = writes.length;
      await generateThreadExecutionInstructions(harness.deps, seeded.thread.id);
      expect(writes).toHaveLength(count);
      files.set(claude, "Auto mode preserves this too\n");
      setAppSettings(harness.db, {
        ...getAppSettings(harness.db),
        generateExecutionInstructions: true,
      });
      await maybeGenerateExecutionInstructions(harness.deps, seeded.thread.id);
      expect(files.get(claude)).toMatch(/^Auto mode preserves this too\n/u);
      expect(files.get(claude)).toContain("bb:execution-context:start");
      files.set(agent, "A newer manual edit\n");
      conflict = true;
      await expect(
        generateThreadExecutionInstructions(harness.deps, seeded.thread.id),
      ).rejects.toThrow("changed while");
      expect(files.get(agent)).toBe("A newer manual edit\n");
      expect(
        currentExecutionInstructions(
          harness.deps,
          seeded.host.id,
          "/vps/project",
        ),
      ).toContain("/vps/project");
    } finally {
      responder.unregister();
    }
  });
});
