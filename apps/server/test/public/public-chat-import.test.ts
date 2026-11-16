import {
  ensurePersonalProject,
  getStoredProviderSession,
  getThread,
  getEnvironment,
  listStoredEventRows,
  getLatestThreadSequence,
  threads,
} from "@bb/db";
import {
  PERSONAL_PROJECT_ID,
  threadScope,
  turnScope,
  THREAD_CONTEXT_CLEAR_OPERATION,
} from "@bb/domain";
import { eq } from "drizzle-orm";
import {
  chatImportResponseSchema,
  threadTimelineResponseSchema,
} from "@bb/server-contract";
import { expect, it, vi } from "vitest";
import { prependImportedChatContext } from "../../src/services/threads/imported-chat-context.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  registerHostRpcResponder,
  EMPTY_WORKSPACE_AGENT_CONTEXT,
} from "../helpers/host-rpc.js";
import { installFakePersonalWorkspaceProvider } from "../helpers/environment-provider.js";
import { withTestHarness } from "../helpers/test-app.js";
import {
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedTurnStarted,
  seedStoredEvent,
  seedThreadIdentity,
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

it.each([
  ["codex", "all"],
  ["acp-kimi", "all"],
  ["codex", "none"],
] as const)(
  "continues an imported %s chat with %s context and retains the choice on failed startup",
  async (providerId, contextMode) => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/imported-project",
      });
      const upload = new FormData();
      upload.append(
        "file",
        new File(
          [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])],
          "context.png",
          { type: "image/png" },
        ),
      );
      const attachment = await harness.app.request(
        `/api/v1/projects/${project.id}/attachments`,
        { method: "POST", body: upload },
      );
      expect(attachment.status).toBe(201);
      const image: { path: string } = await attachment.json();
      const imported = await harness.app.request(
        "/api/v1/threads/import-chat",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            providerId,
            sourceId: "continue-source",
            projectId: project.id,
            title: "Continue me",
            context: { mode: contextMode },
            messages: [
              {
                role: "user",
                text: "Implement the remaining feature",
                images: [image.path],
              },
              {
                role: "assistant",
                text: "The parser is finished. Next implement the UI.",
              },
            ],
          }),
        },
      );
      expect(imported.status).toBe(201);
      const { threadId } = chatImportResponseSchema.parse(
        await imported.json(),
      );
      let attempts = 0;
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }) => {
          if (command.type === "host.read_workspace_agent_context")
            return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
          if (command.type === "thread.start") {
            attempts++;
            if (attempts === 1)
              return {
                ok: false,
                errorCode: "provider_unavailable",
                errorMessage: "Temporary startup failure",
              };
            seedThreadIdentity(harness.deps, {
              threadId,
              providerThreadId: "continued-provider-session",
              environmentId: command.environmentId,
            });
            return {
              ok: true,
              result: { providerThreadId: "continued-provider-session" },
            };
          }
          if (command.type === "turn.submit")
            return { ok: true, result: { trace: { spans: [] } } };
          throw new Error(`Unexpected command ${command.type}`);
        },
      });
      const send = () =>
        harness.app.request(`/api/v1/threads/${threadId}/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: textInput("Continue"),
            mode: "start",
            model: providerId === "codex" ? "gpt-5" : "kimi-for-coding",
            permissionMode: "full",
          }),
        });
      expect((await send()).status).toBe(200);
      await vi.waitFor(() =>
        expect(getThread(harness.db, threadId)?.status).toBe("error"),
      );
      expect((await send()).status).toBe(200);
      await vi.waitFor(() =>
        expect(getStoredProviderSession(harness.db, threadId)).toMatchObject({
          kind: "owned",
          providerThreadId: "continued-provider-session",
        }),
      );
      const starts = responder.requests.flatMap(({ command }) =>
        command.type === "thread.start" ? [command] : [],
      );
      expect(starts).toHaveLength(2);
      for (const start of starts) {
        expect(start.providerId).toBe(providerId);
        expect(start.workspaceContext).toMatchObject({
          workspacePath: "/imported-project",
        });
        const content = JSON.stringify(start.input);
        expect(start.input.at(-1)).toMatchObject({ text: "Continue" });
        if (contextMode === "all") {
          expect(content).toContain("Implement the remaining feature");
          expect(content).toContain("Next implement the UI");
          expect(start.input[0]).toMatchObject({ visibility: "agent-only" });
          expect(start.input).toContainEqual({
            type: "localImage",
            path: image.path,
            visibility: "agent-only",
          });
        } else expect(start.input).toEqual(textInput("Continue"));
      }
      seedTurnStarted(harness.deps, {
        threadId,
        turnId: "accepted-real-turn",
        providerThreadId: "continued-provider-session",
      });
      seedStoredEvent(harness.deps, {
        threadId,
        sequence: getLatestThreadSequence(harness.db, { threadId }) + 1,
        type: "turn/completed",
        scope: turnScope("accepted-real-turn"),
        providerThreadId: "continued-provider-session",
        data: {
          providerThreadId: "continued-provider-session",
          status: "completed",
        },
      });
      harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, threadId))
        .run();
      expect((await send()).status).toBe(200);
      await vi.waitFor(() =>
        expect(
          responder.requests.filter(
            ({ command }) => command.type === "turn.submit",
          ),
        ).toHaveLength(1),
      );
      const next = responder.requests.find(
        ({ command }) => command.type === "turn.submit",
      );
      expect(next?.command).toMatchObject({ input: textInput("Continue") });
      expect(JSON.stringify(next?.command)).not.toContain(
        "BEGIN IMPORTED TRANSCRIPT",
      );
    });
  },
);

it("sends explicitly chosen full context without truncation, preserves groups, and respects context clearing", async () => {
  await withTestHarness(async (harness) => {
    const response = await harness.app.request("/api/v1/threads/import-chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "codex",
        sourceId: "long-context",
        title: "Long history",
        context: { mode: "all" },
        messages: [
          { role: "user", text: "ORIGINAL TASK " + "a".repeat(160_000) },
          { role: "assistant", text: "NEXT UNFINISHED STEP" },
        ],
      }),
    });
    const { threadId } = chatImportResponseSchema.parse(await response.json());
    const input = textInput("Continue now");
    const prompt = { input, inputGroups: [input, textInput("Second group")] };
    const continued = prependImportedChatContext(harness.db, threadId, prompt);
    const serialized = JSON.stringify(continued.input);
    expect(serialized).toContain("ORIGINAL TASK");
    expect(serialized).toContain("NEXT UNFINISHED STEP");
    expect(serialized).not.toContain("Middle of imported history omitted");
    expect(serialized).toContain(
      `bb thread log ${threadId} --all --format json`,
    );
    expect(serialized.length).toBeGreaterThan(160_000);
    expect(continued.inputGroups?.[0]).toEqual(continued.input);
    expect(continued.inputGroups?.[1]).toEqual(prompt.inputGroups[1]);
    expect(prependImportedChatContext(harness.db, threadId, continued)).toBe(
      continued,
    );
    seedStoredEvent(harness.deps, {
      threadId,
      sequence: getLatestThreadSequence(harness.db, { threadId }) + 1,
      type: "system/operation",
      scope: threadScope(),
      data: {
        operation: THREAD_CONTEXT_CLEAR_OPERATION,
        operationId: "clear-import",
        status: "completed",
        message: "Context cleared",
      },
    });
    expect(prependImportedChatContext(harness.db, threadId, prompt)).toBe(
      prompt,
    );
  });
});

it.each([
  undefined,
  { mode: "none" } as const,
  { mode: "range", startMessage: 1, endMessage: 2 } as const,
])(
  "honors context choice %j while keeping the full transcript saved",
  async (context) => {
    await withTestHarness(async (harness) => {
      const chat = {
        providerId: "codex",
        sourceId: "chosen-context",
        title: "Chosen history",
        context,
        messages: [
          { role: "user", text: "EXCLUDED EARLY QUESTION" },
          { role: "assistant", text: "SELECTED ANSWER" },
          { role: "user", text: "EXCLUDED LATEST QUESTION" },
        ],
      };
      const response = await harness.app.request(
        "/api/v1/threads/import-chat",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(chat),
        },
      );
      expect(response.status).toBe(201);
      const { threadId } = chatImportResponseSchema.parse(
        await response.json(),
      );
      const prompt = { input: textInput("Continue") };
      const continued = prependImportedChatContext(
        harness.db,
        threadId,
        prompt,
      );
      if (context?.mode !== "range") expect(continued).toBe(prompt);
      else {
        const serialized = JSON.stringify(continued.input);
        expect(serialized).toContain("SELECTED ANSWER");
        expect(serialized).not.toContain("EXCLUDED EARLY QUESTION");
        expect(serialized).not.toContain("EXCLUDED LATEST QUESTION");
        expect(serialized).toContain(
          "Do not retrieve omitted messages unless the user asks",
        );
      }
      const timeline = await harness.app.request(
        `/api/v1/threads/${threadId}/timeline`,
      );
      const saved = JSON.stringify(await timeline.json());
      for (const message of chat.messages)
        expect(saved).toContain(message.text);
      for (const range of [
        { mode: "range", startMessage: 1, endMessage: 1 },
        { mode: "range", startMessage: 0, endMessage: 4 },
      ]) {
        const invalid = await harness.app.request(
          "/api/v1/threads/import-chat",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...chat, context: range }),
          },
        );
        expect(invalid.status).toBe(400);
      }
    });
  },
);

it("prepares a Personal workspace only after the user sends the first imported-chat message", async () => {
  await withTestHarness(async (harness) => {
    const { host, session } = seedHostSession(harness.deps);
    seedPrimaryHost(harness.deps, host.id);
    const provider = installFakePersonalWorkspaceProvider(() => ({
      action: "ready",
      environment: {
        type: "host",
        hostId: host.id,
        path: "/personal/imported-workspace",
      },
    }));
    const responder = registerHostRpcResponder(harness, {
      hostId: host.id,
      sessionId: session.id,
      handle: ({ command }) => {
        if (command.type === "environment.attach")
          return {
            ok: true,
            result: {
              path: command.path,
              isGitRepo: false,
              isWorktree: false,
              branchName: null,
              defaultBranch: null,
              transcript: [],
            },
          };
        if (command.type === "host.read_workspace_agent_context")
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        if (command.type === "thread.start")
          return {
            ok: true,
            result: { providerThreadId: "personal-import-session" },
          };
        throw new Error(`Unexpected command ${command.type}`);
      },
    });
    const response = await harness.app.request("/api/v1/threads/import-chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "codex",
        sourceId: "personal-import",
        title: "Personal import",
        context: { mode: "all" },
        messages: [{ role: "user", text: "Original personal task" }],
      }),
    });
    const { threadId } = chatImportResponseSchema.parse(await response.json());
    expect(provider.contexts).toHaveLength(0);
    expect(responder.requests).toHaveLength(0);
    const sent = await harness.app.request(`/api/v1/threads/${threadId}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: textInput("Continue"),
        mode: "start",
        model: "gpt-5",
        permissionMode: "full",
      }),
    });
    expect(sent.status).toBe(200);
    await vi.waitFor(() =>
      expect({
        requests: responder.requests.map(({ command }) => command.type),
        thread: getThread(harness.db, threadId),
        events: listStoredEventRows(harness.db, {
          threadId,
          types: ["system/error"],
        }),
      }).toMatchObject({ requests: expect.arrayContaining(["thread.start"]) }),
    );
    expect(provider.contexts).toHaveLength(1);
    const command = responder.requests.find(
      ({ command }) => command.type === "thread.start",
    )?.command;
    expect(JSON.stringify(command)).toContain("Original personal task");
    expect(getThread(harness.db, threadId)?.environmentId).toBeTruthy();
  });
});
