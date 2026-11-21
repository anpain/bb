// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, expect, it, vi } from "vitest";
import { summarizeChatImportMessages } from "@bb/server-contract";
import { renderChatImportDialog } from "../src/chat-import-dialog.js";
import { initializeChatImport } from "../src/chat-import-preload.js";
import {
  chatImportModelsChannel,
  chatImportPreviewChannel,
  chatImportSubmitChannel,
} from "../src/chat-import-ipc.js";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), send: vi.fn() }));
vi.mock("electron", () => ({
  ipcRenderer: ipc,
  ipcMain: {},
  BrowserWindow: class {},
  screen: {},
}));
afterEach(() => {
  document.body.innerHTML = "";
  window.removeEventListener("DOMContentLoaded", initializeChatImport);
  vi.restoreAllMocks();
});

it("selects a target model and reasoning for Kimi context and omits them when context is off", async () => {
  const catalog = {
    permissionCeiling: "full",
    selectedOnlyModels: [],
    modelLoadError: null,
    providers: [
      {
        id: "codex",
        pluginId: "provider-codex",
        displayName: "Codex",
        logoUrl: null,
        available: true,
        maintenance: { health: true, usage: true, installation: true },
        composerActions: [],
        completedTurnDisplay: "collapse",
        capabilities: {
          supportsThreadArchive: true,
          supportsThreadRename: true,
          supportsServiceTier: true,
          supportsNativeUserQuestion: false,
          supportsFork: true,
          supportsSessionRewind: true,
          permissionModes: ["full"],
          modelCatalogScope: "host",
        },
      },
    ],
    models: [
      {
        id: "test-model",
        model: "gpt-test",
        displayName: "ChatGPT test model",
        description: "",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Medium" },
          { reasoningEffort: "high", description: "High" },
        ],
        isDefault: true,
      },
    ],
  };
  ipc.invoke.mockImplementation(async (channel: string) => {
    if (channel === chatImportModelsChannel)
      return { ok: true, sourceLabel: "this computer", catalog };
    if (channel === chatImportPreviewChannel)
      return {
        ok: true,
        sourceHash: "reviewed",
        messages: summarizeChatImportMessages([
          { role: "user", text: "Kimi history" },
        ]),
      };
    if (channel === chatImportSubmitChannel)
      return { ok: true, message: "Imported" };
    throw new Error(`Unexpected IPC ${channel}`);
  });
  const html = renderChatImportDialog(
    [
      {
        providerId: "acp-kimi",
        sourceId: "kimi-id",
        title: "Kimi conversation",
        cwd: null,
        updatedAt: Date.now(),
        archived: false,
        path: "/unused",
        root: "/unused",
      },
    ],
    null,
  );
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
  initializeChatImport();
  const chat = document.querySelector<HTMLInputElement>("input[name=chat]");
  if (!chat) throw new Error("Missing chat");
  fireEvent.click(chat);
  expect(ipc.invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Codex" })).toBeTruthy(),
  );
  fireEvent.change(
    screen.getByRole("combobox", { name: "Continuation provider" }),
    { target: { value: "codex" } },
  );
  await waitFor(() =>
    expect(
      screen.getByRole("option", { name: "ChatGPT test model" }),
    ).toBeTruthy(),
  );
  fireEvent.change(
    screen.getByRole("combobox", { name: "Continuation model" }),
    { target: { value: "gpt-test" } },
  );
  fireEvent.change(
    screen.getByRole("combobox", { name: "Continuation reasoning" }),
    { target: { value: "high" } },
  );
  const submit = document.querySelector<HTMLButtonElement>(
    "button[type=submit]",
  );
  if (!submit) throw new Error("Missing submit");
  await waitFor(() => expect(submit.disabled).toBe(false));
  fireEvent.submit(submit.form!);
  await waitFor(() =>
    expect(ipc.invoke).toHaveBeenCalledWith(
      chatImportSubmitChannel,
      expect.objectContaining({
        continuation: {
          providerId: "codex",
          model: "gpt-test",
          reasoningLevel: "high",
        },
        contexts: [
          { index: 0, context: { mode: "all" }, sourceHash: "reviewed" },
        ],
      }),
    ),
  );
  await waitFor(() => expect(chat.checked).toBe(false));
  fireEvent.click(chat);
  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() => expect(submit.disabled).toBe(false));
  fireEvent.submit(submit.form!);
  await waitFor(() =>
    expect(
      ipc.invoke.mock.calls.filter(
        ([channel]) => channel === chatImportSubmitChannel,
      ),
    ).toHaveLength(2),
  );
  const last = ipc.invoke.mock.calls
    .filter(([channel]) => channel === chatImportSubmitChannel)
    .at(-1)?.[1];
  expect(last).not.toHaveProperty("continuation");
  expect(last).toMatchObject({
    contexts: [{ index: 0, context: { mode: "none" } }],
  });
});
