import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSetupGuideExperiment,
  SETUP_GUIDE_ASSIGNMENT_FILE_NAME,
  type SetupGuideAssignments,
} from "../../src/services/system/setup-guide-experiment.js";

function createTestLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

const DEFAULTS: SetupGuideAssignments = {
  guide: { variant: "control", source: "default" },
};

describe("setup guide experiment", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "bb-setup-guide-test-"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dataDir, { recursive: true, force: true });
  });

  function create(override: "control" | "new" | null = null) {
    return createSetupGuideExperiment({
      dataDir,
      logger: createTestLogger(),
      override,
    });
  }

  it("uses the local override without network access", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const experiment = await create("new");

    await expect(experiment.resolve()).resolves.toEqual({
      guide: { variant: "new", source: "override" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns control without network access by default", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const experiment = await create();

    await expect(experiment.resolve()).resolves.toEqual(DEFAULTS);
    expect(fetch).not.toHaveBeenCalled();
    await expect(readdir(dataDir)).resolves.toEqual([]);
  });

  it("reuses a valid saved assignment locally", async () => {
    const saved = { guide: { variant: "new", source: "flag" } };
    await writeFile(
      join(dataDir, SETUP_GUIDE_ASSIGNMENT_FILE_NAME),
      JSON.stringify(saved),
    );
    const experiment = await create();

    await expect(experiment.resolve()).resolves.toEqual(saved);
  });

  it("ignores an invalid saved assignment", async () => {
    await writeFile(
      join(dataDir, SETUP_GUIDE_ASSIGNMENT_FILE_NAME),
      '{"variant":"other"}',
    );
    const experiment = await create();

    await expect(experiment.resolve()).resolves.toEqual(DEFAULTS);
  });
});
