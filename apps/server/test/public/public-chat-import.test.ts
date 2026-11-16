import {
  ensurePersonalProject,
  getStoredProviderSession,
  getThread,
  getEnvironment,
  listStoredEventRows,
} from "@bb/db";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import {
  chatImportResponseSchema,
  threadTimelineResponseSchema,
} from "@bb/server-contract";
import { expect, it } from "vitest";
import { withTestHarness } from "../helpers/test-app.js";
import {
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedTurnStarted,
} from "../helpers/seed.js";

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
    const updated = {
      ...chat,
      messages: [
        ...chat.messages,
        { role: "user", text: "Latest question" },
        { role: "assistant", text: "Latest answer" },
      ],
    };
    expect((await post(updated)).status).toBe(201);
    expect(
      listStoredEventRows(harness.db, { threadId: result.threadId }),
    ).toHaveLength(12);
    const refreshed = await harness.app.request(
      `/api/v1/threads/${result.threadId}/timeline`,
    );
    expect(JSON.stringify(await refreshed.json())).toContain("Latest answer");
    expect((await post(updated)).status).toBe(201);
    expect(
      listStoredEventRows(harness.db, { threadId: result.threadId }),
    ).toHaveLength(12);
    const { host } = seedHostSession(harness.deps);
    seedPrimaryHost(harness.deps, host.id);
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
      path: "/original-project",
    });
    const moved = await post({ ...updated, projectId: project.id });
    expect(moved.status).toBe(201);
    const thread = getThread(harness.db, result.threadId);
    expect(thread?.projectId).toBe(project.id);
    expect(thread?.environmentId).toBeTruthy();
    if (!thread?.environmentId) throw new Error("Missing imported workspace");
    expect(getEnvironment(harness.db, thread.environmentId)).toMatchObject({
      path: "/original-project",
      hostId: host.id,
    });
    const upload = new FormData();
    upload.append(
      "file",
      new File(
        [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])],
        "screen.png",
        { type: "image/png" },
      ),
    );
    const attachment = await harness.app.request(
      `/api/v1/projects/${project.id}/attachments`,
      { method: "POST", body: upload },
    );
    expect(attachment.status).toBe(201);
    const image: { path: string } = await attachment.json();
    const withImage = {
      ...updated,
      projectId: project.id,
      messages: updated.messages.map((message, index) =>
        index === 0 ? { ...message, images: [image.path] } : message,
      ),
    };
    expect((await post(withImage)).status).toBe(201);
    const imageTimeline = await harness.app.request(
      `/api/v1/threads/${result.threadId}/timeline`,
    );
    expect(JSON.stringify(await imageTimeline.json())).toContain(image.path);
    seedTurnStarted(harness.deps, {
      threadId: result.threadId,
      turnId: "continued-in-bb",
      providerThreadId: "real-provider-session",
    });
    expect(
      (
        await post({
          ...withImage,
          messages: [
            ...withImage.messages,
            { role: "user", text: "Source changed after continuing in bb" },
          ],
        })
      ).status,
    ).toBe(409);
  });
});
