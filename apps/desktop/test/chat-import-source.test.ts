import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { listSavedChats, readSavedChat } from "../src/chat-import-source.js";

it("finds local sessions and extracts only text from the selected source", async () => {
  const home = await mkdtemp(join(tmpdir(), "bb-chat-import-"));
  const write = async (relative: string, rows: object[]) => {
    const file = join(home, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n"));
  };
  try {
    await write(".codex/sessions/2026/11/13/rollout-one.jsonl", [
      { type: "session_meta", payload: { id: "codex-1", cwd: "/test" } },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "User text" },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "UserMessage",
            content: [{ type: "text", text: "User text" }],
          },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "text", text: "private settings" }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "AgentMessage",
            content: [{ type: "Text", text: "Codex answer" }],
          },
        },
      },
    ]);
    await write(".kimi-code/sessions/project/session/state.json", [
      { id: "kimi-1", title: "Kimi chat" },
    ]);
    await write(".kimi-code/sessions/project/session/agents/main/wire.jsonl", [
      {
        type: "agent.message.appended",
        message: {
          message: {
            role: "user",
            content: [{ type: "text", text: "Kimi question" }],
          },
        },
      },
      {
        type: "agent.message.appended",
        message: { message: { role: "tool", content: "tool output" } },
      },
      {
        type: "agent.message.appended",
        message: {
          message: {
            role: "assistant",
            content: [
              { type: "think", text: "private reasoning" },
              { type: "text", text: "Kimi answer" },
            ],
          },
        },
      },
    ]);
    const chats = await listSavedChats({}, home);
    expect(chats.map((chat) => chat.sourceId).sort()).toEqual([
      "codex-1",
      "kimi-1",
    ]);
    for (const chat of chats) {
      const imported = await readSavedChat(chat);
      expect(imported.messages).toEqual(
        chat.providerId === "codex"
          ? [
              { role: "user", text: "User text" },
              { role: "assistant", text: "Codex answer" },
            ]
          : [
              { role: "user", text: "Kimi question" },
              { role: "assistant", text: "Kimi answer" },
            ],
      );
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
