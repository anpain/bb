import { createHash } from "node:crypto";
import { and, eq, ne, notInArray, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  internal_DO_NOT_USE_nativeSessionTransferHostContract,
  internal_DO_NOT_USE_nativeSessionTransferOutputSchema,
} from "@get-bb/plugin-sdk/host";
import {
  createThread,
  findOrCreateProjectByLocalPathSource,
  createProjectSource,
  createEnvironment,
  findProjectEnvironmentByHostPath,
  getProject,
  getProjectSourceByHost,
  getThread,
  getStoredProviderSession,
  getThreadExecutionOverride,
  getThreadPluginMetadata,
  patchThreadPluginMetadata,
  listStoredEventRows,
  getLatestThreadSequence,
  threads,
  events,
  noopNotifier,
  deleteThreadEventSuffixInTransaction,
  type AppendStoredThreadEventArgs,
} from "@bb/db";
import {
  parseStoredThreadEvent,
  buildThreadEventRow,
  type Thread,
} from "@bb/domain";
import {
  threadTransferPacketSchema,
  type ThreadTransferPacket,
  type ThreadTransferRequest,
  type ThreadTransferResponse,
} from "@bb/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  requirePublicThread,
  requireEnvironment,
  requireConnectedHostSession,
} from "../lib/entity-lookup.js";
import { requirePrimaryHostId } from "../hosts/primary-host.js";
import { callPluginHostRpc } from "../plugins/plugin-host-rpc.js";
import { callHostOnlineRpcForWork } from "../hosts/online-rpc.js";
import { stopThreadForCurrentState } from "./thread-lifecycle.js";
import { appendThreadEventsInTransaction } from "./thread-events.js";
import { joinHostPathSegments } from "../lib/host-path.js";

const namespace = "bb.core.thread-transfer";
const activeTransfers = new Set<string>();
type Deps = LoggedPendingInteractionWorkSessionDeps;
function fail(message: string): never {
  throw new ApiError(409, "invalid_request", message);
}
function requireIdle(
  thread: Pick<Thread, "status" | "providerId" | "parentThreadId">,
) {
  if (thread.status !== "idle" && thread.status !== "error")
    fail("Stop the thread before moving it to another machine");
  if (thread.providerId !== "codex")
    fail(
      "Native thread transfer currently supports Codex. Use context import for another provider.",
    );
  if (thread.parentThreadId !== null)
    fail("Move a top-level thread; child threads have independent sessions");
}
async function native(
  deps: Deps,
  hostId: string,
  threadId: string,
  providerThreadId: string,
  action: "export" | "prepare" | "activate",
) {
  const provider = deps.providerRegistry.get("codex");
  const artifact = provider
    ? deps.pluginHostArtifacts.get(provider.pluginId)
    : undefined;
  if (!provider || !artifact)
    fail(
      "Install or update the Codex provider on both machines before transferring a session",
    );
  const home = getThreadPluginMetadata(deps.db, threadId, provider.pluginId)
    .metadata.portableCodexHome;
  return internal_DO_NOT_USE_nativeSessionTransferOutputSchema.parse(
    await callPluginHostRpc(deps, {
      pluginId: provider.pluginId,
      artifact,
      hostId,
      contract: internal_DO_NOT_USE_nativeSessionTransferHostContract,
      method: "transferNativeSession",
      input: {
        action,
        threadId,
        providerThreadId,
        nativeHome: typeof home === "string" ? home : null,
      },
      timeoutMs: 180_000,
    }),
  );
}
function assertTarget(deps: Deps, packet: ThreadTransferPacket) {
  const otherOwner = deps.db
    .select({ threadId: events.threadId })
    .from(events)
    .where(
      and(
        eq(events.type, "thread/identity"),
        eq(events.providerThreadId, packet.providerThreadId),
        ne(events.threadId, packet.threadId),
      ),
    )
    .limit(1)
    .get();
  if (otherOwner)
    fail("Another chat on this server already owns this native Codex session");
  const existing = getThread(deps.db, packet.threadId);
  if (existing === null) return;
  requireIdle(existing);
  const metadata = getThreadPluginMetadata(
    deps.db,
    packet.threadId,
    namespace,
  ).metadata;
  const sequence = getLatestThreadSequence(deps.db, {
    threadId: packet.threadId,
  });
  if (
    existing.deletedAt !== null ||
    metadata.transferId !== packet.transferId ||
    existing.archivedAt === null ||
    metadata.exportedSequence !== sequence
  )
    fail(
      "This machine already has a different or modified copy of the thread. Both histories were preserved.",
    );
}
function targetProjectPath(
  deps: Deps,
  packet: ThreadTransferPacket,
  targetPath: string | null,
  hostId: string,
) {
  const session = requireConnectedHostSession(deps, hostId);
  const project = getProject(deps.db, packet.projectId);
  const existingThread = getThread(deps.db, packet.threadId);
  const source =
    project || existingThread
      ? getProjectSourceByHost(
          deps.db,
          existingThread?.projectId ?? packet.projectId,
          hostId,
        )
      : null;
  const key = createHash("sha256")
    .update(packet.projectId)
    .digest("hex")
    .slice(0, 20);
  const root =
    targetPath ??
    source?.path ??
    joinHostPathSegments(session.dataDir, "mirrored-projects", key);
  if (source && source.path !== root)
    fail("The target project is already attached to a different folder");
  return root;
}

