import { describe, expect, it, vi } from "vitest";
import { createDesktopComputer } from "../src/desktop-computer.js";

const scope = { webContentsId: 7, threadId: "thr_test" };
function fixture() {
  const input = vi.fn(async () => {});
  const capture = vi.fn(async () => ({
    mimeType: "image/jpeg" as const,
    width: 800,
    height: 600,
    base64: "frame",
  }));
  const onStop = vi.fn();
  const computer = createDesktopComputer({
    identify: async () => ({ pid: 1, started: "123" }),
    input,
    capture,
    onStop,
  });
  return { computer, input, capture, onStop };
}
describe("explicit local computer grants", () => {
  it("denies disabled and cross-chat access without exposing window titles", async () => {
    const { computer, input, capture } = fixture();
    await expect(
      computer.execute(scope, { action: "screenshot" }),
    ).rejects.toThrow("disabled");
    await computer.allow(scope, "123", "Private window");
    try {
      for (const other of [
        { ...scope, threadId: "another" },
        { ...scope, webContentsId: 9 },
      ]) {
        expect(
          await computer.execute(other, { action: "status" }),
        ).toMatchObject({ active: false, window: null });
        await expect(
          computer.execute(other, { action: "stop" }),
        ).rejects.toThrow("disabled");
      }
      expect((await computer.execute(scope, { action: "status" })).active).toBe(
        true,
      );
      expect(input).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    } finally {
      computer.stop();
    }
  });
  it("requires a fresh screenshot before every input and revokes on window closure", async () => {
    const { computer, input } = fixture();
    await computer.allow(scope, "123", "Allowed");
    try {
      await expect(
        computer.execute(scope, { action: "type", text: "hello" }),
      ).rejects.toThrow("screenshot");
      await computer.execute(scope, { action: "screenshot" });
      await computer.execute(scope, { action: "type", text: "hello" });
      await expect(
        computer.execute(scope, { action: "key", key: "Enter" }),
      ).rejects.toThrow("screenshot");
      expect(input).toHaveBeenCalledTimes(2);
      computer.releaseWindow(scope.webContentsId);
      expect((await computer.execute(scope, { action: "status" })).active).toBe(
        false,
      );
    } finally {
      computer.stop();
    }
  });
  it("cancels pending input and rejects queued work immediately when stopped", async () => {
    let entered: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const computer = createDesktopComputer({
      identify: async () => ({ pid: 1, started: "123" }),
      input: async (_window, _identity, action, signal) => {
        if (action.action === "screenshot") return;
        entered?.();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("revoked")), {
            once: true,
          });
        });
      },
      capture: async () => ({
        mimeType: "image/jpeg",
        width: 10,
        height: 10,
        base64: "frame",
      }),
      onStop: () => {},
    });
    await computer.allow(scope, "123", "Allowed");
    await computer.execute(scope, { action: "screenshot" });
    const pending = computer.execute(scope, { action: "type", text: "first" });
    const queued = computer.execute(scope, { action: "screenshot" });
    const outcomes = Promise.allSettled([pending, queued]);
    await ready;
    computer.stop();
    expect((await outcomes).map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect((await computer.execute(scope, { action: "status" })).active).toBe(
      false,
    );
  });
});
