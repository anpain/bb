import { ipcMain, type BrowserWindow } from "electron";
import { escapeHtmlText } from "@bb/text-utils";
import {
  chatImportResponseSchema,
  type ChatImportRequest,
} from "@bb/server-contract";
import {
  createDesktopDialogWindow,
  DESKTOP_DIALOG_BASE_CSS,
  showDesktopDialogHtml,
} from "./desktop-dialog-window.js";
import {
  chatImportCloseChannel,
  chatImportSubmissionSchema,
  chatImportSubmitChannel,
} from "./chat-import-ipc.js";
import { readSavedChat, type SavedChat } from "./chat-import-source.js";

interface RemoteDestination {
  label: string;
  url: string;
  fetch: typeof fetch;
}

interface ChatImportDialogOptions {
  parentWindow: BrowserWindow;
  preloadPath: string;
  listChats(): Promise<SavedChat[]>;
  localServerUrl(): Promise<string>;
  remote: RemoteDestination | null;
}

let activeWindow: BrowserWindow | null = null;

function renderDialog(
  chats: readonly SavedChat[],
  remote: RemoteDestination | null,
): string {
  const items = chats
    .map((chat, index) => {
      const title = escapeHtmlText(chat.title);
      const provider = chat.providerId === "codex" ? "Codex" : "Kimi Code";
      const date = new Date(chat.updatedAt).toLocaleDateString();
      const folder = chat.cwd === null ? "" : ` · ${escapeHtmlText(chat.cwd)}`;
      return `<label class="chat"><input type="checkbox" name="chat" value="${index}">
      <span><strong>${title}</strong><small>${provider} · ${date}${folder}</small></span></label>`;
    })
    .join("");
  const destination =
    remote === null
      ? ""
      : `<label class="remote"><input type="checkbox" name="remote"> Also copy selected chats to <strong>${escapeHtmlText(remote.label)}</strong></label>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>Import chats</title><style>${DESKTOP_DIALOG_BASE_CSS}
    .list { max-height: 42vh; overflow: auto; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 8px; }
    .chat { display: flex; gap: 8px; align-items: start; padding: 8px; font-size: 13px; }
    .chat + .chat { border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
    .chat span { min-width: 0; overflow-wrap: anywhere; }
    small { display: block; color: color-mix(in srgb, CanvasText 70%, transparent); margin-top: 2px; }
    .remote { display: block; margin-top: 12px; font-size: 13px; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
    button[type=submit]:enabled { background: AccentColor; color: AccentColorText; }
    [data-status] { margin: 8px 0 0; white-space: pre-line; }
    </style></head><body>
    <h1>Import chats</h1><p>Select Codex and Kimi Code chats from this computer. Text history goes into Personal on local bb.</p>
    <form>${items ? `<div class="list">${items}</div>` : "<p>No supported local chats were found.</p>"}
    ${items ? destination : ""}<p data-status role="status" aria-live="polite"></p>
    <div class="actions"><button type="button" data-close>Close</button>
    <button type="submit" disabled>Import selected</button></div></form></body></html>`;
}

async function submitChat(
  fetcher: typeof fetch,
  serverUrl: string,
  chat: ChatImportRequest,
) {
  const response = await fetcher(
    new URL("/api/v1/threads/import-chat", serverUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chat),
      credentials: "include",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (response.status === 404)
    throw new Error("This bb server needs an update to import chats.");
  if (!response.ok) throw new Error(`Import failed (HTTP ${response.status}).`);
  return chatImportResponseSchema.parse(await response.json());
}

export async function openChatImportDialog(
  options: ChatImportDialogOptions,
): Promise<void> {
  if (activeWindow !== null && !activeWindow.isDestroyed()) {
    activeWindow.focus();
    return;
  }
  const window = createDesktopDialogWindow({
    parentWindow: options.parentWindow,
    preloadPath: options.preloadPath,
    title: "Import chats",
    width: 590,
  });
  activeWindow = window;
  let busy = false;
  const contentsId = window.webContents.id;
  const handleClose = (event: { sender: { id: number } }) => {
    if (!busy && event.sender.id === contentsId) window.close();
  };
  window.on("close", (event) => {
    if (busy) event.preventDefault();
  });
  window.once("closed", () => {
    activeWindow = null;
    ipcMain.removeListener(chatImportCloseChannel, handleClose);
    ipcMain.removeHandler(chatImportSubmitChannel);
  });
  ipcMain.on(chatImportCloseChannel, handleClose);
  const chats = await options.listChats().catch((error: unknown) => {
    if (!window.isDestroyed()) window.close();
    throw error;
  });
  if (window.isDestroyed()) return;
  ipcMain.handle(chatImportSubmitChannel, async (event, payload: unknown) => {
    const parsed = chatImportSubmissionSchema.safeParse(payload);
    if (
      event.sender.id !== contentsId ||
      event.senderFrame !== event.sender.mainFrame ||
      busy ||
      !parsed.success
    ) {
      return { ok: false, message: "Select between 1 and 100 chats." };
    }
    const selected = [...new Set(parsed.data.selected)].map(
      (index) => chats[index],
    );
    if (selected.some((chat) => chat === undefined)) {
      return { ok: false, message: "A selected chat is unavailable." };
    }
    const remote = parsed.data.copyToServer ? options.remote : null;
    if (parsed.data.copyToServer && remote === null) {
      return { ok: false, message: "A remote server is not connected." };
    }
    busy = true;
    try {
      const localUrl = await options.localServerUrl();
      let localCount = 0;
      let remoteCount = 0;
      let failures = 0;
      let remoteFailed = false;
      let firstError = "";
      for (const saved of selected) {
        if (!saved) continue;
        try {
          const chat = await readSavedChat(saved);
          try {
            await submitChat(fetch, localUrl, chat);
          } catch (error) {
            failures++;
            firstError ||=
              error instanceof Error ? error.message : "Local import failed.";
            break;
          }
          localCount++;
          if (remote !== null && !remoteFailed) {
            try {
              await submitChat(remote.fetch, remote.url, chat);
              remoteCount++;
            } catch (error) {
              remoteFailed = true;
              throw error;
            }
          }
        } catch (error) {
          failures++;
          firstError ||=
            error instanceof Error ? error.message : "Import failed.";
        }
      }
      return {
        ok: failures === 0,
        message: [
          `Local Personal: ${localCount} of ${selected.length} chats available.`,
          ...(remote === null
            ? []
            : [
                `${remote.label}: ${remoteCount} of ${selected.length} chats available.`,
              ]),
          ...(failures === 0 ? [] : [firstError]),
        ].join("\n"),
      };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error ? error.message : "Local bb is unavailable.",
      };
    } finally {
      busy = false;
    }
  });
  showDesktopDialogHtml(window, renderDialog(chats, options.remote));
}
