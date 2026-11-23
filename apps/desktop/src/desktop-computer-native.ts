import { spawn } from "node:child_process";
import { z } from "zod";
import type { DesktopComputerAction } from "@bb/host-daemon-contract";

const identitySchema = z
  .object({
    pid: z.number().int().positive(),
    started: z.string().regex(/^\d+$/u),
  })
  .strict();
export type ComputerWindowIdentity = z.infer<typeof identitySchema>;

const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class BbComputer {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Keyboard { public ushort VirtualKey, Scan; public uint Flags, Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Mouse { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Explicit)] public struct Union { [FieldOffset(0)] public Keyboard Key; [FieldOffset(0)] public Mouse Mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint Type; public Union Value; }
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] inputs, int size);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out Rect rect, int size);
  static IntPtr Window(string id) { return new IntPtr(long.Parse(id)); }
  public static uint Pid(string id) {
    var window = Window(id);
    if (!IsWindow(window) || !IsWindowVisible(window) || IsIconic(window)) throw new Exception("The selected window is closed, hidden or minimized");
    uint pid; GetWindowThreadProcessId(window, out pid); return pid;
  }
  public static string Started(uint pid) { return Process.GetProcessById((int)pid).StartTime.ToUniversalTime().Ticks.ToString(); }
  public static void Validate(string id, uint pid, string started) {
    if (Pid(id) != pid || Started(pid) != started) throw new Exception("The selected window was replaced");
  }
  static void Guard(string id, uint pid, string started) {
    Validate(id, pid, started);
    if (GetForegroundWindow() != Window(id)) throw new Exception("Click the allowed window before typing; Windows did not give it focus");
    Modifiers();
  }
  static void Modifiers() {
    foreach (int key in new[] { 16, 17, 18, 91, 92 }) if ((GetAsyncKeyState(key) & 32768) != 0) throw new Exception("Release modifier keys before computer input");
  }
  public static void Focus(string id, uint pid, string started) {
    Validate(id, pid, started);
    SetForegroundWindow(Window(id));
    for (int n = 0; n < 20 && GetForegroundWindow() != Window(id); n++) System.Threading.Thread.Sleep(10);
    Guard(id, pid, started);
  }
  static void Send(Input[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) != inputs.Length) throw new Exception("Windows rejected input");
  }
  static Input Key(ushort key, ushort scan, uint flags) { return new Input { Type = 1, Value = new Union { Key = new Keyboard { VirtualKey = key, Scan = scan, Flags = flags } } }; }
  public static void Text(string id, uint pid, string started, string text) {
    foreach (char value in text) { Guard(id, pid, started); Send(new[] { Key(0, value, 4), Key(0, value, 6) }); }
  }
  public static void Press(string id, uint pid, string started, ushort key, bool control) {
    Guard(id, pid, started);
    Send(control ? new[] { Key(17, 0, 0), Key(key, 0, 0), Key(key, 0, 2), Key(17, 0, 2) } : new[] { Key(key, 0, 0), Key(key, 0, 2) });
  }
  static void Position(string id, uint pid, string started, double x, double y, double aspect, bool requireFocus) {
    Validate(id, pid, started);
    Modifiers();
    if (requireFocus) Guard(id, pid, started);
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    Rect rect;
    if (DwmGetWindowAttribute(Window(id), 9, out rect, Marshal.SizeOf(typeof(Rect))) != 0) throw new Exception("Cannot read selected window bounds");
    Rect client;
    var origin = new Point();
    if (GetClientRect(Window(id), out client) && ClientToScreen(Window(id), ref origin) && client.Right > 0 && client.Bottom > 0 && aspect > 0 && Math.Abs((double)client.Right / client.Bottom - aspect) < Math.Abs((double)(rect.Right - rect.Left) / Math.Max(1, rect.Bottom - rect.Top) - aspect)) rect = new Rect { Left = origin.X, Top = origin.Y, Right = origin.X + client.Right, Bottom = origin.Y + client.Bottom };
    var point = new Point { X = rect.Left + (int)Math.Round(x * Math.Max(0, rect.Right - rect.Left - 1)), Y = rect.Top + (int)Math.Round(y * Math.Max(0, rect.Bottom - rect.Top - 1)) };
    if (GetAncestor(WindowFromPoint(point), 2) != Window(id)) throw new Exception("Another window covers the requested position");
    if (!SetCursorPos(point.X, point.Y)) throw new Exception("Cannot move pointer");
  }
  public static void Click(string id, uint pid, string started, double x, double y, double aspect, string button) {
    Position(id, pid, started, x, y, aspect, false);
    int count = button == "double" ? 2 : 1;
    for (int n = 0; n < count; n++) {
      if (n > 0) Guard(id, pid, started);
      uint down = button == "right" ? 8u : 2u, up = button == "right" ? 16u : 4u;
      Send(new[] { new Input { Value = new Union { Mouse = new Mouse { Flags = down } } }, new Input { Value = new Union { Mouse = new Mouse { Flags = up } } } });
      for (int wait = 0; wait < 20 && GetForegroundWindow() != Window(id); wait++) System.Threading.Thread.Sleep(10);
      Guard(id, pid, started);
    }
  }
  public static void Scroll(string id, uint pid, string started, double x, double y, double aspect, int steps) {
    Position(id, pid, started, x, y, aspect, true);
    Send(new[] { new Input { Value = new Union { Mouse = new Mouse { Flags = 2048, Data = unchecked((uint)(steps * 120)) } } } });
  }
}
'@
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.action -eq 'identity') {
    $windowPid = [BbComputer]::Pid($request.windowId)
    @{pid=$windowPid; started=[BbComputer]::Started($windowPid)} | ConvertTo-Json -Compress
  } else {
    [BbComputer]::Validate($request.windowId, $request.pid, $request.started)
    if ($request.action -ne 'validate' -and $request.action -ne 'click') { [BbComputer]::Focus($request.windowId, $request.pid, $request.started) }
    switch ($request.action) {
      'type' { [BbComputer]::Text($request.windowId, $request.pid, $request.started, $request.text) }
      'key' { [BbComputer]::Press($request.windowId, $request.pid, $request.started, $request.code, $request.control) }
      'click' { [BbComputer]::Click($request.windowId, $request.pid, $request.started, $request.x, $request.y, $request.aspect, $request.button) }
      'scroll' { [BbComputer]::Scroll($request.windowId, $request.pid, $request.started, $request.x, $request.y, $request.aspect, $request.steps) }
    }
    '{"ok":true}'
  }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;

