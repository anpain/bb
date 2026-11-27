import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { experimental_updateRemoteServer } from "../src/remote-server-update.js";
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
afterEach(() => vi.clearAllMocks());
const feed = {
  version: "0.49.15",
  commit: "a".repeat(40),
  sha256: "b".repeat(64),
  size: 10,
  packageUrl:
    "https://github.com/anpain/bb/releases/download/desktop-latest/bb-app-0.49.15.tgz",
};
function options(running = false) {
  return {
    serverUrl: "http://127.0.0.1:48886",
    ssh: { target: "user@server", identityFile: null, remotePort: 38886 },
    version: feed.version,
    fetch: vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("server-version")) return Response.json(feed);
      if (url.endsWith("threads/running"))
        return Response.json(running ? [{ id: "active" }] : []);
      if (url.endsWith("system/version"))
        return Response.json({ currentVersion: feed.version });
      if (url.endsWith("hosts"))
        return Response.json([{ id: "host", status: "connected" }]);
      return Response.json({
        dataDir: "/srv/bb/data",
        hostDaemonPort: 38887,
        primaryHostPlatform: "linux",
        primaryHostId: "host",
      });
    }),
  };
}
function fakeSsh(status: string) {
  spawn.mockImplementation((_file, args: string[]) => {
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = Object.assign(new EventEmitter(), {
      end: vi.fn(() =>
        queueMicrotask(() => {
          if (args.at(-1)?.includes("BB_UPDATE_LOG"))
            stdout.emit("data", Buffer.from(status));
          child.emit("close", 0);
        }),
      ),
    });
    return Object.assign(child, { stdout, stderr, stdin, kill: vi.fn() });
  });
}
it("refuses active agents before launching SSH", async () => {
  await expect(experimental_updateRemoteServer(options(true))).rejects.toThrow(
    "Agents are running",
  );
  expect(spawn).not.toHaveBeenCalled();
});
it("pins the offered release and rejects a changed feed", async () => {
  await expect(
    experimental_updateRemoteServer({ ...options(), version: "0.49.14" }),
  ).rejects.toThrow("release changed");
  expect(spawn).not.toHaveBeenCalled();
});
it("starts a detached systemd task using the bundled updater and verifies the daemon", async () => {
  fakeSsh(
    "ActiveState=active\nResult=success\nExecMainStatus=0\n\nBB_UPDATE_LOG\nUpdated bb\n",
  );
  const input = options();
  const result = await experimental_updateRemoteServer(input);
  expect(result.version).toBe(feed.version);
  const launch = spawn.mock.calls[0];
  expect(launch?.[0]).toBe("ssh");
  expect(launch?.[1]).toContain("BatchMode=yes");
  expect(launch?.[1]).toContain("StrictHostKeyChecking=yes");
  expect(launch?.[1].at(-1)).toContain("systemd-run");
  expect(launch?.[1].at(-1)).toContain("--no-block");
  expect(launch?.[1].at(-1)).toContain("--expected-version");
  expect(
    input.fetch.mock.calls.some(([url]) => String(url).endsWith("/hosts")),
  ).toBe(true);
});
it("reports failed backup or install rather than claiming success", async () => {
  fakeSsh(
    "ActiveState=failed\nResult=exit-code\nExecMainStatus=1\n\nBB_UPDATE_LOG\nBackup failed; restored previous service\n",
  );
  await expect(experimental_updateRemoteServer(options())).rejects.toThrow(
    "Backup failed",
  );
});
it("rejects SSH option injection before requesting or launching anything", async () => {
  const input = options();
  await expect(
    experimental_updateRemoteServer({
      ...input,
      ssh: { ...input.ssh, target: "-oProxyCommand=evil" },
    }),
  ).rejects.toThrow();
  expect(input.fetch).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});
