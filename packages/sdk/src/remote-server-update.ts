import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { serverUpdaterScript } from "./generated/server-updater.generated.js";

const releaseSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    commit: z.string().regex(/^[a-f0-9]{40}$/u),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    size: z.number().int().positive(),
    packageUrl: z.string(),
  })
  .refine(
    (release) =>
      release.packageUrl ===
      `https://github.com/anpain/bb/releases/download/desktop-latest/bb-app-${release.version}.tgz`,
  );
const sshSchema = z.object({
  target: z
    .string()
    .max(255)
    .regex(/^(?:[\w][\w.-]*@)?[\w][\w.-]*$/u),
  identityFile: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[^\r\n\0]+$/u)
    .nullable(),
  remotePort: z.number().int().min(1024).max(65534),
});
const configSchema = z.object({
  dataDir: z.string().regex(/^\/[a-zA-Z0-9._/-]+\/data$/u),
  hostDaemonPort: z.number().int().min(1024).max(65535),
  primaryHostPlatform: z.literal("linux"),
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function experimental_getServerRelease(
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
) {
  const response = await (options.fetch ?? fetch)(
    "https://github.com/anpain/bb/releases/download/desktop-latest/server-version-linux-x64.json",
    {
      signal: AbortSignal.any([
        AbortSignal.timeout(30_000),
        ...(options.signal ? [options.signal] : []),
      ]),
    },
  );
  if (!response.ok)
    throw new Error(`Server release download failed: HTTP ${response.status}`);
  return releaseSchema.parse(await response.json());
}

function sshCommand(
  args: string[],
  command: string,
  input: string | null,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...args, command], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let failure: Error | null = null;
    const stop = () => {
      failure = new Error("SSH request cancelled or timed out");
      child.kill();
    };
    signal.addEventListener("abort", stop, { once: true });
    const receive = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-64_000);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.stdin.on("error", (error) => {
      failure = error;
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", stop);
      if (failure || code !== 0)
        reject(
          new Error(output || failure?.message || `SSH exited with ${code}`),
        );
      else resolve(output);
    });
    child.stdin.end(input ?? undefined);
    if (signal.aborted) stop();
  });
}

