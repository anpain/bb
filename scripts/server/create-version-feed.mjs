import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
const [archive, output, commit] = process.argv.slice(2);
const match = /^bb-app-(\d+\.\d+\.\d+)\.tgz$/u.exec(basename(archive ?? ""));
if (!match || !output || !/^[a-f0-9]{40}$/u.test(commit ?? ""))
  throw new Error(
    "Usage: node create-version-feed.mjs bb-app-VERSION.tgz output.json COMMIT",
  );
const bytes = await readFile(archive);
await writeFile(
  output,
  JSON.stringify(
    {
      version: match[1],
      commit,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      packageUrl: `https://github.com/anpain/bb/releases/download/desktop-latest/${basename(archive)}`,
    },
    null,
    2,
  ) + "\n",
);
