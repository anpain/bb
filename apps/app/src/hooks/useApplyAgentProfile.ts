import { useMutation } from "@tanstack/react-query";
import {
  modelSessionOptionConflict,
  type AgentProfile,
  type SessionOptionSelections,
} from "@bb/domain";
import type { SystemProvidersQuery } from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import { resolveModelReasoningLevel } from "./thread-creation-options/model-catalog-selection";

type ApplyProfile = (
  selection: {
    providerId: string;
    model: string;
    reasoningLevel: NonNullable<AgentProfile["reasoningLevel"]>;
  },
  profile: AgentProfile,
) => void | Promise<void>;

export function useApplyAgentProfile(
  routing: SystemProvidersQuery | undefined,
  currentSessionOptions: SessionOptionSelections,
  apply: ApplyProfile,
) {
  return useMutation({
    mutationFn: async (profile: AgentProfile) => {
      const catalog = await sdk.system.executionOptions({
        ...routing,
        providerId: profile.providerId,
        selectedModel: profile.model ?? undefined,
        preferCached: true,
      });
      const model = catalog.models.find(
        (entry) => entry.model === profile.model,
      );
      if (
        catalog.modelLoadError ||
        !model ||
        !catalog.providers.some(
          (provider) => provider.id === profile.providerId,
        )
      ) {
        throw new Error(
          `${profile.name}: the saved model is unavailable on this machine.`,
        );
      }
      if (modelSessionOptionConflict(model, currentSessionOptions)) {
        throw new Error(
          `${profile.name}: the model conflicts with this chat's provider options.`,
        );
      }
      if (
        profile.reasoningLevel !== null &&
        !model.supportedReasoningEfforts.some(
          (effort) => effort.reasoningEffort === profile.reasoningLevel,
        )
      ) {
        throw new Error(
          `${profile.name}: the saved reasoning level is unavailable.`,
        );
      }
      await apply(
        {
          providerId: profile.providerId,
          model: model.model,
          reasoningLevel: resolveModelReasoningLevel(
            model,
            profile.reasoningLevel ?? model.defaultReasoningEffort ?? "medium",
          ),
        },
        profile,
      );
    },
  });
}
