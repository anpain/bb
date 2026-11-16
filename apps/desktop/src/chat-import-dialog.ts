import { ipcMain, type BrowserWindow } from "electron";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { escapeHtmlText } from "@bb/text-utils";
import {
  chatImportResponseSchema,
  projectResponseSchema,
  uploadedPromptAttachmentSchema,
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
      const date = new Date(chat.updatedAt).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
      const folder = chat.cwd === null ? "" : ` · ${escapeHtmlText(chat.cwd)}`;
      const source = escapeHtmlText(chat.sourceId.slice(-8));
      return `<label class="chat" data-chat><input type="checkbox" name="chat" value="${index}">
      <span><strong>${title}</strong><small>${provider}${chat.archived ? " · Archived" : ""} · ${escapeHtmlText(date)}${folder} · ${source}</small></span></label>`;
    })
    .join("");
  const destination =
    remote === null
      ? ""
      : `<label class="remote"><input type="checkbox" name="remote"> Also copy selected chats to <strong>${escapeHtmlText(remote.label)}</strong></label>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>Import chats</title><style>${DESKTOP_DIALOG_BASE_CSS}
    body { height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; }
    form { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .list { flex: 1; min-height: 0; overflow: auto; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 8px; }
    [hidden] { display: none !important; }
    [data-search] { color: FieldText; background: Field; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 6px; padding: 8px; margin-bottom: 10px; }
    .chat { display: flex; gap: 8px; align-items: start; padding: 8px; font-size: 13px; }
    .chat + .chat { border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
    .chat:hover, .chat:focus-within { background: color-mix(in srgb, CanvasText 7%, Canvas); }
    .chat span { min-width: 0; overflow-wrap: anywhere; }
    small { display: block; color: color-mix(in srgb, CanvasText 70%, transparent); margin-top: 2px; }
    .remote { display: block; margin-top: 12px; font-size: 13px; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
    button[type=submit]:enabled { background: AccentColor; color: AccentColorText; }
    [data-status] { margin: 8px 0 0; white-space: pre-line; }
    </style></head><body>
    <h1>Import chats</h1><p>Select Codex and Kimi Code chats from this computer. Existing project folders and available images are included. Chats without a local folder go into Personal.</p>
    <p>Only chats with local transcript files are listed. Background agent sessions are hidden.</p>
    <form>${
      items
        ? `<input type="search" data-search aria-label="Search chats" placeholder="Search by title, project, provider or ID">
    <div class="list">${items}<p data-no-matches hidden>No matching chats.</p></div>`
        : "<p>No supported local chats were found.</p>"
    }
    ${items ? destination : ""}<p data-status role="status" aria-live="polite"></p>
    <div class="actions"><button type="button" data-close>Close</button>
    <button type="submit" disabled>Import selected</button></div></form></body></html>`;
}

async function importProject(
  serverUrl: string,
  cwd: string | null,
): Promise<string> {
  if (cwd === null || !(await stat(cwd).catch(() => null))?.isDirectory())
    return PERSONAL_PROJECT_ID;
  const configResponse = await fetch(
    new URL("/api/v1/system/config", serverUrl),
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!configResponse.ok)
    throw new Error(
      `Could not read the local machine (HTTP ${configResponse.status}).`,
    );
  const config = z
    .object({ primaryHostId: z.string().min(1) })
    .parse(await configResponse.json());
  const response = await fetch(new URL("/api/v1/projects", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: path.basename(cwd),
      source: { type: "local_path", hostId: config.primaryHostId, path: cwd },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(
      `Could not attach the original project folder (HTTP ${response.status}).`,
    );
  return projectResponseSchema.parse(await response.json()).id;
}

async function uploadImages(
  fetcher: typeof fetch,
  serverUrl: string,
  chat: ChatImportRequest,
): Promise<{ chat: ChatImportRequest; missing: number }> {
  const uploaded = new Map<string, string | null>();
  let missing = 0;
  const messages: ChatImportRequest["messages"] = [];
  for (const message of chat.messages) {
    const images: string[] = [];
    for (const reference of message.images ?? []) {
      if (!uploaded.has(reference)) {
        const inline =
          /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=\r\n]+)$/iu.exec(
            reference,
          );
        const mimeTypes: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
        };
        const mime =
          inline?.[1] ?? mimeTypes[path.extname(reference).toLowerCase()];
        const info = inline ? null : await stat(reference).catch(() => null);
        if (
          !mime ||
          (!inline &&
            (!path.isAbsolute(reference) ||
              !info?.isFile() ||
              info.size > 20 * 1024 * 1024))
        ) {
          uploaded.set(reference, null);
        } else {
          const bytes = inline
            ? Buffer.from(inline[2] ?? "", "base64")
            : await readFile(reference);
          const form = new FormData();
          form.append(
            "file",
            new File(
              [new Uint8Array(bytes)],
              inline ? "imported-image.png" : path.basename(reference),
              { type: mime },
            ),
          );
          const response = await fetcher(
            new URL(
              `/api/v1/projects/${encodeURIComponent(chat.projectId ?? PERSONAL_PROJECT_ID)}/attachments`,
              serverUrl,
            ),
            {
              method: "POST",
              body: form,
              credentials: "include",
              redirect: "error",
              signal: AbortSignal.timeout(30_000),
            },
          );
          if (!response.ok)
            throw new Error(
              `Could not import an image (HTTP ${response.status}).`,
            );
          const image = uploadedPromptAttachmentSchema.parse(
            await response.json(),
          );
          if (image.type !== "localImage")
            throw new Error(
              "The imported attachment was not recognized as an image.",
            );
          uploaded.set(reference, image.path);
        }
      }
      const stored = uploaded.get(reference);
      if (stored) images.push(stored);
      else missing++;
    }
    messages.push({ ...message, images });
  }
  return { chat: { ...chat, messages }, missing };
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
    width: 850,
    height: 690,
    resizable: true,
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
      let missingImages = 0;
      for (const saved of selected) {
        if (!saved) continue;
        try {
          const chat = await readSavedChat(saved);
          try {
            const projectId = await importProject(localUrl, saved.cwd);
            const local = await uploadImages(fetch, localUrl, {
              ...chat,
              projectId,
            });
            missingImages += local.missing;
            await submitChat(fetch, localUrl, local.chat);
          } catch (error) {
            failures++;
            firstError ||=
              error instanceof Error ? error.message : "Local import failed.";
            break;
          }
          localCount++;
          if (remote !== null && !remoteFailed) {
            try {
              const copy = await uploadImages(remote.fetch, remote.url, chat);
              await submitChat(remote.fetch, remote.url, copy.chat);
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
          `Local: ${localCount} of ${selected.length} chats available.`,
          ...(remote === null
            ? []
            : [
                `${remote.label}: ${remoteCount} of ${selected.length} chats available.`,
              ]),
          ...(failures === 0 ? [] : [firstError]),
          ...(missingImages
            ? [
                `${missingImages} image references could not be copied because their local files are missing or unsupported.`,
              ]
            : []),
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
