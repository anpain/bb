import { app, BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDesktopComputerUi } from "../../src/desktop-computer-ui.js";

const artifacts = process.argv.at(-1)!;
app.setPath("userData", join(artifacts, "profile"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
async function main() {
  await app.whenReady();
  await mkdir(artifacts, { recursive: true });
  const window = new BrowserWindow({
    width: 900,
    height: 550,
    title: "bb computer smoke",
    alwaysOnTop: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const ui = createDesktopComputerUi();
  try {
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"></head><body style="font:20px system-ui"><button style="position:absolute;left:8px;top:8px;width:120px;height:32px" onclick="document.body.dataset.clicked='yes'">Click target</button><h1 style="padding-top:40px">bb computer control verification</h1><textarea id="text" style="width:95%;height:60%" aria-label="Computer control test"></textarea></body></html>`)}`,
    );
    window.setMenu(null);
    window.show();
    window.focus();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const handle = window.getNativeWindowHandle();
    const windowId = (
      handle.length === 8
        ? handle.readBigUInt64LE()
        : BigInt(handle.readUInt32LE())
    ).toString();
    const scope = {
      webContentsId: window.webContents.id,
      threadId: "thr_computer_smoke",
    };
    await ui.computer.allow(scope, windowId, "bb computer smoke");
    const before = await ui.computer.execute(scope, { action: "screenshot" });
    if (!before.screenshot) throw new Error("No screenshot returned");
    await writeFile(
      join(artifacts, "before.jpg"),
      Buffer.from(before.screenshot.base64, "base64"),
    );
    await ui.computer.execute(scope, {
      action: "click",
      x: 0.05,
      y: 0.04,
      button: "left",
    });
    const clicked: unknown = await window.webContents.executeJavaScript(
      "document.body.dataset.clicked",
    );
    if (clicked !== "yes")
      throw new Error("Screenshot coordinates did not match the client area");
    await ui.computer.execute(scope, { action: "screenshot" });
    await ui.computer.execute(scope, {
      action: "click",
      x: 0.5,
      y: 0.45,
      button: "left",
    });
    await ui.computer.execute(scope, { action: "screenshot" });
    await ui.computer.execute(scope, {
      action: "type",
      text: "bb native input — проверка",
    });
    const unicode: unknown = await window.webContents.executeJavaScript(
      'document.querySelector("#text").value',
    );
    if (unicode !== "bb native input — проверка")
      throw new Error("Unicode input did not reach the fixture");
    await ui.computer.execute(scope, { action: "screenshot" });
    await ui.computer.execute(scope, { action: "key", key: "Ctrl+A" });
    await ui.computer.execute(scope, { action: "screenshot" });
    await ui.computer.execute(scope, {
      action: "type",
      text: "Native keyboard and mouse verified",
    });
    const after = await ui.computer.execute(scope, { action: "screenshot" });
    const value: unknown = await window.webContents.executeJavaScript(
      'document.querySelector("#text").value',
    );
    if (value !== "Native keyboard and mouse verified")
      throw new Error(
        `Native input did not reach the fixture: ${String(value)}`,
      );
    if (!after.screenshot) throw new Error("No final screenshot returned");
    await writeFile(
      join(artifacts, "after.jpg"),
      Buffer.from(after.screenshot.base64, "base64"),
    );
    await ui.computer.execute(scope, { action: "stop" });
    if ((await ui.computer.execute(scope, { action: "status" })).active)
      throw new Error("Stop did not revoke access");
    await writeFile(
      join(artifacts, "result.json"),
      JSON.stringify({
        ok: true,
        nativeInput: true,
        screenshot: {
          width: after.screenshot.width,
          height: after.screenshot.height,
        },
        stopped: true,
      }),
    );
  } finally {
    ui.computer.stop();
    window.destroy();
  }
}
void main().then(
  () => app.exit(0),
  async (error: unknown) => {
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      join(artifacts, "result.json"),
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.stack : String(error),
      }),
    );
    app.exit(1);
  },
);
