import { afterEach, expect, it, vi } from "vitest";
import { createRemoteServerUpdateCheck } from "../src/remote-server-update.js";
afterEach(() => vi.useRealTimers());
const feed = {
  version: "0.49.14",
  commit: "a".repeat(40),
  sha256: "b".repeat(64),
  size: 100,
  packageUrl:
    "https://github.com/anpain/bb/releases/download/desktop-latest/bb-app-0.49.14.tgz",
};
it("offers the server update separately, once per server and release, without performing an update", async () => {
  vi.useFakeTimers();
  const notify = vi.fn(async () => {});
  const fetch = vi.fn(
    async (url: string | URL | Request, _init?: RequestInit) =>
      Response.json(
        String(url).includes("system/version")
          ? { currentVersion: "0.49.13" }
          : feed,
      ),
  );
  const check = createRemoteServerUpdateCheck({
    currentVersion: "0.49.14",
    fetch,
    notify,
  });
  check.start("http://127.0.0.1:48886");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(notify).toHaveBeenCalledWith({
    serverUrl: "http://127.0.0.1:48886",
    currentVersion: "0.49.13",
    latestVersion: "0.49.14",
  });
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls.every(([, init]) => init?.method === undefined)).toBe(
    true,
  );
  check.stop();
});
it("does not announce an old server after the user has switched targets", async () => {
  vi.useFakeTimers();
  let resolve: ((value: Response) => void) | undefined;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  const notify = vi.fn(async () => {});
  const check = createRemoteServerUpdateCheck({
    currentVersion: "0.49.14",
    fetch: async () => pending,
    notify,
  });
  check.start("http://old.test");
  await vi.advanceTimersByTimeAsync(10_000);
  check.stop();
  resolve?.(Response.json({ currentVersion: "0.49.13" }));
  await vi.advanceTimersByTimeAsync(1);
  expect(notify).not.toHaveBeenCalled();
});
