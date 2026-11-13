import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  setupGuideVariantSchema,
  type RecordTelemetryEventRequest,
  type SetupGuideVariant,
} from "@bb/server-contract";
import type { ServerLogger } from "../../types.js";
import type { TelemetryEvent } from "./telemetry.js";

export const SETUP_GUIDE_ASSIGNMENT_FILE_NAME = "setup-guide-assignment.json";

type SetupGuideAssignmentSource = "override" | "flag" | "default";

interface FlagAssignment {
  variant: SetupGuideVariant;
  source: SetupGuideAssignmentSource;
}

export interface SetupGuideAssignments {
  guide: FlagAssignment;
}

export interface SetupGuideExperiment {
  resolve(): Promise<SetupGuideAssignments>;
  recordExposure(entry: "first_run" | "replay"): Promise<void>;
  annotate(event: RecordTelemetryEventRequest): Promise<TelemetryEvent>;
}

interface CreateSetupGuideExperimentArgs {
  dataDir: string;
  logger: ServerLogger;
  override: SetupGuideVariant | null;
}

const DEFAULT_GUIDE: FlagAssignment = { variant: "control", source: "default" };

const persistedSourceSchema = z.enum(["flag", "default"]);

const persistedGuideSchema = z
  .object({ variant: setupGuideVariantSchema, source: persistedSourceSchema })
  .strict();

const persistedAssignmentsSchema = z.object({
  guide: persistedGuideSchema.nullable(),
});

type PersistedAssignments = z.infer<typeof persistedAssignmentsSchema>;

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function persistedFromJson(json: unknown): PersistedAssignments | null {
  const parsed = persistedAssignmentsSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

async function readPersistedAssignments(
  path: string,
  logger: ServerLogger,
): Promise<PersistedAssignments | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      logger.debug({ err: error }, "Setup guide assignment read failed");
    }
    return null;
  }
  const parsed = persistedFromJson(parseJsonText(text));
  if (parsed === null) {
    logger.debug({ path }, "Ignoring an invalid setup guide assignment file");
  }
  return parsed;
}

export async function createSetupGuideExperiment(
  args: CreateSetupGuideExperimentArgs,
): Promise<SetupGuideExperiment> {
  const assignmentPath = join(args.dataDir, SETUP_GUIDE_ASSIGNMENT_FILE_NAME);
  const persisted = await readPersistedAssignments(assignmentPath, args.logger);
  const assignments: SetupGuideAssignments = {
    guide:
      args.override === null
        ? (persisted?.guide ?? DEFAULT_GUIDE)
        : { variant: args.override, source: "override" },
  };

  return {
    resolve: async () => assignments,
    recordExposure: async () => {},
    annotate: async (event) => event,
  };
}
