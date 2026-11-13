import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createSetupGuideExperiment,
  SETUP_GUIDE_ASSIGNMENT_FILE_NAME,
} from "../../src/services/system/setup-guide-experiment.js";
import type { TelemetryService } from "../../src/services/system/telemetry.js";
import { readJson } from "../helpers/json.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function postEvent(harness: TestAppHarness, body: unknown) {
  return harness.app.request("/api/v1/system/telemetry/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function useSavedVariant(harness: TestAppHarness) {
  const capture = vi.fn<TelemetryService["capture"]>();
  harness.deps.telemetry = { ...harness.deps.telemetry, capture };
  await writeFile(
    join(harness.config.dataDir, SETUP_GUIDE_ASSIGNMENT_FILE_NAME),
    JSON.stringify({ guide: { variant: "new", source: "flag" } }),
  );
  harness.deps.setupGuideExperiment = await createSetupGuideExperiment({
    dataDir: harness.config.dataDir,
    logger: harness.deps.logger,
    override: null,
  });
  return { capture };
}

describe("setup guide route", () => {
  it("serves a saved guide variant without exposing its source", async () => {
    await withTestHarness(async (harness) => {
      await useSavedVariant(harness);

      const response = await harness.app.request("/api/v1/system/setup-guide");

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({ variant: "new" });
    });
  });

  it("does not record exposures or annotate setup-guide events", async () => {
    await withTestHarness(async (harness) => {
      const { capture } = await useSavedVariant(harness);

      const exposure = await postEvent(harness, {
        name: "onboarding_exposed",
        properties: { entry: "first_run" },
      });
      expect(exposure.status).toBe(200);
      expect(capture).not.toHaveBeenCalled();

      await postEvent(harness, {
        name: "recommendation",
        properties: {
          resource_type: "plugin",
          resource_id: "memory",
          recommendation_id: "V1StGXR8_Z5jdHi6B-myT",
          action: "shown",
          surface: "onboarding",
          entry: "first_run",
        },
      });
      await postEvent(harness, {
        name: "new_thread_submit",
        properties: { outcome: "accepted" },
      });
      expect(capture.mock.calls.map(([event]) => event)).toEqual([
        {
          name: "recommendation",
          properties: {
            resource_type: "plugin",
            resource_id: "memory",
            recommendation_id: "V1StGXR8_Z5jdHi6B-myT",
            action: "shown",
            surface: "onboarding",
            entry: "first_run",
          },
        },
        { name: "new_thread_submit", properties: { outcome: "accepted" } },
      ]);
    });
  });

  it("rejects an exposure event with extra properties", async () => {
    await withTestHarness(async (harness) => {
      const response = await postEvent(harness, {
        name: "onboarding_exposed",
        properties: { entry: "first_run", variant: "new" },
      });

      expect(response.status).toBe(400);
    });
  });
});
