// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ServerChoicesState } from "@/hooks/useServerChoices";
import { ExecutionLocationControl } from "./ExecutionLocationControl";
import { TooltipProvider } from "@bb/shared-ui/tooltip";

const mocks = vi.hoisted(
  (): {
    choices: ServerChoicesState | null;
    add: ReturnType<typeof vi.fn>;
    switchExecution?: (
      id: string,
    ) => Promise<{ ok: true } | { ok: false; message: string }>;
  } => ({
    choices: null,
    add: vi.fn(),
  }),
);
vi.mock("@/hooks/useServerChoices", () => ({
  useServerChoices: () => mocks.choices,
}));
vi.mock("@/lib/bb-desktop", () => ({
  getBbDesktopInfo: () => ({
    addServer: mocks.add,
    switchExecution: mocks.switchExecution,
  }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.switchExecution = undefined;
});

function renderControl() {
  return render(
    <div id="root">
      <TooltipProvider>
        <ExecutionLocationControl />
      </TooltipProvider>
    </div>,
  );
}

it.each([true, false])(
  "switches the actual server target, local active: %s",
  (local) => {
    const switchTo = vi.fn();
    mocks.choices = {
      status: "ready",
      servers: [
        {
          id: "builtin",
          kind: "local",
          name: "This computer",
          origin: "http://127.0.0.1:38886",
          active: local,
        },
        {
          id: "germany",
          kind: "custom",
          name: "Germany",
          origin: "http://127.0.0.1:48886",
          active: !local,
        },
      ],
      switchTo,
    };
    renderControl();
    const localButton = screen.getByRole("button", { name: "Work locally" });
    const vpsButton = screen.getByRole("button", {
      name: local ? "Work on VPS" : "Working on VPS: Germany",
    });
    expect(localButton.getAttribute("aria-pressed")).toBe(String(local));
    expect(vpsButton.getAttribute("aria-pressed")).toBe(String(!local));
    fireEvent.click(local ? vpsButton : localButton);
    expect(switchTo).toHaveBeenCalledWith(local ? "germany" : "builtin");
  },
);

it("opens server setup when no VPS exists instead of presenting local execution as remote", () => {
  const switchTo = vi.fn();
  mocks.choices = {
    status: "ready",
    servers: [
      {
        id: "builtin",
        kind: "local",
        name: "This computer",
        origin: "http://127.0.0.1:38886",
        active: true,
      },
    ],
    switchTo,
  };
  renderControl();
  fireEvent.click(screen.getByRole("button", { name: "Work on VPS" }));
  expect(mocks.add).toHaveBeenCalledOnce();
  expect(switchTo).not.toHaveBeenCalled();
});

it("does not invent execution state for a browser without desktop server choices", () => {
  mocks.choices = null;
  renderControl();
  expect(screen.queryByRole("group")).toBeNull();
});

it("waits for the real target list before allowing a switch", () => {
  mocks.choices = { status: "loading", servers: [], switchTo: vi.fn() };
  renderControl();
  for (const button of screen.getAllByRole("button"))
    expect(button.hasAttribute("disabled")).toBe(true);
  expect(
    screen
      .getByRole("button", { name: "Work on VPS" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
});

it("lets the user choose a VPS instead of silently picking the first saved server", async () => {
  const switchTo = vi.fn();
  mocks.choices = {
    status: "ready",
    servers: [
      {
        id: "builtin",
        kind: "local",
        name: "This computer",
        origin: "http://127.0.0.1:38886",
        active: true,
      },
      {
        id: "germany",
        kind: "custom",
        name: "Germany",
        origin: "http://127.0.0.1:48886",
        active: false,
      },
      {
        id: "other",
        kind: "custom",
        name: "Other VPS",
        origin: "https://other.example.com",
        active: false,
      },
    ],
    switchTo,
  };
  renderControl();
  fireEvent.click(screen.getByRole("button", { name: "Work on VPS" }));
  expect(switchTo).not.toHaveBeenCalled();
  const other = await waitFor(() =>
    screen.getByRole("button", { name: "Other VPS" }),
  );
  const root = document.getElementById("root");
  expect(root).not.toBeNull();
  expect(root?.hasAttribute("inert")).toBe(false);
  expect(root?.getAttribute("aria-hidden")).not.toBe("true");
  fireEvent.click(other);
  expect(switchTo).toHaveBeenCalledOnce();
  expect(switchTo).toHaveBeenCalledWith("other");
});

it("waits for the native handoff and keeps local execution selected when synchronization fails", async () => {
  let finish: (value: { ok: false; message: string }) => void = () => {};
  const pending = new Promise<{ ok: false; message: string }>((resolve) => {
    finish = resolve;
  });
  mocks.switchExecution = vi.fn(() => pending);
  mocks.choices = {
    status: "ready",
    servers: [
      {
        id: "builtin",
        kind: "local",
        name: "This computer",
        origin: "http://127.0.0.1:38886",
        active: true,
      },
      {
        id: "germany",
        kind: "custom",
        name: "Germany",
        origin: "http://127.0.0.1:48886",
        active: false,
      },
    ],
    switchTo: vi.fn(),
  };
  renderControl();
  const button = screen.getByRole("button", { name: "Work on VPS" });
  fireEvent.click(button);
  expect(screen.getByRole("status").textContent).toContain("Synchronizing");
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(mocks.choices.switchTo).not.toHaveBeenCalled();
  finish({ ok: false, message: "Conflicting edits in code.py" });
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe(
      "Conflicting edits in code.py",
    ),
  );
  expect(
    screen
      .getByRole("button", { name: "Work locally" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(mocks.switchExecution).toHaveBeenCalledOnce();
});
