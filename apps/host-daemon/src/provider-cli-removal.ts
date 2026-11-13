import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { hostToolchain } from "@bb/process-utils";
import type {
  ProviderInstallationCommand,
  ProviderInstallationStatus,
} from "@bb/provider-bridge-protocol";
import {
  formatCommand,
  npmCommand,
} from "@bb/provider-bridge-protocol/bridge-kit";

const packageIdentitySchema = z.object({ name: z.string().min(1) });

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

const removeNativeCliScript = `
const fs = require("node:fs/promises");
const path = require("node:path");
const [root, ...links] = process.argv.slice(1);
const inside = (file) => {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
(async () => {
  if (await fs.realpath(root) !== root) throw Error("The CLI installation directory changed.");
  for (const link of links) {
    try {
      const target = await fs.realpath(link);
      if (!(await fs.lstat(link)).isSymbolicLink() || !inside(target)) {
        throw Error("The CLI launcher changed: " + link);
      }
      await fs.unlink(link);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await fs.rm(root, { recursive: true, force: false });
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;

export async function providerCliRemovalCommand(
  status: ProviderInstallationStatus,
  homeDir = os.homedir(),
): Promise<ProviderInstallationCommand | null> {
  if (!status.installed || status.executablePath === null) return null;
  try {
    const executable = await realpath(status.executablePath);
    if (
      status.npmPackageName !== null &&
      /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu.test(
        status.npmPackageName,
      )
    ) {
      const marker = `${path.sep}node_modules${path.sep}`;
      const markerIndex = executable.lastIndexOf(marker);
      if (markerIndex >= 0) {
        const modules = executable.slice(0, markerIndex + marker.length - 1);
        const packageRoot = path.join(modules, status.npmPackageName);
        const identity = packageIdentitySchema.parse(
          JSON.parse(
            await readFile(path.join(packageRoot, "package.json"), "utf8"),
          ),
        );
        if (
          identity.name !== status.npmPackageName ||
          !isInside(executable, packageRoot)
        )
          return null;
        const packagePrefix = path.dirname(modules);
        const globalPrefix = path.dirname(packagePrefix);
        const global =
          path.basename(packagePrefix) === "lib" &&
          path.dirname(status.executablePath) ===
            path.join(globalPrefix, "bin");
        const prefix = global ? globalPrefix : packagePrefix;
        await access(prefix, constants.W_OK);
        await access(modules, constants.W_OK);
        const command = npmCommand();
        const args = [
          "uninstall",
          ...(global ? ["--global"] : []),
          "--prefix",
          prefix,
          "--no-audit",
          "--no-fund",
          "--",
          status.npmPackageName,
        ];
        return { command, args, displayCommand: formatCommand(command, args) };
      }
    }
    if (process.platform === "win32") return null;
    const nativeName =
      status.executableName === "cursor-agent"
        ? "cursor-agent"
        : status.executableName === "claude"
          ? "claude"
          : null;
    if (nativeName === null) return null;
    const root = path.join(homeDir, ".local", "share", nativeName);
    if (!isInside(executable, root) || (await realpath(root)) !== root)
      return null;
    await access(root, constants.W_OK);
    await access(path.dirname(root), constants.W_OK);
    await access(path.join(homeDir, ".local", "bin"), constants.W_OK);
    const names =
      nativeName === "cursor-agent" ? ["cursor-agent", "agent"] : ["claude"];
    const links = names.map((name) =>
      path.join(homeDir, ".local", "bin", name),
    );
    const targets = await Promise.all(
      links.map((link) => realpath(link).catch(() => null)),
    );
    if (targets.some((target) => target !== null && !isInside(target, root)))
      return null;
    return {
      command: hostToolchain.node(),
      args: ["-e", removeNativeCliScript, root, ...links],
      displayCommand: `Remove ${nativeName} CLI from ${root}`,
    };
  } catch {
    return null;
  }
}
