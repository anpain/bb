import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderInstallationStatus } from "@bb/provider-bridge-protocol";
import { providerCliRemovalCommand } from "./provider-cli-removal.js";

function status(
  overrides: Partial<ProviderInstallationStatus>,
): ProviderInstallationStatus {
  return {
    executableName: "codex",
    executablePath: null,
    installed: true,
    installSource: "external",
    currentVersion: "1.0.0",
    latestVersion: null,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction: null,
    needsUpdate: false,
    versionUnsupported: false,
    ...overrides,
  };
}

describe("provider CLI removal", () => {
  it("targets the owning npm prefix and rejects a mismatched package", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-cli-npm-remove-"));
    try {
      const packageRoot = path.join(root, "node_modules", "@openai", "codex");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "@openai/codex" }),
      );
      const executablePath = path.join(packageRoot, "cli.js");
      await writeFile(executablePath, "");
      const installed = status({
        executablePath,
        npmPackageName: "@openai/codex",
      });
      expect(await providerCliRemovalCommand(installed)).toMatchObject({
        args: [
          "uninstall",
          "--prefix",
          await realpath(root),
          "--no-audit",
          "--no-fund",
          "--",
          "@openai/codex",
        ],
      });
      expect(
        await providerCliRemovalCommand({
          ...installed,
          npmPackageName: "@anthropic-ai/claude-code",
        }),
      ).toBeNull();
      expect(
        await providerCliRemovalCommand({ ...installed, installed: false }),
      ).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "removes native Cursor binaries and launchers while retaining credentials",
    async () => {
      const home = await mkdtemp(
        path.join(os.tmpdir(), "bb-cli-native-remove-"),
      );
      try {
        const root = path.join(home, ".local", "share", "cursor-agent");
        const executable = path.join(root, "versions", "test", "cursor-agent");
        const bin = path.join(home, ".local", "bin");
        const credentials = path.join(home, ".cursor", "auth.json");
        await mkdir(path.dirname(executable), { recursive: true });
        await mkdir(bin, { recursive: true });
        await mkdir(path.dirname(credentials), { recursive: true });
        await writeFile(executable, "");
        await writeFile(credentials, "credential sentinel");
        await symlink(executable, path.join(bin, "cursor-agent"));
        await symlink(executable, path.join(bin, "agent"));
        const plan = await providerCliRemovalCommand(
          status({
            executableName: "cursor-agent",
            executablePath: path.join(bin, "cursor-agent"),
          }),
          home,
        );
        if (plan === null) throw new Error("Expected a native removal plan");
        await promisify(execFile)(plan.command, plan.args);
        await expect(readFile(executable)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(readFile(path.join(bin, "agent"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readFile(credentials, "utf8")).toBe("credential sentinel");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
