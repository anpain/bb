import { spawn } from "node:child_process";
import type { ProviderUsageResult } from "@bb/provider-bridge-protocol";
import { z } from "zod";

const quotaEntry = z.object({
  usedRatio: z.number().finite().nonnegative(),
  resetAt: z.string().optional(),
});
const responseSchema = z.object({
  data: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("error"),
      status: z.number().optional(),
      message: z.string(),
    }),
    z.object({
      kind: z.literal("ok"),
      quota: z.object({
        usages: z.object({
          limit5h: quotaEntry.optional(),
          limit7d: quotaEntry.optional(),
          monthTotal: quotaEntry.optional(),
          monthCode: quotaEntry.optional(),
        }),
        extraUsage: z
          .object({ balanceCents: z.number(), currency: z.string() })
          .nullable(),
      }),
    }),
  ]),
});

export async function readKimiUsage(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<ProviderUsageResult> {
  const child = spawn(
    command,
    [
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--no-open",
      "--log-level",
      "error",
    ],
    {
      env: { ...env, KIMI_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  try {
    const endpoint = await new Promise<URL>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(
        () => reject(new Error("Kimi usage service did not become ready.")),
        20_000,
      );
      const finish = (error?: Error, url?: URL) => {
        clearTimeout(timer);
        if (error) reject(error);
        else if (url) resolve(url);
      };
      child.once("error", () =>
        finish(new Error("Kimi CLI could not be started.")),
      );
      child.once("exit", () => finish(new Error("Kimi usage service exited.")));
      child.stdout.on("data", (chunk: Buffer) => {
        buffer = (buffer + chunk.toString()).slice(-16_384);
        const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s\u001b]*/u);
        if (match) {
          try {
            finish(undefined, new URL(match[0]));
          } catch {}
        }
      });
    });
    const token =
      new URLSearchParams(endpoint.hash.slice(1)).get("token") ??
      endpoint.searchParams.get("token");
    if (!token)
      return {
        supported: true,
        usage: {
          status: "error",
          accountEmail: null,
          planLabel: null,
          message: "Kimi CLI did not supply local usage authorization.",
        },
      };
    const response = await fetch(
      new URL("/api/v1/oauth/usage", endpoint.origin),
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok)
      return {
        supported: true,
        usage: {
          status: "error",
          accountEmail: null,
          planLabel: null,
          message: `Kimi usage request failed (HTTP ${response.status}).`,
        },
      };
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success)
      return {
        supported: true,
        usage: {
          status: "error",
          accountEmail: null,
          planLabel: null,
          message: "Kimi CLI usage response is unsupported.",
        },
      };
    const result = parsed.data.data;
    if (result.kind === "error") {
      if (result.status === 401)
        return { supported: true, usage: { status: "expired" } };
      if (
        /not logged|no token|not authenticated|login required|no credential/iu.test(
          result.message,
        )
      )
        return { supported: true, usage: { status: "unauthenticated" } };
      return {
        supported: true,
        usage: {
          status: "error",
          accountEmail: null,
          planLabel: null,
          message:
            "Kimi account usage is unavailable. Refresh or check the CLI separately.",
        },
      };
    }
    const windows = (
      [
        ["limit5h", "5 hours", "five-hour"],
        ["limit7d", "Weekly", "weekly"],
        ["monthTotal", "Monthly total", "monthly"],
        ["monthCode", "Monthly code", "monthly"],
      ] as const
    ).flatMap(([key, label, kind]) => {
      const entry = result.quota.usages[key];
      return entry === undefined
        ? []
        : [
            {
              label,
              kind,
              usedPercent: Math.min(100, entry.usedRatio * 100),
              resetsAt:
                entry.resetAt && Number.isFinite(Date.parse(entry.resetAt))
                  ? new Date(entry.resetAt).toISOString()
                  : null,
            },
          ];
    });
    return {
      supported: true,
      usage: {
        status: "ok",
        accountEmail: null,
        planLabel: result.quota.extraUsage
          ? `Credits remaining: ${(result.quota.extraUsage.balanceCents / 100).toFixed(2)} ${result.quota.extraUsage.currency}`
          : null,
        windows,
      },
    };
  } catch {
    return {
      supported: true,
      usage: {
        status: "error",
        accountEmail: null,
        planLabel: null,
        message: "Kimi usage could not be collected through the installed CLI.",
      },
    };
  } finally {
    child.kill("SIGTERM");
  }
}
