import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAppSettings, setAppSettings } from "@bb/db";
import { defaultAppSettings } from "@bb/domain";
import { systemConfigResponseSchema } from "@bb/server-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTelemetryService,
  runWithTelemetryRequest,
} from "../../src/services/system/telemetry.js";
import { createSetupGuideExperiment } from "../../src/services/system/setup-guide-experiment.js";
import { withTestHarness } from "../helpers/test-app.js";
import { readJson } from "../helpers/json.js";

function createTestLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe("telemetry service", () => {
  let dataDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "bb-telemetry-test-"));
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dataDir, { recursive: true, force: true });
  });

  function createService(enabled = true, telemetryEnabled = true) {
    return createTelemetryService({
      apiKey: "phc_test",
      appInstall: null,
      appSurface: "web",
      appVersion: "1.2.3",
      dataDir,
      telemetryEnabled,
      enabled,
      logger: createTestLogger(),
    });
  }

  it("stays fully inert when settings and environment request telemetry", async () => {
    const telemetry = await createService();
    telemetry.setEnabled(true);
    telemetry.setSharedProperty("$feature/setup-guide-redesign", "new");
    telemetry.capture({ name: "app_started" });
    telemetry.capture({ name: "telemetry_disabled" });
    runWithTelemetryRequest(
      { appSurface: "desktop", accessRoute: "connect" },
      () => {
        telemetry.capture({
          name: "thread_created",
          properties: {
            is_child_thread: true,
            provider: "claude-code",
          },
        });
      },
    );

    expect(telemetry.isEnabled()).toBe(false);
    expect(telemetry.featureFlagIdentity()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(readdir(dataDir)).resolves.toEqual([]);
  });

  it("does not evaluate feature flags or record exposures", async () => {
    const telemetry = await createService();
    const experiment = await createSetupGuideExperiment({
      dataDir,
      logger: createTestLogger(),
      override: null,
    });

    await expect(experiment.resolve()).resolves.toEqual({
      guide: { variant: "control", source: "default" },
    });
    await experiment.recordExposure("first_run");
    await expect(
      experiment.annotate({
        name: "onboarding_step_reached",
        properties: { step: "plugins", entry: "first_run" },
      }),
    ).resolves.toEqual({
      name: "onboarding_step_reached",
      properties: { step: "plugins", entry: "first_run" },
    });
    telemetry.capture({ name: "app_started" });

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(readdir(dataDir)).resolves.toEqual([]);
  });

  it("forces saved and requested settings off without a disabled-event ping", async () => {
    await withTestHarness(async (harness) => {
      setAppSettings(harness.db, {
        ...getAppSettings(harness.db),
        telemetryEnabled: true,
      });
      harness.deps.telemetry = await createService();
      const response = await harness.app.request("/api/v1/settings/general", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...defaultAppSettings, telemetryEnabled: true }),
      });

      expect(response.status).toBe(200);
      expect(getAppSettings(harness.db).telemetryEnabled).toBe(false);
      await expect(readJson(response)).resolves.toMatchObject({
        telemetryEnabled: false,
      });
      const config = systemConfigResponseSchema.parse(
        await readJson(await harness.app.request("/api/v1/system/config")),
      );
      expect(config.generalSettings.telemetryEnabled).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