export async function experimental_updateRemoteServer(options: {
  serverUrl: string;
  ssh: z.infer<typeof sshSchema>;
  version: string;
  service?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?(message: string): void;
}): Promise<{ version: string; unit: string }> {
  const settings = sshSchema.parse(options.ssh);
  const service = z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,60}$/u)
    .parse(options.service ?? "bb-fork");
  const expected = z
    .string()
    .regex(/^\d+\.\d+\.\d+$/u)
    .parse(options.version);
  const url = new URL(options.serverUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use an HTTP(S) server URL without credentials");
  let identity = settings.identityFile;
  if (identity?.startsWith("~/") || identity?.startsWith("~\\"))
    identity = join(homedir(), identity.slice(2));
  if (identity !== null && !isAbsolute(identity))
    throw new Error("Use an absolute SSH key path or ~/.");
  const signal = AbortSignal.any([
    AbortSignal.timeout(15 * 60_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const request = options.fetch ?? fetch;
  const read = async (path: string) => {
    const response = await request(new URL(path, url), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`Server preflight failed: HTTP ${response.status}`);
    return response.json();
  };
  options.onProgress?.("Checking server and active agents...");
  const [config, running, release] = await Promise.all([
    read("/api/v1/system/config").then((value) => configSchema.parse(value)),
    read("/api/v1/threads/running").then((value) =>
      z.array(z.unknown()).parse(value),
    ),
    experimental_getServerRelease({ fetch: request, signal }),
  ]);
  if (running.length)
    throw new Error(
      "Agents are running on this server. Stop them and retry the update.",
    );
  if (release.version !== expected)
    throw new Error(
      "The available server release changed. Check for updates again.",
    );
  const prefix = posix.dirname(config.dataDir);
  const unit = `bb-server-update-${randomUUID()}`;
  const remoteScript = `/run/${unit}.sh`;
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "PermitLocalCommand=no",
    ...(identity === null ? [] : ["-o", "IdentitiesOnly=yes", "-i", identity]),
    "--",
    settings.target,
  ];
  const command = async (text: string, input: string | null = null) =>
    sshCommand(
      args,
      text,
      input,
      AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    );
  const updaterArgs = [
    "--prefix",
    prefix,
    "--service",
    service,
    "--port",
    String(settings.remotePort),
    "--daemon-port",
    String(config.hostDaemonPort),
    "--expected-version",
    expected,
  ]
    .map(quote)
    .join(" ");
  options.onProgress?.("Starting independent server update task...");
  await command(
    `set -eu; umask 077; f=$(mktemp /tmp/bb-update-client.XXXXXXXX); trap 'rm -f -- "$f"' EXIT; cat > "$f"; node_path=$(sudo -n readlink -f "/proc/$(systemctl show ${quote(service + ".service")} -p MainPID --value)/exe"); node_dir=$(dirname "$node_path"); sudo -n install -m 0700 -- "$f" ${quote(remoteScript)}; sudo -n systemd-run --quiet --no-block --unit=${quote(unit)} --property=Type=oneshot --property=RemainAfterExit=yes ${quote(`--property=ExecStopPost=/usr/bin/rm -f ${remoteScript}`)} /bin/bash ${quote(remoteScript)} ${updaterArgs} --node-dir "$node_dir"`,
    serverUpdaterScript,
  );
  let previous = "";
  let complete = false;
  try {
    while (!signal.aborted) {
      let status: string;
      try {
        status = await command(
          `sudo -n systemctl show ${quote(unit)} -p ActiveState -p Result -p ExecMainStatus; printf '\nBB_UPDATE_LOG\n'; sudo -n journalctl -u ${quote(unit)} -n 12 --no-pager -o cat`,
        );
      } catch {
        options.onProgress?.("Reconnecting to the server update task...");
        await delay(2_000, undefined, { signal });
        continue;
      }
      const [properties = "", log = ""] = status.split("\nBB_UPDATE_LOG\n");
      const fields = Object.fromEntries(
        properties
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      if (log !== previous) {
        options.onProgress?.(log.trim());
        previous = log;
      }
      if (
        fields.ActiveState === "failed" ||
        (fields.ActiveState === "inactive" && fields.Result !== "success")
      )
        throw new Error(log.trim() || "Server update failed.");
      if (
        fields.ActiveState === "active" &&
        fields.Result === "success" &&
        fields.ExecMainStatus === "0"
      ) {
        complete = true;
        break;
      }
      await delay(2_000, undefined, { signal });
    }
    signal.throwIfAborted();
    options.onProgress?.("Verifying updated server and daemon...");
    for (;;) {
      try {
        const version = z
          .object({ currentVersion: z.string() })
          .parse(await read("/api/v1/system/version"));
        const hosts = z
          .array(z.object({ status: z.string(), id: z.string() }))
          .parse(await read("/api/v1/hosts"));
        const configAfter = z
          .object({ primaryHostId: z.string().nullable(), dataDir: z.string() })
          .parse(await read("/api/v1/system/config"));
        if (
          version.currentVersion === expected &&
          configAfter.dataDir === config.dataDir &&
          hosts.some(
            (host) =>
              host.id === configAfter.primaryHostId &&
              host.status === "connected",
          )
        )
          break;
      } catch {
        signal.throwIfAborted();
      }
      await delay(2_000, undefined, { signal });
    }
    return { version: expected, unit };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : "Server update monitoring failed"}\nUpdate task: ${unit}. Closing the client does not cancel the server task.`,
    );
  } finally {
    if (complete)
      await command(
        `sudo -n systemctl stop ${quote(unit)}; sudo -n systemctl reset-failed ${quote(unit)} 2>/dev/null || true`,
      ).catch(() => undefined);
  }
}
