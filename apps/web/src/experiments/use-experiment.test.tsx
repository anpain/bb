// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExperimentBootstrap } from "./flags";

async function loadModules() {
  const [router, client, server, experiments] = await Promise.all([
    import("@tanstack/react-router"),
    import("react-dom/client"),
    import("react-dom/server"),
    import("./use-experiment"),
  ]);
  return { router, client, server, experiments };
}

type Modules = Awaited<ReturnType<typeof loadModules>>;

function createProbeRouter(
  modules: Modules,
  serverExperiments: ExperimentBootstrap | null,
) {
  const { router, experiments } = modules;
  function Probe() {
    const variant = experiments.useExperiment("homepage-qa-check");
    return (
      <main data-qa-check={variant === "test" ? variant : undefined}>
        {variant}
      </main>
    );
  }
  const rootRoute = router.createRootRoute({
    beforeLoad: experiments.experimentsBeforeLoad,
    component: () => (
      <experiments.RouteExperimentsProvider>
        <Probe />
      </experiments.RouteExperimentsProvider>
    ),
  });
  const instance = router.createRouter({
    routeTree: rootRoute,
    history: router.createMemoryHistory({ initialEntries: ["/"] }),
  });
  if (serverExperiments !== null) {
    instance.update({
      additionalContext: { serverContext: { experiments: serverExperiments } },
    });
  }
  return instance;
}

async function serverRender(
  modules: Modules,
  experiments: ExperimentBootstrap,
): Promise<string> {
  const instance = createProbeRouter(modules, experiments);
  await instance.load();
  return modules.server.renderToString(
    <modules.router.RouterProvider router={instance} />,
  );
}

async function hydratePage(
  modules: Modules,
  experiments: ExperimentBootstrap | null,
  html: string,
) {
  const errors: unknown[] = [];
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args);
  });
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const instance = createProbeRouter(modules, experiments);
  await instance.load();
  await act(async () => {
    modules.client.hydrateRoot(
      container,
      <modules.router.RouterProvider router={instance} />,
      { onRecoverableError: (error) => errors.push(error) },
    );
  });
  return { container, errors };
}

function bootstrap(
  featureFlags: Record<string, string>,
  preview = false,
): ExperimentBootstrap {
  return { distinctID: null, featureFlags, preview };
}

describe("server-rendered experiments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("hydrates the selected variant", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const modules = await loadModules();
    const experiments = bootstrap({ "homepage-qa-check": "test" }, true);
    const html = await serverRender(modules, experiments);
    expect(html).toContain('<main data-qa-check="test">test</main>');
    const { container, errors } = await hydratePage(modules, experiments, html);
    expect(errors).toEqual([]);
    expect(container.innerHTML).toBe(html);
  });
});
