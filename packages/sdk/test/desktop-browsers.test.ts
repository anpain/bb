import { afterEach, describe, expect, it, vi } from "vitest";
import { createBbSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";

const scope = {
  hostId: "host",
  instanceId: "window",
  generation: "generation",
  threadId: "thread",
};
afterEach(() => vi.useRealTimers());

describe("desktop browser SDK", () => {
  it("keeps the computer grant local while forwarding typed scoped actions", async () => {
    const fetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        Response.json({
          active: false,
          window: null,
          expiresAt: null,
          screenshot: null,
        }),
    );
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        runtime: "node",
        fetch,
      }),
    });
    await sdk.experimental_desktopBrowsers.experimental_computer({
      ...scope,
      input: { action: "stop" },
    });
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      "/desktop-browsers/computer",
    );
  });
  it("leaves default policy at the server and keeps scope explicit", async () => {
    const requests: object[] = [];
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        runtime: "node",
        fetch: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return Response.json({ tab: { tabId: "tab" } });
        },
      }),
    });
    await sdk.experimental_desktopBrowsers.createTab(scope);
    await sdk.experimental_desktopBrowsers.acquireControl({
      ...scope,
      tabIds: ["tab"],
      controllerLabel: "Example",
    });
    expect(requests).toEqual([
      scope,
      { ...scope, tabIds: ["tab"], controllerLabel: "Example" },
    ]);
  });

  it("does not overlap polls or deliver results after disposal", async () => {
    vi.useFakeTimers();
    let resolve: (value: Response) => void = () => {
      throw new Error("Not started");
    };
    const fetch = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        runtime: "node",
        fetch,
      }),
    });
    const onChange = vi.fn();
    const onError = vi.fn();
    const subscription = sdk.experimental_desktopBrowsers.subscribe({
      ...scope,
      onChange,
      onError,
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).toHaveBeenCalledTimes(1);
    subscription.dispose();
    resolve(Response.json({ tabs: [] }));
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
