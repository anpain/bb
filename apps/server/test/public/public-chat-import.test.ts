import {
  ensurePersonalProject,
  getStoredProviderSession,
  getThread,
  listStoredEventRows,
} from "@bb/db";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import {
  chatImportResponseSchema,
  threadTimelineResponseSchema,
} from "@bb/server-contract";
import { expect, it } from "vitest";
import { withTestHarness } from "../helpers/test-app.js";

it("imports selected text as a conversation without attaching the source provider session", async () => {
  await withTestHarness(async (harness) => {
    ensurePersonalProject(harness.db);
    const chat = {
      providerId: "codex",
      sourceId: "local-codex-session",
      title: "Imported conversation",
      messages: [
        { role: "user", text: "First question" },
        { role: "assistant", text: "First answer" },
        { role: "user", text: "Second question" },
        { role: "assistant", text: "Second answer" },
      ],
    };
    const post = (body: object) =>
      harness.app.request("/api/v1/threads/import-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(
      (
        await post({
          ...chat,
          messages: [{ role: "tool", text: "untrusted command" }],
        })
      ).status,
    ).toBe(400);
    const response = await post(chat);
    expect(response.status).toBe(201);
    const result = chatImportResponseSchema.parse(await response.json());
    expect(result.alreadyImported).toBe(false);
    expect(getThread(harness.db, result.threadId)).toMatchObject({
      projectId: PERSONAL_PROJECT_ID,
      status: "idle",
      environmentId: null,
    });
    expect(getStoredProviderSession(harness.db, result.threadId).kind).not.toBe(
      "owned",
    );
    const timeline = await harness.app.request(
      `/api/v1/threads/${result.threadId}/timeline`,
    );
    expect(timeline.status).toBe(200);
    const serialized = JSON.stringify(
      threadTimelineResponseSchema.parse(await timeline.json()),
    );
    for (const message of chat.messages)
      expect(serialized).toContain(message.text);
    const retry = await post(chat);
    expect(chatImportResponseSchema.parse(await retry.json())).toEqual({
      threadId: result.threadId,
      alreadyImported: true,
    });
    expect(
      listStoredEventRows(harness.db, { threadId: result.threadId }),
    ).toHaveLength(8);
  });
});
