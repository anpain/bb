import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import electron from "electron";

if (process.platform !== "win32")
  throw new Error("The native computer-control smoke requires Windows");
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const artifacts = join(
  root,
  "node_modules/.bb-build-cache/computer-control-smoke",
  String(Date.now()),
);
await mkdir(artifacts, { recursive: true });
const entry = join(artifacts, "main.cjs");
await build({
  entryPoints: [
    join(root, "apps/desktop/test/fixtures/computer-control-smoke.ts"),
  ],
  outfile: entry,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const code = await new Promise((resolve, reject) => {
  const child = spawn(electron, [entry, artifacts], {
    env,
    windowsHide: true,
    stdio: "inherit",
  });
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error("Native computer-control smoke timed out"));
  }, 90_000);
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once("exit", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});
const result = JSON.parse(
  await readFile(join(artifacts, "result.json"), "utf8"),
);
console.log(JSON.stringify({ ...result, artifacts }));
if (code !== 0 || !result.ok) process.exitCode = 1;
