import type { AppInstall } from "@bb/config/app-install";
import type { ServerConfig } from "@bb/config/server";
import type { AppSurface, RequestAppSurface } from "@bb/config/app-surface";
import type {
  RecordTelemetryEventRequest,
  SetupGuideVariant,
} from "@bb/server-contract";
import type { ServerLogger } from "../../types.js";

export type TelemetryAccessRoute = "connect" | "direct" | "loopback";

export type TelemetryInitiator =
  | "user"
  | "agent"
  | "automation"
  | "plugin"
  | "system";

export type TurnFinishedOutcome = "succeeded" | "failed" | "stopped";
export type TurnExecutionLocation =
  | "server_machine"
  | "additional_machine"
  | "unknown";
export type TurnErrorCategory =
  | "none"
  | "auth"
  | "billing"
  | "rate_limit"
  | "limit_reached"
  | "provider_unavailable"
  | "start_failed"
  | "process_exited"
  | "host_lost"
  | "other";

export type TelemetryEvent =
  | {
      name: "turn_finished";
      properties: {
        outcome: TurnFinishedOutcome;
        error_category: TurnErrorCategory;
        provider: string;
        install_turn_number: number;
        execution_location: TurnExecutionLocation;
      };
    }
  | { name: "app_started" }
  | { name: "telemetry_disabled" }
  | {
      name: "thread_created";
      properties: {
        is_child_thread: boolean;
        provider: string;
        initiator?: TelemetryInitiator;
      };
    }
  | {
      name: "user_message_sent";
      properties: {
        is_child_thread: boolean;
        message_source: "queued_message" | "thread_create" | "thread_send";
        provider: string;
        initiator?: TelemetryInitiator;
      };
    }
  | {
      name: "plugin_installed";
      properties: {
        plugin_id: string | null;
        provenance: "builtin" | "catalog" | "direct";
        marketplace: string | null;
        source_kind: "builtin" | "git" | "npm" | "path";
        is_fresh_install: boolean;
        entry_id: string | null;
      };
    }
  | { name: "plugin_use"; properties: { plugin_id: string } }
  | {
      name: "recommendation";
      properties: {
        resource_type: "plugin";
        resource_id: string;
        recommendation_id: string;
        action: "used";
      };
    }
  | {
      name: "onboarding_exposed";
      properties: {
        entry: "first_run" | "replay";
        setup_guide_variant: SetupGuideVariant;
        setup_guide_source: "override" | "flag" | "default";
        $set: { setup_guide_variant: SetupGuideVariant };
      };
    }
  | {
      name: "$feature_flag_called";
      properties: {
        $feature_flag: string;
        $feature_flag_response: string;
      };
    }
  | RecordTelemetryEventRequest
  | {
      name: RecordTelemetryEventRequest["name"];
      properties: Readonly<Record<string, unknown>> & {
        setup_guide_variant: SetupGuideVariant;
      };
    };

export interface FeatureFlagIdentity {
  apiKey: string;
  distinctId: string;
}

export interface TelemetryService {
  capture(event: TelemetryEvent): void;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  featureFlagIdentity(): FeatureFlagIdentity | null;
  setSharedProperty(name: string, value: string): void;
}

interface CreateTelemetryServiceArgs {
  apiKey: string;
  appInstall: AppInstall | null;
  appSurface: AppSurface;
  appVersion: string;
  dataDir: string;
  enabled: boolean;
  telemetryEnabled: boolean;
  logger: ServerLogger;
}

const noopTelemetryService: TelemetryService = {
  isEnabled: () => false,
  capture: () => {},
  setEnabled: () => {},
  featureFlagIdentity: () => null,
  setSharedProperty: () => {},
};

export function createNoopTelemetryService(): TelemetryService {
  return noopTelemetryService;
}

export function appInstallFromServerConfig(
  config: Pick<
    ServerConfig,
    "BB_APP_INSTALL_KIND" | "BB_APP_SOURCE_COMMIT" | "BB_APP_SOURCE_ORIGIN"
  >,
): AppInstall | null {
  switch (config.BB_APP_INSTALL_KIND) {
    case undefined:
      return null;
    case "desktop":
    case "npm":
      return { kind: config.BB_APP_INSTALL_KIND };
    case "source":
      if (
        config.BB_APP_SOURCE_ORIGIN === "official" &&
        config.BB_APP_SOURCE_COMMIT !== undefined
      ) {
        return {
          commit: config.BB_APP_SOURCE_COMMIT,
          kind: "source",
          origin: "official",
        };
      }
      return {
        kind: "source",
        origin: config.BB_APP_SOURCE_ORIGIN === "fork" ? "fork" : "none",
      };
  }
}

export function runWithTelemetryRequest<T>(
  _request: {
    appSurface: RequestAppSurface;
    accessRoute: TelemetryAccessRoute | null;
  },
  callback: () => T,
): T {
  return callback();
}

export async function createTelemetryService(
  _args: CreateTelemetryServiceArgs,
): Promise<TelemetryService> {
  return noopTelemetryService;
}
