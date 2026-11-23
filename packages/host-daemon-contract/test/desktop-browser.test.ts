import { describe, expect, it } from "vitest";
import {
  desktopBrowserCommandSchema,
  desktopBrowserResultSchemas,
} from "../src/desktop-browser.js";
import { desktopBrowserImportSourceIdSchema } from "../src/desktop-browser-import.js";

const scope = {
  instanceId: "window",
  generation: "generation",
  threadId: "thread",
};
describe("desktop browser command boundaries", () => {
  it("accepts scoped computer input but rejects remote grants, scripts and out-of-window coordinates", () => {
    const command = (input: object) =>
      desktopBrowserCommandSchema.safeParse({
        type: "desktop.computer.action",
        ...scope,
        input,
      }).success;
    expect(command({ action: "click", x: 0.2, y: 0.8, button: "left" })).toBe(
      true,
    );
    for (const input of [
      { action: "allow", windowId: "123" },
      { action: "script", code: "anything" },
      { action: "click", x: 2, y: 0, button: "left" },
      { action: "key", key: "Alt+Tab" },
      { action: "key", key: "Win+R" },
    ])
      expect(command(input)).toBe(false);
  });
  it.each(["dia", "zen", `storage-${"a".repeat(64)}`])(
    "accepts %s import discovery and selection across the wire",
    (sourceId) => {
      expect(
        desktopBrowserCommandSchema.safeParse({
          type: "desktop.browser.import_cookies",
          instanceId: scope.instanceId,
          generation: scope.generation,
          sourceId,
          sourceProfileDirectory: "Default",
        }).success,
      ).toBe(true);
      expect(
        desktopBrowserResultSchemas[
          "desktop.browser.list_import_sources"
        ].safeParse({
          sources: [
            {
              id: sourceId,
              name: "Browser",
              profiles: [{ directory: "Default", name: "Personal" }],
            },
          ],
        }).success,
      ).toBe(true);
    },
  );

  it("rejects path-shaped and malformed discovered source IDs", () => {
    for (const id of [
      "/tmp/Cookies",
      "../profile",
      "storage-",
      "storage-anything",
      `storage-${"a".repeat(65)}`,
    ]) {
      expect(desktopBrowserImportSourceIdSchema.safeParse(id).success).toBe(
        false,
      );
    }
  });

  it("rejects arbitrary RPC, endpoints, unsupported navigation schemes, and duplicate grants", () => {
    expect(
      desktopBrowserCommandSchema.safeParse({
        type: "desktop.browser.rpc",
        method: "Runtime.evaluate",
      }).success,
    ).toBe(false);
    expect(
      desktopBrowserCommandSchema.safeParse({
        type: "desktop.browser.open_connection",
        ...scope,
        leaseId: "lease",
        tabIds: ["tab"],
        endpoint: "http://internal",
      }).success,
    ).toBe(false);
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,test",
      "https://user:password@example.com",
    ]) {
      expect(
        desktopBrowserCommandSchema.safeParse({
          type: "desktop.browser.create_tab",
          ...scope,
          tabId: "tab",
          url,
          presentation: "hidden",
        }).success,
      ).toBe(false);
    }
    expect(
      desktopBrowserCommandSchema.safeParse({
        type: "desktop.browser.acquire_control",
        ...scope,
        leaseId: "lease",
        controllerLabel: "Agent",
        expiresAt: Date.now() + 1000,
        tabIds: ["tab", "tab"],
      }).success,
    ).toBe(false);
  });

  it("requires explicit thread, generation, and scoped local connection results", () => {
    expect(
      desktopBrowserCommandSchema.safeParse({
        type: "desktop.browser.list_tabs",
        instanceId: "window",
      }).success,
    ).toBe(false);
    for (const wsEndpoint of [
      "ws://example.com:1234/",
      "http://127.0.0.1:1234/",
      "ws://user:pass@127.0.0.1:1234/",
    ]) {
      expect(
        desktopBrowserResultSchemas[
          "desktop.browser.open_connection"
        ].safeParse({ wsEndpoint, expiresAt: Date.now() + 1000 }).success,
      ).toBe(false);
    }
    expect(
      desktopBrowserResultSchemas["desktop.browser.open_connection"].safeParse({
        wsEndpoint: "ws://127.0.0.1:1234/scoped/credential",
        expiresAt: Date.now() + 1000,
      }).success,
    ).toBe(true);
  });
});
