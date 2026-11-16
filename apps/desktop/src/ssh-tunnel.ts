import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

export const sshTunnelSettingsSchema = z.object({
  target: z
    .string()
    .trim()
    .max(255)
    .regex(/^(?:[\w][\w.-]*@)?[\w][\w.-]*$/u),
  identityFile: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .regex(/^[^\r\n\0]+$/u)
    .nullable(),
  remotePort: z.number().int().min(1).max(65535),
});

export type SshTunnelSettings = z.infer<typeof sshTunnelSettingsSchema>;

export function sshLocalPort(url: string): number | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  const port = Number(parsed.port);
  return parsed.origin === url &&
    parsed.protocol === "http:" &&
    parsed.hostname === "127.0.0.1" &&
    port >= 1024 &&
    port <= 65535 &&
    port !== 38886
    ? port
    : null;
}

export function resolveSshIdentityFile(path: string): string | null {
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return isAbsolute(path) ? path : null;
}

export function sshTunnelArguments(
  url: string,
  settings: SshTunnelSettings,
): string[] {
  const port = sshLocalPort(url);
  if (port === null)
    throw new Error("Select a separate 127.0.0.1 port for the SSH server.");
  const identity =
    settings.identityFile === null
      ? null
      : resolveSshIdentityFile(settings.identityFile);
  if (settings.identityFile !== null && identity === null) {
    throw new Error(
      "Enter an absolute SSH key path or a path starting with ~/.",
    );
  }
  return [
    "-N",
    "-T",
    "-v",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ExitOnForwardFailure=yes",
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
    "ForkAfterAuthentication=no",
    "-o",
    "PermitLocalCommand=no",
    ...(identity === null ? [] : ["-o", "IdentitiesOnly=yes", "-i", identity]),
    "-L",
    `127.0.0.1:${port}:127.0.0.1:${settings.remotePort}`,
    "--",
    settings.target,
  ];
}

export interface SshTunnel {
  ready: Promise<void>;
  closed: Promise<Error>;
  stop(): Promise<void>;
}

export function startSshTunnel(
  url: string,
  settings: SshTunnelSettings,
): SshTunnel {
  const args = sshTunnelArguments(url, settings);
  const port = Number(new URL(url).port);
  let stopped = false;
  const launch = new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () =>
      reject(
        new Error(
          `Local port ${port} is already in use or unavailable. Close the other tunnel or edit the local port.`,
        ),
      ),
    );
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
  }).then(() => (stopped ? null : launchSshProcess(args)));
  const ready = launch.then((tunnel) => {
    if (tunnel === null) throw new Error("The SSH connection was cancelled.");
    return tunnel.ready;
  });
  void ready.catch(() => undefined);
  return {
    ready,
    closed: launch.then(
      (tunnel) =>
        tunnel?.closed ?? new Error("The SSH connection was cancelled."),
      (error: Error) => error,
    ),
    async stop() {
      stopped = true;
      const tunnel = await launch.catch(() => null);
      await tunnel?.stop();
    },
  };
}

function launchSshProcess(args: string[]): SshTunnel {
  const child = spawn("ssh", args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  let spawnError: Error | null = null;
  child.stderr.setEncoding("utf8");
  const closed = new Promise<Error>((resolve) => {
    child.on("error", (error) => {
      spawnError = error;
    });
    child.once("close", () => {
      const details = stderr
        .split(/\r?\n/u)
        .filter((line) => line && !/^debug\d:/u.test(line));
      resolve(
        new Error(
          details.slice(-5).join("\n") ||
            spawnError?.message ||
            "The SSH connection closed.",
        ),
      );
    });
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out opening the SSH connection."));
    }, 15_000);
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
      if (stderr.includes("debug1: Entering interactive session.")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    void closed.then((error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  void ready.catch(() => undefined);
  return {
    ready,
    closed,
    async stop() {
      if (
        child.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        child.kill("SIGKILL");
      }
      await closed;
    },
  };
}
