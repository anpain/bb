import {
  internal_DO_NOT_USE_desktopComputerActionSchema as desktopComputerActionSchema,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

export const COMPUTER_TOOL = "bb_computer";
const inputSchema = z
  .object({
    hostId: z.string().min(1).nullable(),
    instanceId: z.string().min(1).nullable().default(null),
    input: desktopComputerActionSchema,
  })
  .strict();

export function registerComputerTool(bb: BbPluginApi) {
  bb.agents.registerTool({
    name: COMPUTER_TOOL,
    description:
      "Control a Windows window explicitly allowed for this chat. Use request_access with a reason to show a local approval prompt in the focused bb chat; the user chooses and approves a window. This only requests access: wait for status active before input. hostId null discovers an allowed PC or a single candidate for a request; specify hostId and instanceId from the returned candidates if ambiguous. Actions: request_access, status, screenshot, click, type, key, scroll, stop. The model may run on a VPS. Click/scroll coordinates are normalized 0..1 in the latest screenshot. Take and inspect a fresh screenshot before each input. Only the chosen window is allowed. You may type authorized shell commands into an explicitly approved terminal window; commands then execute on the PC, not the VPS. There is no separate unrestricted remote-shell tool. Stop immediately when requested.",
    presentation: {
      label: {
        pending: "Using allowed PC window",
        completed: "Used allowed PC window",
      },
      icon: { glyph: "Monitor" },
    },
    parameters: inputSchema,
    async execute(input, context) {
      const api = bb.sdk.experimental_desktopBrowsers;
      try {
        const discovery = AbortSignal.any([
          context.signal,
          AbortSignal.timeout(15_000),
        ]);
        const hosts = input.hostId
          ? [{ id: input.hostId }]
          : (await bb.sdk.hosts.list({ signal: discovery })).filter(
              (host) => host.status === "connected",
            );
        const targets: {
          hostId: string;
          instanceId: string;
          generation: string;
          threadId: string;
        }[] = [];
        const candidates: typeof targets = [];
        for (const host of hosts.slice(0, 100)) {
          discovery.throwIfAborted();
          const instances = await api
            .listInstances({ hostId: host.id }, discovery)
            .catch(() => ({ instances: [] }));
          for (const instance of instances.instances) {
            if (
              input.instanceId !== null &&
              input.instanceId !== instance.instanceId
            )
              continue;
            discovery.throwIfAborted();
            const scope = {
              hostId: host.id,
              instanceId: instance.instanceId,
              generation: instance.generation,
              threadId: context.threadId,
            };
            const status = await api
              .experimental_computer(
                { ...scope, input: { action: "status" } },
                discovery,
              )
              .catch(() => null);
            if (status !== null) candidates.push(scope);
            if (status?.active) targets.push(scope);
          }
        }
        const selected =
          input.input.action === "request_access" && targets.length === 0
            ? candidates
            : targets;
        if (selected.length !== 1)
          throw new Error(
            selected.length === 0
              ? "No PC window is allowed for this chat. On the Windows PC choose File → Computer control, select a window and allow this chat. This PC must be connected as a machine to the selected bb server."
              : `Several Desktop targets are available. Specify hostId and instanceId from these candidates: ${JSON.stringify(selected.map(({ hostId, instanceId }) => ({ hostId, instanceId })))}`,
          );
        const scope = selected[0]!;
        const stop = () => {
          void api
            .experimental_computer(
              { ...scope, input: { action: "stop" } },
              AbortSignal.timeout(5000),
            )
            .catch(() => {});
        };
        context.signal.addEventListener("abort", stop, { once: true });
        try {
          if (context.signal.aborted) stop();
          context.signal.throwIfAborted();
          const result = await api.experimental_computer(
            {
              ...scope,
              input: input.input,
            },
            AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]),
          );
          context.signal.throwIfAborted();
          const text = JSON.stringify({
            ...scope,
            active: result.active,
            accessRequested: input.input.action === "request_access",
            window: result.window,
            expiresAt: result.expiresAt,
            screenshot: result.screenshot
              ? {
                  width: result.screenshot.width,
                  height: result.screenshot.height,
                }
              : null,
          });
          return {
            content: [
              { type: "text" as const, text },
              ...(result.screenshot
                ? [
                    {
                      type: "image" as const,
                      data: result.screenshot.base64,
                      mimeType: result.screenshot.mimeType,
                    },
                  ]
                : []),
            ],
          };
        } finally {
          context.signal.removeEventListener("abort", stop);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Computer control failed",
            },
          ],
          isError: true,
        };
      }
    },
  });
}
