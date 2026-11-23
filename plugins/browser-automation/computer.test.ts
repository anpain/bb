import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import type { ExperimentalDesktopComputerRequest } from "@get-bb/plugin-sdk";
import { COMPUTER_TOOL, registerComputerTool } from "./computer.js";

function setup(active: boolean) {
  const host = createFakePluginHost({ pluginId: "browser-automation" });
  host.harness.sdk.stub("hosts.list", async () => [
    makeHostResponse({ id: "pc", status: "connected" }),
  ]);
  host.harness.sdk.stub(
    "experimental_desktopBrowsers.listInstances",
    async () => ({
      instances: [
        {
          instanceId: "desktop",
          generation: "fresh",
          hostId: "pc",
          label: "Desktop",
        },
      ],
    }),
  );
  host.harness.sdk.stub(
    "experimental_desktopBrowsers.experimental_computer",
    async (input: ExperimentalDesktopComputerRequest) => ({
      active,
      window: active ? "Allowed" : null,
      expiresAt: active ? Date.now() + 10000 : null,
      screenshot:
        input.input.action === "screenshot"
          ? { mimeType: "image/jpeg", width: 20, height: 10, base64: "frame" }
          : null,
    }),
  );
  registerComputerTool(host.bb);
  return host;
}
it("returns actual screenshot images and always binds calls to the invoking chat", async () => {
  const host = setup(true);
  try {
    const result = await host.harness.callAgentTool(
      COMPUTER_TOOL,
      { hostId: null, input: { action: "screenshot" } },
      { threadId: "thr_owner" },
    );
    expect(result).toMatchObject({
      content: [
        { type: "text" },
        { type: "image", data: "frame", mimeType: "image/jpeg" },
      ],
    });
    for (const [request] of host.harness.sdk.callsTo(
      "experimental_desktopBrowsers.experimental_computer",
    ))
      expect(request).toMatchObject({ threadId: "thr_owner" });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
it("never sends input when no desktop grants access", async () => {
  const host = setup(false);
  try {
    const result = await host.harness.callAgentTool(COMPUTER_TOOL, {
      hostId: null,
      input: { action: "type", text: "do not send" },
    });
    expect(result).toMatchObject({ isError: true });
    for (const [request] of host.harness.sdk.callsTo(
      "experimental_desktopBrowsers.experimental_computer",
    ))
      expect(request).toMatchObject({ input: { action: "status" } });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
it("requests local approval without pretending access is already granted", async () => {
  const host = setup(false);
  try {
    const result = await host.harness.callAgentTool(COMPUTER_TOOL, {
      hostId: null,
      input: {
        action: "request_access",
        reason: "Inspect the project in CorelDRAW",
      },
    });
    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining('"accessRequested":true'),
        },
      ],
    });
    expect(result).toMatchObject({
      content: [{ text: expect.stringContaining('"active":false') }],
    });
    const calls = host.harness.sdk.callsTo(
      "experimental_desktopBrowsers.experimental_computer",
    );
    expect(calls.at(-1)?.[0]).toMatchObject({
      threadId: "thread-test",
      input: { action: "request_access" },
    });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