export async function transferThread(
  deps: Deps,
  request: ThreadTransferRequest,
): Promise<ThreadTransferResponse> {
  const threadId =
    "packet" in request ? request.packet.threadId : request.threadId;
  if (activeTransfers.has(threadId))
    fail("A transfer for this thread is already running");
  activeTransfers.add(threadId);
  try {
    if (request.action === "cancel") {
      const thread = requirePublicThread(deps.db, threadId);
      const metadata = getThreadPluginMetadata(
        deps.db,
        threadId,
        namespace,
      ).metadata;
      if (
        metadata.transferId !== request.transferId ||
        metadata.exportedSequence !==
          getLatestThreadSequence(deps.db, { threadId })
      )
        fail("The thread changed after transfer preparation");
      deps.db
        .update(threads)
        .set({
          archivedAt:
            typeof metadata.previousArchivedAt === "number"
              ? metadata.previousArchivedAt
              : null,
          updatedAt: Date.now(),
        })
        .where(eq(threads.id, thread.id))
        .run();
      deps.hub.notifyThread(threadId, ["status-changed"]);
      return { action: "cancel", ok: true };
    }
    if (request.action === "export") {
      const thread = requirePublicThread(deps.db, threadId);
      requireIdle(thread);
      if (thread.environmentId === null)
        fail("This thread has no project folder to move");
      const environment = requireEnvironment(deps.db, thread.environmentId);
      if (environment.path === null) fail("The project folder is unavailable");
      const project = getProject(deps.db, thread.projectId);
      if (!project || project.kind === "personal")
        fail("Attach this thread to a project before moving it");
      const concurrent = deps.db
        .select({ id: threads.id })
        .from(threads)
        .where(
          and(
            eq(threads.projectId, project.id),
            ne(threads.id, threadId),
            isNull(threads.deletedAt),
            notInArray(threads.status, ["idle", "error", "pending"]),
          ),
        )
        .limit(1)
        .get();
      if (concurrent)
        fail(
          "Stop other active threads in this project before moving its files",
        );
      const session = getStoredProviderSession(deps.db, threadId);
      if (session.kind !== "owned")
        fail(
          "This chat has no native Codex session. Continue it once or use context import.",
        );
      deps.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, threadId))
        .run();
      try {
        await stopThreadForCurrentState(deps, thread, environment, {
          requireStopped: true,
        });
        const prepared = await native(
          deps,
          environment.hostId,
          threadId,
          session.providerThreadId,
          "export",
        );
        const sourceSequence = getLatestThreadSequence(deps.db, { threadId });
        const old = getThreadPluginMetadata(
          deps.db,
          threadId,
          namespace,
        ).metadata;
        const host = requireConnectedHostSession(deps, environment.hostId);
        const transferId =
          typeof old.transferId === "string"
            ? old.transferId
            : `${environment.hostId}:${threadId}`;
        const execution = getThreadExecutionOverride(deps.db, threadId);
        const packet = threadTransferPacketSchema.parse({
          version: 1,
          transferId,
          threadId,
          providerThreadId: session.providerThreadId,
          projectId:
            typeof old.originProjectId === "string"
              ? old.originProjectId
              : project.id,
          sourceProjectId: project.id,
          projectName: project.name,
          title: thread.title,
          model: execution?.modelOverride ?? null,
          reasoningLevel: execution?.reasoningLevelOverride ?? null,
          sourceSequence,
          events: listStoredEventRows(deps.db, { threadId }).map((row) => ({
            createdAt: row.createdAt,
            event: parseStoredThreadEvent({
              threadId,
              type: row.type,
              providerThreadId: row.providerThreadId,
              scope:
                row.scopeKind === "turn"
                  ? { kind: "turn", turnId: row.turnId ?? "" }
                  : { kind: "thread" },
              data: z
                .record(z.string(), z.unknown())
                .parse(JSON.parse(row.data)),
            }),
          })),
        });
        patchThreadPluginMetadata(deps.db, {
          threadId,
          pluginId: namespace,
          set: {
            transferId,
            exportedSequence: sourceSequence,
            previousArchivedAt: thread.archivedAt,
          },
          remove: [],
        });
        deps.hub.notifyProject(project.id, ["threads-changed"]);
        return {
          action: "export",
          packet,
          location: {
            hostId: environment.hostId,
            projectPath: environment.path,
            nativeRoot: prepared.rootPath,
            storagePath: joinHostPathSegments(
              host.dataDir,
              "thread-storage",
              threadId,
            ),
          },
        };
      } catch (error) {
        deps.db
          .update(threads)
          .set({ archivedAt: thread.archivedAt })
          .where(eq(threads.id, threadId))
          .run();
        throw error;
      }
    }
    const packet = request.packet;
    assertTarget(deps, packet);
    const hostId = requirePrimaryHostId(deps);
    const host = requireConnectedHostSession(deps, hostId);
    const root = targetProjectPath(deps, packet, request.targetPath, hostId);
    if (request.action === "prepare") {
      const prepared = await native(
        deps,
        hostId,
        threadId,
        packet.providerThreadId,
        "prepare",
      );
      return {
        action: "prepare",
        projectId: findOrCreateProjectByLocalPathSource(deps.db, deps.hub, {
          name: packet.projectName,
          source: { type: "local_path", hostId, path: root },
        }).project.id,
        location: {
          hostId,
          projectPath: root,
          nativeRoot: prepared.rootPath,
          storagePath: joinHostPathSegments(
            host.dataDir,
            "thread-storage",
            threadId,
          ),
        },
      };
    }
    const workspace = await callHostOnlineRpcForWork(deps, {
      hostId,
      timeoutMs: 180_000,
      command: {
        type: "host.workspace_sync",
        operation: { action: "snapshot", rootPath: root },
      },
    });
    if (workspace.action !== "snapshot" || !workspace.rootExists)
      fail("Transfer the project files before activating the native session");
    const activated = await native(
      deps,
      hostId,
      threadId,
      packet.providerThreadId,
      "activate",
    );
    const provider = deps.providerRegistry.get("codex");
    if (!provider) fail("The Codex provider is unavailable");
    const targetProjectId = deps.db.transaction(
      (tx) => {
        assertTarget(deps, packet);
        const existing = getThread(tx, threadId);
        const project = existing
          ? getProject(deps.db, existing.projectId)
          : findOrCreateProjectByLocalPathSource(deps.db, noopNotifier, {
              name: packet.projectName,
              source: { type: "local_path", hostId, path: root },
            }).project;
        if (project === null) fail("The project was removed during transfer");
        if (!getProjectSourceByHost(tx, project.id, hostId))
          createProjectSource(deps.db, noopNotifier, {
            projectId: project.id,
            hostId,
            type: "local_path",
            path: root,
          });
        const environment =
          findProjectEnvironmentByHostPath(tx, project.id, hostId, root) ??
          createEnvironment(tx, noopNotifier, {
            projectId: project.id,
            hostId,
            path: root,
            providerOwnsPath: false,
            status: "ready",
          });
        if (existing)
          deleteThreadEventSuffixInTransaction(tx, {
            threadId,
            cutoffSequence: 1,
            oldMaxSequence: getLatestThreadSequence(tx, { threadId }),
          });
        else
          createThread(tx, noopNotifier, {
            id: threadId,
            projectId: project.id,
            environmentId: environment.id,
            providerId: "codex",
            title: packet.title,
            status: "idle",
          });
        tx.update(threads)
          .set({
            projectId: project.id,
            environmentId: environment.id,
            providerId: "codex",
            title: packet.title,
            modelOverride: packet.model,
            reasoningLevelOverride: packet.reasoningLevel,
            archivedAt: null,
            status: "idle",
            updatedAt: Date.now(),
          })
          .where(eq(threads.id, threadId))
          .run();
        const rows: AppendStoredThreadEventArgs[] = packet.events.map(
          ({ event }, index) => ({
            ...buildThreadEventRow({
              id: `transfer-${index}`,
              threadId,
              seq: index + 1,
              createdAt: Date.now(),
              scope: event.scope,
              event,
            }),
            environmentId: environment.id,
            providerThreadId:
              "providerThreadId" in event ? event.providerThreadId : null,
          }),
        );
        const sequences = appendThreadEventsInTransaction(tx, rows);
        for (const [index, row] of packet.events.entries())
          tx.update(events)
            .set({ createdAt: row.createdAt })
            .where(
              and(
                eq(events.threadId, threadId),
                eq(events.sequence, sequences[index]!),
              ),
            )
            .run();
        patchThreadPluginMetadata(deps.db, {
          threadId,
          pluginId: namespace,
          set: {
            transferId: packet.transferId,
            sourceSequence: packet.sourceSequence,
            originProjectId: packet.projectId,
          },
          remove: ["exportedSequence"],
        });
        patchThreadPluginMetadata(deps.db, {
          threadId,
          pluginId: provider.pluginId,
          set: { portableCodexHome: activated.nativeHome },
          remove: [],
        });
        return project.id;
      },
      { behavior: "immediate" },
    );
    deps.hub.notifyThread(
      threadId,
      [
        "thread-created",
        "history-rewritten",
        "environment-changed",
        "status-changed",
      ],
      { projectId: targetProjectId },
    );
    deps.hub.notifyProject(targetProjectId, ["threads-changed"]);
    return { action: "apply", threadId, projectId: targetProjectId };
  } finally {
    activeTransfers.delete(threadId);
  }
}
