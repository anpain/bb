import { createHash, randomUUID } from "node:crypto";
import {
  createThread,
  getPersonalProject,
  getThread,
  getThreadPluginMetadata,
  noopNotifier,
  type AppendStoredThreadEventArgs,
} from "@bb/db";
import {
  GENERATED_ID_ALPHABET,
  GENERATED_ID_SUFFIX_LENGTH,
  turnScope,
} from "@bb/domain";
import type {
  ChatImportRequest,
  ChatImportResponse,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { emitPluginThreadCreated } from "../plugins/plugin-thread-events.js";
import { appendThreadEventsInTransaction } from "./thread-events.js";

const metadataNamespace = "bb.core.chat-import";

export function importChat(
  deps: Pick<AppDeps, "db" | "hub">,
  request: ChatImportRequest,
): ChatImportResponse {
  const project = getPersonalProject(deps.db);
  if (!project)
    throw new ApiError(
      409,
      "invalid_request",
      "Personal project is not available",
    );
  const source = createHash("sha256")
    .update(JSON.stringify([request.providerId, request.sourceId]))
    .digest();
  const fingerprint = source.toString("hex");
  const suffix = Array.from(
    source.subarray(0, GENERATED_ID_SUFFIX_LENGTH),
    (byte) => GENERATED_ID_ALPHABET[byte % GENERATED_ID_ALPHABET.length],
  ).join("");
  const threadId = `thr_${suffix}`;

  const created = deps.db.transaction(
    (tx) => {
      const existing = getThread(tx, threadId);
      if (existing !== null) {
        if (
          getThreadPluginMetadata(tx, threadId, metadataNamespace).metadata
            .fingerprint === fingerprint &&
          existing.deletedAt === null
        ) {
          return null;
        }
        throw new ApiError(
          409,
          "invalid_request",
          "This import already has a conflicting or deleted thread",
        );
      }
      const thread = createThread(tx, noopNotifier, {
        id: threadId,
        projectId: project.id,
        providerId: request.providerId,
        title: request.title,
        status: "idle",
        pluginMetadata: {
          pluginId: metadataNamespace,
          metadata: { fingerprint },
        },
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
                    content: [{ type: "text", text: message.text }],
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
    deps.hub.notifyThread(threadId, ["thread-created"], {
      projectId: project.id,
    });
    deps.hub.notifyProject(project.id, ["threads-changed"]);
    emitPluginThreadCreated(created);
  }
  return { threadId, alreadyImported: created === null };
}
