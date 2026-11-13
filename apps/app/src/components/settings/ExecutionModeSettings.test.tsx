// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerChoicesState } from "@/hooks/useServerChoices";
import { ExecutionModeSettings } from "./ExecutionModeSettings";

const mocks = vi.hoisted(() => ({
  choices: null as ServerChoicesState | null,
  add: vi.fn(),
}));
vi.mock("@/hooks/useServerChoices", () => ({
  useServerChoices: () => mocks.choices,
}));
vi.mock("@/lib/bb-desktop", () => ({
  getBbDesktopInfo: () => (mocks.choices ? { addServer: mocks.add } : null),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("execution mode settings", () => {
  it.each([true, false])(
    "switches between local and remote execution, local active: %s",
    (localActive) => {
      const switchTo = vi.fn();
      mocks.choices = {
        status: "ready",
        servers: [
          {
            id: "builtin",
            name: "This computer",
            origin: "http://127.0.0.1:38886",
            kind: "local",
            active: localActive,
          },
          {
            id: "remote",
            name: "VPS",
            origin: "http://127.0.0.1:48886",
            kind: "custom",
            active: !localActive,
          },
        ],
        switchTo,
      };
      render(<ExecutionModeSettings />);
      expect(
        screen
          .getByRole("button", { name: "Connected" })
          .hasAttribute("disabled"),
      ).toBe(true);
      fireEvent.click(
        screen.getByRole("button", {
          name: localActive ? "Use server" : "Use local",
        }),
      );
      expect(switchTo).toHaveBeenCalledWith(localActive ? "remote" : "builtin");
      fireEvent.click(screen.getByRole("button", { name: "Add server" }));
      expect(mocks.add).toHaveBeenCalledOnce();
    },
  );

  it("explains the current browser connection without offering an unavailable local runtime", () => {
    mocks.choices = null;
    render(<ExecutionModeSettings />);
    expect(screen.getByText(/Open bb Desktop/)).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
