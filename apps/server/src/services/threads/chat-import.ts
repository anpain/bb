import { createHash, randomUUID } from "node:crypto";
import {
  createThread,
  createEnvironment,
  findProjectEnvironmentByHostPath,
  getProjectSourceByHost,
  getPersonalProject,
  getThread,
  getThreadPluginMetadata,
  noopNotifier,
  listStoredEventRows,
  deleteThreadEventSuffixInTransaction,
  patchThreadPluginMetadata,
  threads,
  setThreadExecutionOverride,
  type AppendStoredThreadEventArgs,
} from "@bb/db";
import {
  GENERATED_ID_ALPHABET,
  GENERATED_ID_SUFFIX_LENGTH,
  turnScope,
} from "@bb/domain";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type {
  ChatImportRequest,
  ChatImportResponse,
  ChatImportContext,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { emitPluginThreadCreated } from "../plugins/plugin-thread-events.js";
import { appendThreadEventsInTransaction } from "./thread-events.js";
import { ensureAttachmentReferenceExists } from "../projects/attachments.js";
import { requirePrimaryHostId } from "../hosts/primary-host.js";
import { requirePublicProject } from "../lib/entity-lookup.js";

const metadataNamespace = "bb.core.chat-import";

export async function importChat(
  deps: Pick<AppDeps, "db" | "hub" | "config" | "providerRegistry">,
  request: ChatImportRequest,
): Promise<ChatImportResponse> {
  const context: ChatImportContext = request.context ?? { mode: "none" };
  const targetProviderId =
    request.continuation?.providerId ?? request.providerId;
  const targetProvider = request.continuation
    ? deps.providerRegistry.get(targetProviderId)
    : null;
  if (request.continuation && !targetProvider)
    throw new ApiError(
      400,
      "invalid_request",
      "The continuation provider is not enabled on this server",
    );
  if (
    targetProvider &&
    request.continuation?.reasoningLevel &&
    targetProvider.info.reasoningLevels?.length &&
    !targetProvider.info.reasoningLevels.some(
      (level) => level.id === request.continuation?.reasoningLevel,
    )
  )
    throw new ApiError(
      400,
      "invalid_request",
      "This provider does not support the selected reasoning level",
    );
  const project =
    request.projectId === undefined
      ? getPersonalProject(deps.db)
      : requirePublicProject(deps.db, request.projectId);
  if (!project)
    throw new ApiError(
      409,
      "invalid_request",
      "Personal project is not available",
    );
  for (const message of request.messages) {
    for (const image of message.images ?? [])
      await ensureAttachmentReferenceExists(
        deps.db,
        deps.config.dataDir,
        project.id,
        image,
      );
  }
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify(
        request.continuation
          ? [request.messages, context, request.continuation]
          : [request.messages, context],
      ),
    )
    .digest("hex");
  const source = createHash("sha256")
    .update(JSON.stringify([request.providerId, request.sourceId]))
    .digest();
  const fingerprint = source.toString("hex");
  const suffix = Array.from(
    source.subarray(0, GENERATED_ID_SUFFIX_LENGTH),
    (byte) => GENERATED_ID_ALPHABET[byte % GENERATED_ID_ALPHABET.length],
  ).join("");
  const threadId = `thr_${suffix}`;
  let alreadyImported = false;
  let previousProjectId: string | null = null;

  const created = deps.db.transaction(
    (tx) => {
      const existing = getThread(tx, threadId);
      if (existing !== null) {
        alreadyImported = true;
        previousProjectId = existing.projectId;
        const metadata = getThreadPluginMetadata(
          tx,
          threadId,
          metadataNamespace,
        ).metadata;
        if (
          metadata.fingerprint === fingerprint &&
          existing.deletedAt === null
        ) {
          if (
            metadata.contentHash === contentHash &&
            existing.projectId === project.id
          )
            return null;
          const rows = listStoredEventRows(tx, { threadId });
          const importEvent = z.object({
            providerThreadId: z.string().nullable(),
          });
          const sourceId = `imported:${threadId}`;
          if (
            existing.status !== "idle" ||
            rows.some((row) => {
              if (
                !["turn/started", "turn/completed", "item/completed"].includes(
                  row.type,
                )
              )
                return true;
              const value = importEvent.safeParse(JSON.parse(row.data));
              return (
                !value.success ||
                (value.data.providerThreadId !== sourceId &&
                  !(
                    row.type === "turn/completed" &&
                    value.data.providerThreadId === null
                  ))
              );
            })
          )
            throw new ApiError(
              409,
              "invalid_request",
              "This imported chat has new bb activity. Its history cannot be replaced by a source import.",
            );
          deleteThreadEventSuffixInTransaction(tx, {
            threadId,
            cutoffSequence: 1,
            oldMaxSequence: rows.at(-1)?.sequence ?? 0,
          });
        } else {
          throw new ApiError(
            409,
            "invalid_request",
            "This import already has a conflicting or deleted thread",
          );
        }
      }
      const source =
        project.kind === "personal"
          ? null
          : getProjectSourceByHost(tx, project.id, requirePrimaryHostId(deps));
      const environment =
        source === null
          ? null
          : (findProjectEnvironmentByHostPath(
              tx,
              project.id,
              source.hostId,
              source.path,
            ) ??
            createEnvironment(tx, noopNotifier, {
              projectId: project.id,
              hostId: source.hostId,
              path: source.path,
              providerOwnsPath: false,
              status: "ready",
            }));
      if (existing !== null) {
        tx.update(threads)
          .set({
            projectId: project.id,
            environmentId: environment?.id ?? null,
            title: request.title,
            providerId: targetProviderId,
            updatedAt: Date.now(),
          })
          .where(eq(threads.id, threadId))
          .run();
        patchThreadPluginMetadata(deps.db, {
          threadId,
          pluginId: metadataNamespace,
          set: { contentHash, context },
          remove: [],
        });
      }
      const thread =
        existing ??
        createThread(tx, noopNotifier, {
          id: threadId,
          projectId: project.id,
          environmentId: environment?.id ?? null,
          providerId: targetProviderId,
          title: request.title,
          status: "idle",
          pluginMetadata: {
            pluginId: metadataNamespace,
            metadata: {
              fingerprint,
              contentHash,
              context,
            },
          },
        });
      setThreadExecutionOverride(tx, {
        threadId,
        modelOverride: request.continuation?.model ?? null,
        reasoningLevelOverride: request.continuation?.reasoningLevel ?? null,
      });
      const events: AppendStoredThreadEventArgs[] = [];
      const providerThreadId = `imported:${threadId}`;
      let scope = turnScope(randomUUID());
      let turnOpen = false;
      const finishTurn = () => {
        events.push({
          type: "turn/completed",
          threadId,
          scope,
          data: { providerThreadId: null, status: "completed" },
        });
      };
      for (const message of request.messages) {
        if (turnOpen && message.role === "user") {
          finishTurn();
          turnOpen = false;
          scope = turnScope(randomUUID());
        }
        if (!turnOpen) {
          events.push({
            type: "turn/started",
            threadId,
            scope,
            data: { providerThreadId },
          });
          turnOpen = true;
        }
        events.push({
          type: "item/completed",
          threadId,
          scope,
          data: {
            providerThreadId,
            item:
              message.role === "user"
                ? {
                    type: "userMessage",
                    id: randomUUID(),
                    content: [
                      { type: "text", text: message.text },
                      ...(message.images ?? []).map((path) => ({
                        type: "localImage" as const,
                        path,
                      })),
                    ],
                  }
                : {
                    type: "agentMessage",
                    id: randomUUID(),
                    text: message.text,
                  },
          },
        });
      }
      if (turnOpen) finishTurn();
      appendThreadEventsInTransaction(tx, events);
      return thread;
    },
    { behavior: "immediate" },
  );

  if (created !== null) {
    deps.hub.notifyThread(
      threadId,
      alreadyImported
        ? ["history-rewritten", "environment-changed", "title-changed"]
        : ["thread-created"],
      {
        projectId: project.id,
      },
    );
    deps.hub.notifyProject(project.id, ["threads-changed"]);
    if (previousProjectId !== null && previousProjectId !== project.id)
      deps.hub.notifyProject(previousProjectId, ["threads-changed"]);
    if (!alreadyImported) emitPluginThreadCreated(created);
  }
  return { threadId, alreadyImported };
}
