import { getAppSettings, getEnvironment } from "@bb/db";
import type { Thread } from "@bb/domain";
import type { SendMessageRequest } from "@bb/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { resolveSystemProviderModels } from "../system/execution-options.js";
import { createThreadFromRequest } from "./thread-create.js";
import { resolveExistingThreadPermissionMode } from "./thread-execution-plan.js";

export async function dispatchAgentProfiles(
  deps: LoggedPendingInteractionWorkSessionDeps,
  thread: Thread,
  payload: SendMessageRequest,
): Promise<string[] | null> {
  const input = payload.input;
  const profiles = getAppSettings(deps.db).agentProfiles;
  const selected = new Set<string>();
  const text = input
    .filter((item) => item.type === "text" && item.visibility !== "agent-only")
    .map((item) => {
      if (item.type !== "text") return "";
      const masked = item.text.replace(
        /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/gu,
        (match) => " ".repeat(match.length),
      );
      for (const match of masked.matchAll(
        /(?:^|\s)@([\p{L}\p{N}_-]+)(?=$|\s|[,;:!?])/gu,
      )) {
        const alias = match[1].toLowerCase();
        const start = (match.index ?? 0) + match[0].indexOf("@");
        if (
          item.mentions.some(
            (mention) =>
              mention.start <= start &&
              mention.end > start &&
              !(
                mention.resource.kind === "plugin" &&
                mention.resource.pluginId === "bb-agent-profiles"
              ),
          )
        )
          continue;
        const profile = profiles.find((candidate) =>
          candidate.aliases.some((value) => value.toLowerCase() === alias),
        );
        if (profile) selected.add(profile.id);
      }
      for (const mention of item.mentions) {
        if (
          mention.resource.kind !== "plugin" ||
          mention.resource.pluginId !== "bb-agent-profiles"
        )
          continue;
        if (masked.slice(mention.start, mention.end).trim().length === 0)
          continue;
        const id = mention.resource.itemId.replace(/^profile:/u, "");
        if (profiles.some((profile) => profile.id === id)) selected.add(id);
      }
      return item.text;
    })
    .join("\n\n");
  if (selected.size === 0) return null;
  if (
    payload.sendAt !== undefined ||
    payload.compactFirst ||
    payload.mode === "steer" ||
    payload.mode === "steer-if-active"
  )
    throw new ApiError(
      422,
      "invalid_request",
      "Profile dispatch cannot be scheduled, compacted or steered. Send a normal message instead.",
    );
  if (
    input.some((item) => item.type !== "text") ||
    input.some(
      (item) =>
        item.type === "text" &&
        item.mentions.some(
          (mention) =>
            mention.resource.kind !== "plugin" ||
            mention.resource.pluginId !== "bb-agent-profiles",
        ),
    )
  )
    throw new ApiError(
      422,
      "invalid_request",
      "Profile dispatch forwards text only. Remove file, thread and other context mentions or attachments and include the needed context as text.",
    );
  const environment =
    thread.environmentId === null
      ? null
      : getEnvironment(deps.db, thread.environmentId);
  if (!environment)
    throw new ApiError(
      409,
      "invalid_request",
      "Agent profiles require a ready chat workspace.",
    );
  const targets: Array<{ profile: (typeof profiles)[number]; model: string }> =
    [];
  for (const profile of profiles.filter((candidate) =>
    selected.has(candidate.id),
  )) {
    if (profile.model === null)
      throw new ApiError(
        422,
        "invalid_request",
        `Choose a default model for ${profile.name} in Settings → Providers → Agent profiles.`,
      );
    const catalog = await resolveSystemProviderModels(deps, {
      hostId: environment.hostId,
      providerId: profile.providerId,
      ...(environment.path === null ? {} : { cwd: environment.path }),
    });
    const model = catalog.models.find((model) => model.model === profile.model);
    if (catalog.modelLoadError || !model)
      throw new ApiError(
        422,
        "invalid_request",
        `${profile.name}: configured provider/model is unavailable. No substitute was selected.`,
      );
    if (
      profile.reasoningLevel !== null &&
      !model.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === profile.reasoningLevel,
      )
    )
      throw new ApiError(
        422,
        "invalid_request",
        `${profile.name}: reasoning level is not supported by this model.`,
      );
    if (
      profile.serviceTier !== null &&
      !model.supportedServiceTiers?.some(
        (tier) => tier.id === profile.serviceTier,
      )
    )
      throw new ApiError(
        422,
        "invalid_request",
        `${profile.name}: service tier is not supported by this model.`,
      );
    targets.push({ profile, model: profile.model });
  }
  const permissionMode = resolveExistingThreadPermissionMode(deps, thread.id);
  const childThreadIds: string[] = [];
  for (const { profile, model } of targets) {
    const child = await createThreadFromRequest(deps, {
      projectId: thread.projectId,
      parentThreadId: thread.id,
      parentNotifications: "auto",
      environment: { type: "reuse", environmentId: environment.id },
      providerId: profile.providerId,
      model,
      permissionMode,
      ...(profile.reasoningLevel === null
        ? {}
        : { reasoningLevel: profile.reasoningLevel }),
      ...(profile.serviceTier === null
        ? {}
        : { serviceTier: profile.serviceTier }),
      title: `${profile.name}: ${text.slice(0, 100)}`,
      input: [{ type: "text", text, mentions: [] }],
      origin: null,
      startedOnBehalfOf: null,
    });
    childThreadIds.push(child.id);
  }
  return childThreadIds;
}
