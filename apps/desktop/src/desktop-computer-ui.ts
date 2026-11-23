import {
  BrowserWindow,
  Menu,
  desktopCapturer,
  dialog,
  globalShortcut,
  screen,
} from "electron";
import { createDesktopComputer } from "./desktop-computer.js";
import { windowsComputerDriver } from "./desktop-computer-native.js";

export function createDesktopComputerUi() {
  let panel: BrowserWindow | null = null;
  let removeNavigationListeners: (() => void) | null = null;
  let lastRequest = 0;
  let requestPending = false;
  const shortcut = "Control+Alt+Shift+F12";
  const computer = createDesktopComputer({
    identify: windowsComputerDriver.identify,
    input: windowsComputerDriver.execute,
    async capture(windowId, signal) {
      signal.throwIfAborted();
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 1920, height: 1080 },
        fetchWindowIcons: false,
      });
      signal.throwIfAborted();
      const source = sources.find(
        (source) => source.id.split(":")[1] === windowId,
      );
      if (!source || source.thumbnail.isEmpty())
        throw new Error("The selected window cannot be captured");
      const size = source.thumbnail.getSize();
      return {
        mimeType: "image/jpeg",
        ...size,
        base64: source.thumbnail.toJPEG(80).toString("base64"),
      };
    },
    onStop() {
      removeNavigationListeners?.();
      removeNavigationListeners = null;
      globalShortcut.unregister(shortcut);
      const previous = panel;
      panel = null;
      previous?.destroy();
    },
  });
  return {
    computer,
    request(parent: BrowserWindow, threadId: string, reason: string) {
      const pathname = new URL(parent.webContents.getURL()).pathname;
      if (!pathname.split("/").includes(threadId) || !parent.isFocused())
        throw new Error(
          "Open and focus the requesting chat in Desktop before requesting computer access",
        );
      if (requestPending || Date.now() - lastRequest < 60_000)
        throw new Error(
          "A computer access request was already shown; wait before requesting again",
        );
      lastRequest = Date.now();
      requestPending = true;
      const originalUrl = parent.webContents.getURL();
      void dialog
        .showMessageBox(parent, {
          type: "question",
          buttons: ["Not now", "Choose window…"],
          defaultId: 0,
          cancelId: 0,
          message: "This chat is requesting access to a PC window",
          detail: `${reason}\n\nYou choose the window and approve access locally. The model cannot enable access on its own.`,
        })
        .then(async (result) => {
          if (
            result.response === 1 &&
            !parent.isDestroyed() &&
            parent.webContents.getURL() === originalUrl
          )
            await this.open(parent, threadId);
        })
        .catch(() => {})
        .finally(() => {
          requestPending = false;
        });
    },
    async open(parent: BrowserWindow, threadId: string) {
      const originalUrl = parent.webContents.getURL();
      if (process.platform !== "win32") {
        await dialog.showMessageBox(parent, {
          message: "Computer control currently requires Windows.",
          type: "info",
        });
        return;
      }
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      });
      const choices = sources.filter(
        (source) =>
          /^window:\d+:/u.test(source.id) &&
          source.name &&
          !source.name.startsWith("bb — Computer control"),
      );
      const allow = async (id: string, name: string) => {
        try {
          const confirmation = await dialog.showMessageBox(parent, {
            type: "question",
            buttons: ["Cancel", "Allow for this chat"],
            defaultId: 0,
            cancelId: 0,
            message: `Allow this chat to control “${name}”?`,
            detail:
              "The model can see this window and use its mouse and keyboard for up to 30 minutes. Keep the chosen window visible. Stop at any time with Ctrl+Alt+Shift+F12 or the Stop control window. Access ends when you leave this chat, switch servers or close this bb window.",
          });
          if (
            confirmation.response !== 1 ||
            parent.isDestroyed() ||
            parent.webContents.getURL() !== originalUrl
          )
            return;
          await computer.allow(
            { webContentsId: parent.webContents.id, threadId },
            id.split(":")[1]!,
            name,
          );
          if (
            parent.isDestroyed() ||
            parent.webContents.getURL() !== originalUrl
          ) {
            computer.stop();
            return;
          }
          const revoke = () => computer.stop();
          const owner = parent.webContents;
          owner.on("did-navigate", revoke);
          owner.on("did-navigate-in-page", revoke);
          parent.once("closed", revoke);
          removeNavigationListeners = () => {
            if (!owner.isDestroyed()) {
              owner.removeListener("did-navigate", revoke);
              owner.removeListener("did-navigate-in-page", revoke);
            }
            parent.removeListener("closed", revoke);
          };
          if (!globalShortcut.register(shortcut, () => computer.stop())) {
            computer.stop();
            throw new Error(
              "The emergency stop shortcut is unavailable. Close the other program using Ctrl+Alt+Shift+F12 and try again.",
            );
          }
          const area = screen.getDisplayMatching(parent.getBounds()).workArea;
          panel = new BrowserWindow({
            title: "bb — Computer control",
            width: 420,
            height: 165,
            x: Math.max(area.x, area.x + area.width - 435),
            y: Math.max(area.y, area.y + area.height - 180),
            show: false,
            alwaysOnTop: true,
            resizable: false,
            minimizable: false,
            maximizable: false,
            webPreferences: {
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
            },
          });
          panel.setMenu(null);
          panel.on("closed", () => computer.stop());
          const safe = name.replace(
            /[&<>"']/gu,
            (value) =>
              ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
              })[value]!,
          );
          await panel.loadURL(
            `data:text/html;charset=utf-8,${encodeURIComponent(`<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"></head><body style="font:15px system-ui;padding:12px"><strong>Computer control is active</strong><p>${safe}</p><button style="font:inherit" onclick="window.close()">Stop control</button> · Ctrl+Alt+Shift+F12</body></html>`)}`,
          );
          panel?.showInactive();
        } catch (error) {
          computer.stop();
          if (parent.isDestroyed()) return;
          await dialog.showMessageBox(parent, {
            type: "error",
            message:
              error instanceof Error ? error.message : "Computer access failed",
          });
        }
      };
      Menu.buildFromTemplate([
        { label: "Stop computer control", click: () => computer.stop() },
        { type: "separator" },
        ...choices.slice(0, 100).map((source) => ({
          label: source.name.slice(0, 150).replaceAll("&", "&&"),
          click: () => {
            void allow(source.id, source.name);
          },
        })),
      ]).popup({ window: parent });
    },
  };
}
