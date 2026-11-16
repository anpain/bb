import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerImportChatCommand } from "../../commands/thread/import-chat.js";
import {
  setupCommandOutputTestEnvironment,
  runCommand,
  collectLogLines,
} from "../helpers/command-output-harness.js";

describe("chat import context preview", () => {
  setupCommandOutputTestEnvironment();
  it.each([undefined, { mode: "range", startMessage: 1, endMessage: 2 }])(
    "previews context %j without contacting a server",
    async (context) => {
      const directory = await mkdtemp(join(tmpdir(), "bb-cli-import-"));
      const file = join(directory, "chat.json");
      const getUrl = vi.fn(() => {
        throw new Error("Preview must not contact a server");
      });
      try {
        await writeFile(
          file,
          JSON.stringify({
            providerId: "codex",
            sourceId: "preview",
            title: "Preview",
            context,
            messages: [
              { role: "user", text: "Original task" },
              { role: "assistant", text: "Next step" },
            ],
          }),
        );
        await runCommand(
          ["thread", "import-chat", file, "--preview", "--json"],
          (program) =>
            registerImportChatCommand(program.command("thread"), getUrl),
        );
        const result = JSON.parse(
          collectLogLines(vi.mocked(console.log)).join("\n"),
        );
        expect(getUrl).not.toHaveBeenCalled();
        expect(result.messages).toBe(context === undefined ? 0 : 1);
        if (context === undefined)
          expect(result.estimatedTextTokens.max).toBe(0);
        else expect(result.estimatedTextTokens.max).toBeGreaterThan(0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