async function invoke(input: object, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const process = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      },
    );
    let stdout = "";
    let stderr = "";
    process.stdout.setEncoding("utf8");
    process.stderr.setEncoding("utf8");
    process.stdout.on("data", (value: string) => {
      stdout = (stdout + value).slice(0, 65536);
    });
    process.stderr.on("data", (value: string) => {
      stderr = (stderr + value).slice(0, 4096);
    });
    process.once("error", reject);
    process.once("close", (code) => {
      if (code !== 0)
        reject(new Error(stderr.trim() || "Windows input failed"));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("Invalid Windows input result"));
        }
      }
    });
    process.stdin.on("error", reject);
    process.stdin.end(JSON.stringify(input));
  });
}

const keyCodes: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowLeft: 37,
  ArrowRight: 39,
  ArrowUp: 38,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
};
export const windowsComputerDriver = {
  async identify(windowId: string, signal: AbortSignal) {
    return identitySchema.parse(
      await invoke({ action: "identity", windowId }, signal),
    );
  },
  async execute(
    windowId: string,
    identity: ComputerWindowIdentity,
    action: Exclude<
      DesktopComputerAction,
      { action: "status" | "stop" | "request_access" }
    >,
    signal: AbortSignal,
    aspect: number | null,
  ) {
    const input =
      action.action === "key"
        ? {
            action: "key",
            code: action.key.startsWith("Ctrl+")
              ? action.key.charCodeAt(5)
              : keyCodes[action.key],
            control: action.key.startsWith("Ctrl+"),
          }
        : action.action === "screenshot"
          ? { action: "validate" }
          : action;
    z.object({ ok: z.literal(true) })
      .strict()
      .parse(await invoke({ ...input, windowId, ...identity, aspect }, signal));
  },
};
