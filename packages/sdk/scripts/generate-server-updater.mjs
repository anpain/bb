import { readFile, mkdir, writeFile } from "node:fs/promises";
const source = new URL("../../../scripts/server/update.sh", import.meta.url);
const output = new URL(
  "../src/generated/server-updater.generated.ts",
  import.meta.url,
);
await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
await writeFile(
  output,
  `export const serverUpdaterScript = ${JSON.stringify((await readFile(source, "utf8")).replaceAll("\r\n", "\n"))};\n`,
);
