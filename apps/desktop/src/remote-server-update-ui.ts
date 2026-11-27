import { BrowserWindow, dialog, net } from "electron";
import { experimental_updateRemoteServer } from "@bb/sdk/node";
import type { SshTunnelSettings } from "./ssh-tunnel.js";

let updating = false;
export async function updateRemoteServerFromDesktop(
  parent: BrowserWindow,
  update: { serverUrl: string; latestVersion: string },
  ssh: SshTunnelSettings,
) {
  if (updating) return;
  updating = true;
  const progress = new BrowserWindow({
    width: 680,
    height: 440,
    parent,
    title: "Updating bb server",
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await progress.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Updating bb server</title><style>body{font:16px system-ui;background:Canvas;color:CanvasText;color-scheme:dark light;padding:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px system-ui}</style><h2>Updating bb server</h2><p>Closing this window does not cancel the server update. A backup is created before restart.</p><pre id="progress">Checking server…</pre>')}`,
    );
    const result = await experimental_updateRemoteServer({
      serverUrl: update.serverUrl,
      ssh,
      version: update.latestVersion,
      fetch: (input, init) =>
        net.fetch(input instanceof URL ? input.toString() : input, init),
      onProgress(message) {
        if (!progress.isDestroyed())
          void progress.webContents
            .executeJavaScript(
              `document.getElementById('progress').textContent=${JSON.stringify(message)}`,
            )
            .catch(() => undefined);
      },
    });
    if (!progress.isDestroyed()) progress.close();
    await dialog.showMessageBox({
      type: "info",
      title: "Server updated",
      message: `The server is now running bb ${result.version}.`,
      detail:
        "The server and its primary daemon are ready. The backup is stored in the server's backups directory.",
    });
  } catch (error) {
    if (!progress.isDestroyed()) progress.close();
    await dialog.showMessageBox({
      type: "error",
      title: "Server update did not complete",
      message: error instanceof Error ? error.message : "Server update failed",
      detail:
        "SSH updates require a Linux systemd installation and passwordless sudo for the saved SSH user. The updater refuses to restart a server with active agents.",
    });
  } finally {
    updating = false;
  }
}
