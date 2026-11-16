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
    await write(".codex/session_index.jsonl", [
      { id: "codex-1", thread_name: "Назначенное название чата" },
      { id: "worker-1", thread_name: "Background review" },
    ]);
    await write(".codex/sessions/2026/11/13/rollout-worker.jsonl", [
      {
        type: "session_meta",
        payload: { id: "worker-1", source: { subagent: "review" } },
      },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "Internal review input" },
      },
    ]);
    await write(".codex/archived_sessions/rollout-archived.jsonl", [
      { type: "session_meta", payload: { id: "archived-1", cwd: "/project" } },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message:
            "The following is the Codex agent history added since your last approval assessment",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Archived question" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Archived answer" }],
        },
      },
    ]);
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
    expect(chats.map((chat) => chat.sourceId).sort()).toEqual(
      ["codex-1", "kimi-1", "archived-1"].sort(),
    );
    expect(chats.find((item) => item.sourceId === "codex-1")?.title).toBe(
      "Назначенное название чата",
    );
    const archived = chats.at(-1);
    expect(archived).toMatchObject({
      archived: true,
      title: "Archived question",
    });
    if (!archived) throw new Error("Missing archived chat");
    expect((await readSavedChat(archived)).messages).toEqual([
      { role: "user", text: "Archived question" },
      { role: "assistant", text: "Archived answer" },
    ]);
    for (const chat of chats.filter((item) => !item.archived)) {
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

it("combines resumed files and event formats without duplicating messages", async () => {
  const home = await mkdtemp(join(tmpdir(), "bb-chat-import-resumed-"));
  const root = join(home, ".codex", "sessions");
  await mkdir(root, { recursive: true });
  const meta = { type: "session_meta", payload: { id: "resumed", cwd: home } };
  const question = {
    type: "event_msg",
    payload: { type: "user_message", message: "First question" },
  };
  const image = join(home, "screen.png");
  try {
    await writeFile(
      join(root, "rollout-one.jsonl"),
      [
        meta,
        question,
        {
          type: "event_msg",
          payload: { type: "agent_message", message: "First answer" },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    await writeFile(
      join(root, "rollout-two.jsonl"),
      [
        meta,
        question,
        {
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: {
              type: "AgentMessage",
              content: [{ type: "text", text: "First answer" }],
            },
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `## screen.png: ${image}` }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Latest answer" }],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    const chats = await listSavedChats({}, home);
    expect(chats).toHaveLength(1);
    expect(chats[0]?.paths).toHaveLength(2);
    if (!chats[0]) throw new Error("Missing chat");
    const chat = await readSavedChat(chats[0]);
    expect(chat.messages.map((item) => item.text)).toEqual([
      "First question",
      "First answer",
      `## screen.png: ${image}`,
      "Latest answer",
    ]);
    expect(chat.messages[2]?.images).toEqual([image]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
