import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSetupGuideExperiment,
  SETUP_GUIDE_ASSIGNMENT_FILE_NAME,
} from "../../src/services/system/setup-guide-experiment.js";
import { readJson } from "../helpers/json.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function useSavedVariant(harness: TestAppHarness) {
  await writeFile(
    join(harness.config.dataDir, SETUP_GUIDE_ASSIGNMENT_FILE_NAME),
    JSON.stringify({ guide: { variant: "new", source: "flag" } }),
  );
  harness.deps.setupGuideExperiment = await createSetupGuideExperiment({
    dataDir: harness.config.dataDir,
    logger: harness.deps.logger,
    override: null,
  });
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
});
