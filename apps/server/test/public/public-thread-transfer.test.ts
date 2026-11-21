import { expect, it } from "vitest";
import {
  getThread,
  getStoredProviderSession,
  getEnvironment,
  listStoredEventRows,
} from "@bb/db";
import { threadTransferResponseSchema } from "@bb/server-contract";
import { withTestHarness } from "../helpers/test-app.js";
import {
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedEnvironment,
  seedThread,
  seedThreadIdentity,
} from "../helpers/seed.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { stubHostArtifact } from "../helpers/provider-registry.js";

it("moves a native Codex thread between independent databases, keeps its ID and refuses divergent history", async () => {
  await withTestHarness(async (source) => {
    await withTestHarness(async (target) => {
      let targetRootExists = true;
      const install = (harness: typeof source, name: string) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: `host-${name}`,
        });
        seedPrimaryHost(harness.deps, host.id);
        const provider = harness.deps.providerRegistry.get("codex");
        if (!provider) throw new Error("Missing test provider");
        harness.deps.pluginHostArtifacts.set(
          provider.pluginId,
          stubHostArtifact(provider.pluginId),
        );
        registerHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          handle: ({ command }) => {
            if (command.type === "thread.stop")
              return { ok: true, result: { providerCheckpointId: null } };
            if (command.type === "host.workspace_sync")
              return {
                ok: true,
                result: {
                  action: "snapshot",
                  rootExists: name !== "target" || targetRootExists,
                  entries: [],
                },
              };
            if (command.type === "plugin.host.call")
              return {
                ok: true,
                result: {
                  output: {
                    rootPath: `/private/${name}/transfer`,
                    nativeHome: `/private/${name}/codex-home`,
                  },
                },
              };
            throw new Error(`Unexpected command: ${command.type}`);
          },
        });
        return host;
      };
      const sourceHost = install(source, "source");
      const targetHost = install(target, "target");
      const { project } = seedProjectWithSource(source.deps, {
        hostId: sourceHost.id,
        path: "/original/project",
      });
      const environment = seedEnvironment(source.deps, {
        hostId: sourceHost.id,
        projectId: project.id,
        path: "/original/project",
      });
      const thread = seedThread(source.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const nativeId = "01a1f9fd-9acd-79e2-9656-7f6fa5396773";
      seedThreadIdentity(source.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: nativeId,
      });
      const post = (harness: typeof source, body: object) =>
        harness.app.request("/api/v1/threads/transfer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const exportedResponse = await post(source, {
        action: "export",
        threadId: thread.id,
      });
      expect(
        exportedResponse.status,
        await exportedResponse.clone().text(),
      ).toBe(200);
      const exported = threadTransferResponseSchema.parse(
        await exportedResponse.json(),
      );
      if (exported.action !== "export") throw new Error("Expected export");
      expect(getThread(source.db, thread.id)?.archivedAt).not.toBeNull();
      expect(exported.location.projectPath).toBe("/original/project");
      expect(exported.packet.providerThreadId).toBe(nativeId);
      const preparedResponse = await post(target, {
        action: "prepare",
        packet: exported.packet,
        targetPath: "/remote/project",
      });
      expect(
        preparedResponse.status,
        await preparedResponse.clone().text(),
      ).toBe(200);
      const prepared = threadTransferResponseSchema.parse(
        await preparedResponse.json(),
      );
      if (prepared.action !== "prepare") throw new Error("Expected prepare");
      expect(prepared.location.hostId).toBe(targetHost.id);
      expect(
        (
          await post(target, {
            action: "apply",
            packet: {
              ...exported.packet,
              providerThreadId: "01a1f9fd-9acd-79e2-9656-7f6fa5396774",
            },
            targetPath: "/remote/project",
          })
        ).status,
      ).toBe(400);
      targetRootExists = false;
      expect(
        (
          await post(target, {
            action: "apply",
            packet: exported.packet,
            targetPath: "/remote/project",
          })
        ).status,
      ).toBe(409);
      expect(getThread(target.db, thread.id)).toBeNull();
      targetRootExists = true;
      const appliedResponse = await post(target, {
        action: "apply",
        packet: exported.packet,
        targetPath: "/remote/project",
      });
      expect(appliedResponse.status, await appliedResponse.clone().text()).toBe(
        200,
      );
      const moved = getThread(target.db, thread.id);
      expect(moved).toMatchObject({
        providerId: "codex",
        archivedAt: null,
        projectId: prepared.projectId,
      });
      expect(getStoredProviderSession(target.db, thread.id)).toMatchObject({
        kind: "owned",
        providerThreadId: nativeId,
      });
      expect(getEnvironment(target.db, moved?.environmentId ?? "")?.path).toBe(
        "/remote/project",
      );
      expect(
        listStoredEventRows(target.db, { threadId: thread.id }).map(
          (row) => row.createdAt,
        ),
      ).toEqual(exported.packet.events.map((row) => row.createdAt));
      expect(
        (
          await post(target, {
            action: "apply",
            packet: exported.packet,
            targetPath: "/remote/project",
          })
        ).status,
      ).toBe(409);
      const backResponse = await post(target, {
        action: "export",
        threadId: thread.id,
      });
      expect(backResponse.status, await backResponse.clone().text()).toBe(200);
      const back = threadTransferResponseSchema.parse(
        await backResponse.json(),
      );
      if (back.action !== "export") throw new Error("Expected export");
      expect(back.packet.projectId).toBe(project.id);
      const restored = await post(source, {
        action: "apply",
        packet: back.packet,
        targetPath: "/original/project",
      });
      expect(restored.status, await restored.clone().text()).toBe(200);
      expect(getThread(source.db, thread.id)).toMatchObject({
        archivedAt: null,
        projectId: project.id,
      });
      expect(getStoredProviderSession(source.db, thread.id)).toMatchObject({
        kind: "owned",
        providerThreadId: nativeId,
      });
      const retry = await post(source, {
        action: "export",
        threadId: thread.id,
      });
      expect(retry.status).toBe(200);
      expect(getThread(source.db, thread.id)?.archivedAt).not.toBeNull();
      const canceled = await post(source, {
        action: "cancel",
        threadId: thread.id,
        transferId: exported.packet.transferId,
      });
      expect(canceled.status).toBe(200);
      expect(getThread(source.db, thread.id)?.archivedAt).toBeNull();
    });
  });
});
