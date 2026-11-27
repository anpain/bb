import semver from "semver";
import { z } from "zod";

const versionSchema = z.object({
  currentVersion: z.string().refine((value) => semver.valid(value) !== null),
});
const feedSchema = z.object({
  version: z.string().refine((value) => semver.valid(value) !== null),
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().positive(),
  packageUrl: z
    .string()
    .url()
    .refine(
      (value) =>
        value.startsWith(
          "https://github.com/anpain/bb/releases/download/desktop-latest/bb-app-",
        ) && value.endsWith(".tgz"),
    ),
});

export function createRemoteServerUpdateCheck(options: {
  fetch: typeof fetch;
  notify(input: {
    serverUrl: string;
    currentVersion: string;
    latestVersion: string;
  }): Promise<void>;
}) {
  const announced = new Set<string>();
  let controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let checkCurrent: (() => Promise<void>) | null = null;
  const stop = () => {
    controller.abort();
    if (timer) clearTimeout(timer);
    if (interval) clearInterval(interval);
    timer = null;
    interval = null;
    checkCurrent = null;
  };
  return {
    stop,
    async checkNow() {
      announced.clear();
      await checkCurrent?.();
    },
    start(serverUrl: string) {
      stop();
      controller = new AbortController();
      const signal = controller.signal;
      let busy = false;
      const check = async () => {
        if (busy || signal.aborted) return;
        busy = true;
        try {
          const requestSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(15_000),
          ]);
          const response = await options.fetch(
            new URL("/api/v1/system/version", serverUrl),
            { signal: requestSignal, redirect: "error" },
          );
          if (!response.ok) return;
          const version = versionSchema.parse(
            await response.json(),
          ).currentVersion;
          let latest: string | null = null;
          try {
            const feed = await options.fetch(
              "https://github.com/anpain/bb/releases/download/desktop-latest/server-version-linux-x64.json",
              { signal: requestSignal },
            );
            if (feed.ok) {
              const candidate = feedSchema.parse(await feed.json()).version;
              latest = candidate;
            }
          } catch {
            if (signal.aborted) return;
          }
          if (
            signal.aborted ||
            latest === null ||
            !semver.valid(latest) ||
            !semver.gt(latest, version)
          )
            return;
          const key = JSON.stringify([serverUrl, version, latest]);
          if (announced.has(key)) return;
          announced.add(key);
          await options.notify({
            serverUrl,
            currentVersion: version,
            latestVersion: latest,
          });
        } catch {
        } finally {
          busy = false;
        }
      };
      timer = setTimeout(() => {
        void check();
      }, 10_000);
      interval = setInterval(() => {
        void check();
      }, 60 * 60_000);
      timer.unref();
      interval.unref();
      checkCurrent = check;
    },
  };
}
