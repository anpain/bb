// @vitest-environment jsdom
import type { PluginInstallJob } from "@bb/server-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPluginInstallJob } from "@/hooks/cache-owners/plugin-cache-owner";
import { startCatalogPluginInstall } from "@/hooks/queries/plugin-install-job-queries";
import { useOnboardingPluginChange } from "./useOnboardingPluginChange";

const setEnabled = vi.hoisted(() => vi.fn());
vi.mock("@/components/plugin/useSetPluginEnabled", () => ({
  useSetPluginEnabled: () => setEnabled,
}));
vi.mock("@/hooks/cache-owners/plugin-cache-owner", () => ({
  applyPluginInstallJob: vi.fn(),
}));
vi.mock("@/hooks/queries/plugin-install-job-queries", () => ({
  startCatalogPluginInstall: vi.fn(),
}));

const started: PluginInstallJob = {
  id: "job_1",
  target: {
    kind: "catalog",
    entryId: "workflows",
    marketplace: "bb-community",
  },
  displayName: "Workflows",
  state: "running",
};

function renderChange(installed: boolean) {
  const queryClient = new QueryClient();
  return {
    queryClient,
    ...renderHook(
      () =>
        useOnboardingPluginChange({
          pluginId: "workflows",
          entryId: "workflows",
          marketplace: "bb-community",
          installed,
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        ),
      },
    ),
  };
}

afterEach(() => vi.resetAllMocks());

describe("onboarding plugin changes", () => {
  it("starts the catalog install and adds the job to the cache", async () => {
    vi.mocked(startCatalogPluginInstall).mockResolvedValue(started);
    const { queryClient, result } = renderChange(false);
    await expect(act(() => result.current(true))).resolves.toBe(started.id);
    expect(applyPluginInstallJob).toHaveBeenCalledWith({
      queryClient,
      job: started,
    });
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("returns the install error to the caller", async () => {
    const error = new Error("offline");
    vi.mocked(startCatalogPluginInstall).mockRejectedValue(error);
    const { result } = renderChange(false);
    await expect(act(() => result.current(true))).rejects.toBe(error);
    expect(applyPluginInstallJob).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "sets an installed plugin's enabled state to %s",
    async (enabled) => {
      const { result } = renderChange(true);
      await act(() => result.current(enabled));
      expect(setEnabled).toHaveBeenCalledWith("workflows", enabled);
      expect(startCatalogPluginInstall).not.toHaveBeenCalled();
    },
  );
});
