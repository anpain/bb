import type {
  DesktopComputerAction,
  DesktopComputerResult,
} from "@bb/host-daemon-contract";
import type { ComputerWindowIdentity } from "./desktop-computer-native.js";

type Scope = { webContentsId: number; threadId: string };
type Grant = Scope & {
  windowId: string;
  title: string;
  identity: ComputerWindowIdentity;
  expiresAt: number;
  lastCapture: number;
  lastAspect: number | null;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
};

export function createDesktopComputer(options: {
  identify(
    windowId: string,
    signal: AbortSignal,
  ): Promise<ComputerWindowIdentity>;
  input(
    windowId: string,
    identity: ComputerWindowIdentity,
    action: Exclude<
      DesktopComputerAction,
      { action: "status" | "stop" | "request_access" }
    >,
    signal: AbortSignal,
    aspect: number | null,
  ): Promise<void>;
  capture(
    windowId: string,
    signal: AbortSignal,
  ): Promise<NonNullable<DesktopComputerResult["screenshot"]>>;
  onStop(): void;
}) {
  let grant: Grant | null = null;
  let queue: Promise<void> = Promise.resolve();
  let generation = 0;
  const stop = () => {
    generation++;
    const previous = grant;
    grant = null;
    previous?.controller.abort();
    if (previous) {
      clearTimeout(previous.timer);
      options.onStop();
    }
  };
  const owned = (scope: Scope) => {
    if (grant && grant.expiresAt <= Date.now()) stop();
    return grant?.webContentsId === scope.webContentsId &&
      grant.threadId === scope.threadId
      ? grant
      : null;
  };
  const status = (current: Grant | null): DesktopComputerResult => ({
    active: current !== null,
    window: current?.title ?? null,
    expiresAt: current?.expiresAt ?? null,
    screenshot: null,
  });
  return {
    stop,
    async allow(scope: Scope, windowId: string, title: string) {
      stop();
      const expected = generation;
      const identity = await options.identify(
        windowId,
        AbortSignal.timeout(15_000),
      );
      if (generation !== expected)
        throw new Error("Computer access was cancelled");
      const timer = setTimeout(stop, 30 * 60_000);
      timer.unref();
      grant = {
        ...scope,
        windowId,
        title,
        identity,
        expiresAt: Date.now() + 30 * 60_000,
        lastCapture: 0,
        lastAspect: null,
        controller: new AbortController(),
        timer,
      };
      return status(grant);
    },
    async execute(
      scope: Scope,
      action: DesktopComputerAction,
    ): Promise<DesktopComputerResult> {
      const current = owned(scope);
      if (action.action === "request_access")
        throw new Error(
          "Access requests must be handled by the local Desktop UI",
        );
      if (action.action === "status") return status(current);
      if (!current)
        throw new Error(
          "Computer access is disabled for this chat. Choose File → Computer control on the PC and allow a window first.",
        );
      if (action.action === "stop") {
        stop();
        return status(null);
      }
      const task = queue.then(async () => {
        if (owned(scope) !== current)
          throw new Error("Computer access was revoked");
        const signal = current.controller.signal;
        if (
          action.action !== "screenshot" &&
          (current.lastCapture === 0 ||
            Date.now() - current.lastCapture > 30_000)
        )
          throw new Error(
            "Take a new screenshot of the allowed window before each input action",
          );
        current.lastCapture = 0;
        const aspect = current.lastAspect;
        current.lastAspect = null;
        try {
          await options.input(
            current.windowId,
            current.identity,
            action,
            signal,
            aspect,
          );
          const screenshot =
            action.action === "screenshot"
              ? await options.capture(current.windowId, signal)
              : null;
          signal.throwIfAborted();
          if (screenshot) {
            current.lastCapture = Date.now();
            current.lastAspect = screenshot.width / screenshot.height;
          }
          return { ...status(current), screenshot };
        } catch (error) {
          if (grant === current) stop();
          throw error;
        }
      });
      queue = task.then(
        () => {},
        () => {},
      );
      return task;
    },
    releaseWindow(webContentsId: number) {
      if (grant?.webContentsId === webContentsId) stop();
    },
  };
}
export type DesktopComputer = ReturnType<typeof createDesktopComputer>;
