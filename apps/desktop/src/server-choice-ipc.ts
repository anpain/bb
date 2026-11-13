import {
  bbDesktopServerChoiceSchema,
  type BbDesktopServerChoice,
} from "@bb/desktop-contract";
import { ipcMain } from "electron";
import {
  BB_DESKTOP_GET_SERVER_CHOICES_CHANNEL,
  BB_DESKTOP_SELECT_SERVER_CHANNEL,
  BB_DESKTOP_ADD_SERVER_CHANNEL,
} from "./desktop-window-command-ipc.js";

export function registerServerChoiceIpc({
  applicationWindowWebContentsIds,
  onListRequested,
  list,
  select,
  add,
  onError,
}: {
  applicationWindowWebContentsIds: ReadonlySet<number>;
  onListRequested(): void;
  list(): BbDesktopServerChoice[];
  select(id: string): Promise<void>;
  add(): Promise<void>;
  onError(error: unknown): void;
}): void {
  ipcMain.on(BB_DESKTOP_ADD_SERVER_CHANNEL, (event) => {
    if (
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame
    )
      return;
    void add().catch(onError);
  });
  ipcMain.handle(BB_DESKTOP_GET_SERVER_CHOICES_CHANNEL, (event) => {
    if (
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error("Server choices are limited to bb windows");
    }
    onListRequested();
    return list();
  });
  ipcMain.on(BB_DESKTOP_SELECT_SERVER_CHANNEL, (event, payload: unknown) => {
    const parsed = bbDesktopServerChoiceSchema.shape.id.safeParse(payload);
    if (
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame ||
      !parsed.success
    )
      return;
    if (!list().some((choice) => choice.id === parsed.data && !choice.active))
      return;
    void select(parsed.data).catch(onError);
  });
}
