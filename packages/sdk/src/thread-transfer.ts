import { createHash } from "node:crypto";
import { join } from "node:path";
import { storedAttachmentPaths } from "@bb/domain";
import { threadTransferPacketSchema } from "@bb/server-contract";
import type { BbSdk } from "./core.js";
import { BbHttpError } from "./response.js";
import { experimental_syncWorkspacePair } from "./workspace-sync-state.js";
import {
  experimental_synchronizeWorkspaces,
  type WorkspaceSyncBaseline,
  type WorkspaceSyncEndpoint,
} from "./workspace-sync.js";

export interface ThreadTransferClient {
  id: string;
  sdk: Pick<BbSdk, "threads" | "files" | "projects">;
}

export async function experimental_moveThread(args: {
  source: ThreadTransferClient;
  target: ThreadTransferClient;
  threadId: string;
  stateDir: string;
  targetPath?: string;
  signal?: AbortSignal;
  onProgress?(value: {
    phase: string;
    path: string | null;
    bytes: number;
    totalBytes: number;
  }): void;
}) {
  const signal = args.signal ?? new AbortController().signal;
  args.onProgress?.({
    phase: "Preparing native session",
    path: null,
    bytes: 0,
    totalBytes: 0,
  });
  const exported = await args.source.sdk.threads.experimental_transfer(
    { action: "export", threadId: args.threadId },
    signal,
  );
  if (exported.action !== "export")
    throw new Error("Unexpected thread export response");
  let applied = false;
  let activationAttempted = false;
  try {
    const prepared = await args.target.sdk.threads.experimental_transfer(
      {
        action: "prepare",
        packet: exported.packet,
        targetPath: args.targetPath ?? null,
      },
      signal,
    );
    if (prepared.action !== "prepare")
      throw new Error("Unexpected thread preparation response");
    const source = exported.location;
    const target = prepared.location;
    const endpoint = (
      client: ThreadTransferClient,
      hostId: string,
      rootPath: string,
    ): WorkspaceSyncEndpoint => ({
      rootPath,
      call: (operation, signal) =>
        client.sdk.files.experimental_sync({ hostId, operation }, signal),
    });
    const sourceProject = endpoint(
      args.source,
      source.hostId,
      source.projectPath,
    );
    const targetProject = endpoint(
      args.target,
      target.hostId,
      target.projectPath,
    );
    const reverse =
      `${source.hostId}:${source.projectPath}` >
      `${target.hostId}:${target.projectPath}`;
    const identity = JSON.stringify(
      reverse
        ? [target.hostId, target.projectPath, source.hostId, source.projectPath]
        : [
            source.hostId,
            source.projectPath,
            target.hostId,
            target.projectPath,
          ],
    );
    const statePath = join(
      args.stateDir,
      `${createHash("sha256").update(identity).digest("hex")}.json`,
    );
    args.onProgress?.({
      phase: "Synchronizing project files",
      path: null,
      bytes: 0,
      totalBytes: 0,
    });
    await experimental_syncWorkspacePair({
      identity,
      statePath,
      left: reverse ? targetProject : sourceProject,
      right: reverse ? sourceProject : targetProject,
      signal,
      onProgress: (value) =>
        args.onProgress?.({ phase: "Synchronizing project files", ...value }),
    });
    const copyAuthoritative = async (
      sourceRoot: string,
      targetRoot: string,
      phase: string,
    ) => {
      const left = endpoint(args.source, source.hostId, sourceRoot);
      const right = endpoint(args.target, target.hostId, targetRoot);
      const [one, two] = await Promise.all([
        left.call({ action: "snapshot", rootPath: left.rootPath }, signal),
        right.call({ action: "snapshot", rootPath: right.rootPath }, signal),
      ]);
      if (one.action !== "snapshot" || two.action !== "snapshot")
        throw new Error("Unexpected snapshot response");
      if (!one.rootExists) return;
      const baseline: WorkspaceSyncBaseline = Object.fromEntries(
        two.entries.map((entry) => [entry.path, entry]),
      );
      await experimental_synchronizeWorkspaces({
        left,
        right,
        baseline,
        signal,
        onProgress: (value) => args.onProgress?.({ phase, ...value }),
      });
    };
    await copyAuthoritative(
      source.nativeRoot,
      target.nativeRoot,
      "Transferring native Codex session",
    );
    await copyAuthoritative(
      source.storagePath,
      target.storagePath,
      "Transferring chat files",
    );
    const replacements = new Map<string, string>();
    const attachmentPaths = new Set(
      exported.packet.events.flatMap(({ event }) => {
        const paths = storedAttachmentPaths(JSON.stringify(event));
        if ("item" in event && event.item.type === "userMessage")
          paths.push(
            ...storedAttachmentPaths(JSON.stringify(event.item.content)),
          );
        return paths;
      }),
    );
    for (const path of attachmentPaths) {
      signal.throwIfAborted();
      args.onProgress?.({
        phase: "Transferring attachments",
        path,
        bytes: 0,
        totalBytes: 0,
      });
      const content = await args.source.sdk.projects.attachments.read({
        projectId: exported.packet.sourceProjectId,
        path,
        signal,
      });
      const uploaded = await args.target.sdk.projects.attachments.upload({
        projectId: prepared.projectId,
        clientFile: content.bytes,
        filename: path.split("/").at(-1) ?? "attachment",
        mimeType: content.mimeType,
      });
      replacements.set(path, uploaded.path);
    }
    const packet = threadTransferPacketSchema.parse(
      JSON.parse(
        JSON.stringify(exported.packet, (_key, value: unknown) =>
          typeof value === "string"
            ? (replacements.get(value) ?? value)
            : value,
        ),
      ),
    );
    args.onProgress?.({
      phase: "Activating native session",
      path: null,
      bytes: 0,
      totalBytes: 0,
    });
    activationAttempted = true;
    const result = await args.target.sdk.threads
      .experimental_transfer(
        { action: "apply", packet, targetPath: target.projectPath },
        signal,
      )
      .catch((error: unknown) => {
        if (
          error instanceof BbHttpError &&
          [400, 401, 403, 404, 409].includes(error.status)
        )
          activationAttempted = false;
        throw error;
      });
    if (result.action !== "apply")
      throw new Error("Unexpected thread activation response");
    applied = true;
    return {
      ...result,
      mirror: {
        identity,
        statePath,
        sourceHostId: source.hostId,
        sourcePath: source.projectPath,
        targetHostId: target.hostId,
        targetPath: target.projectPath,
      },
    };
  } finally {
    if (!applied && !activationAttempted)
      await args.source.sdk.threads
        .experimental_transfer(
          {
            action: "cancel",
            threadId: args.threadId,
            transferId: exported.packet.transferId,
          },
          AbortSignal.timeout(15_000),
        )
        .catch(() => undefined);
  }
}
