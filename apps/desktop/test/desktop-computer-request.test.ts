import { expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = { id: 7, getURL: () => "http://bb.test/threads/thr_owner" };
    isFocused() {
      return true;
    }
    isDestroyed() {
      return false;
    }
  },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
  Menu: { buildFromTemplate: vi.fn() },
  desktopCapturer: { getSources: vi.fn() },
  globalShortcut: { unregister: vi.fn(), register: vi.fn(() => true) },
  screen: {},
}));
import { BrowserWindow, dialog, desktopCapturer } from "electron";
import { createDesktopComputerUi } from "../src/desktop-computer-ui.js";

it("shows a local request without granting access or leaking window choices and rate limits repeats", async () => {
  const ui = createDesktopComputerUi();
  const parent = new BrowserWindow();
  expect(() => ui.request(parent, "thr_other", "Wrong chat")).toThrow("focus");
  ui.request(parent, "thr_owner", "Inspect the project");
  expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  expect(dialog.showMessageBox).toHaveBeenCalledWith(
    parent,
    expect.objectContaining({
      detail: expect.stringContaining("Inspect the project"),
      defaultId: 0,
    }),
  );
  expect(
    (
      await ui.computer.execute(
        { webContentsId: 7, threadId: "thr_owner" },
        { action: "status" },
      )
    ).active,
  ).toBe(false);
  expect(desktopCapturer.getSources).not.toHaveBeenCalled();
  expect(() => ui.request(parent, "thr_owner", "Again")).toThrow(
    "already shown",
  );
  ui.computer.stop();
});
