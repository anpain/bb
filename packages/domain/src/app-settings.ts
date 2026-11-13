import { z } from "zod";
import { completedTurnDisplaySchema } from "./completed-turn-display.js";
import { isValidGitBranchName } from "./git-checkout.js";
import { reasoningLevelSchema, serviceTierSchema } from "./shared-types.js";

export const agentProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().trim().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1).nullable(),
  aliases: z.array(z.string().regex(/^[\p{L}\p{N}_-]+$/u)).min(1),
  reasoningLevel: reasoningLevelSchema.nullable().default(null),
  serviceTier: serviceTierSchema.nullable().default(null),
});
export const agentProfilesSchema = z
  .array(agentProfileSchema)
  .superRefine((profiles, context) => {
    const ids = new Set<string>();
    const aliases = new Set<string>();
    for (const profile of profiles) {
      if (ids.has(profile.id))
        context.addIssue({
          code: "custom",
          message: "Profile IDs must be unique",
        });
      ids.add(profile.id);
      for (const alias of profile.aliases) {
        const key = alias.toLowerCase();
        if (aliases.has(key))
          context.addIssue({
            code: "custom",
            message: `Duplicate profile alias: ${alias}`,
          });
        aliases.add(key);
      }
    }
  });
export const defaultAgentProfiles: z.infer<typeof agentProfilesSchema> = [
  {
    id: "codex",
    name: "Codex",
    providerId: "codex",
    model: null,
    aliases: ["codex", "кодекс"],
    reasoningLevel: null,
    serviceTier: null,
  },
  {
    id: "kimi",
    name: "Kimi",
    providerId: "acp-kimi",
    model: null,
    aliases: ["kimi", "кими"],
    reasoningLevel: null,
    serviceTier: null,
  },
  {
    id: "claude",
    name: "Claude",
    providerId: "claude-code",
    model: null,
    aliases: ["claude", "клод"],
    reasoningLevel: null,
    serviceTier: null,
  },
  {
    id: "opencode",
    name: "OpenCode",
    providerId: "acp-opencode",
    model: null,
    aliases: ["opencode", "опенкод", "опен"],
    reasoningLevel: null,
    serviceTier: null,
  },
];

export const MANAGED_BRANCH_PREFIX_MAX_LENGTH = 64;

export const DEFAULT_MANAGED_BRANCH_PREFIX = "bb/";

export const IDLE_PROVIDER_SESSION_TIMEOUT_MINUTES = [
  0, 5, 10, 30, 60,
] as const;

export const idleProviderSessionTimeoutMinutesSchema = z.literal(
  IDLE_PROVIDER_SESSION_TIMEOUT_MINUTES,
);

export const managedBranchPrefixSchema = z
  .string()
  .max(MANAGED_BRANCH_PREFIX_MAX_LENGTH)
  .refine((prefix) => isValidGitBranchName(`${prefix}slug-thr_id`), {
    message: "Prefix must start a valid git branch name",
  });

export const appSettingsSchema = z
  .object({
    showKeyboardHints: z.boolean(),
    steerActiveThreadOnEnter: z.boolean(),
    terminalCopyOnSelect: z.boolean(),
    confirmThreadArchive: z.boolean(),
    showDiagnosticEvents: z.boolean(),
    keepHistoryAfterContextClear: z.boolean(),
    summarizeShellCommands: z.boolean(),
    providerOrder: z.array(z.string().min(1)),
    agentProfiles: agentProfilesSchema.default(defaultAgentProfiles),
    defaultProviderId: z.string().min(1).nullable(),
    providerCompletedTurnDisplay: z.record(
      z.string().min(1),
      completedTurnDisplaySchema,
    ),
    streamerMode: z.boolean(),
    allowFastServiceTier: z.boolean(),
    telemetryEnabled: z.boolean(),
    managedBranchPrefix: managedBranchPrefixSchema,
    idleProviderSessionTimeoutMinutes: idleProviderSessionTimeoutMinutesSchema,
    machineServerUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      })
      .nullable(),
    machineGitCredentialsEnabled: z.boolean(),
    defaultMachineAccess: z.string().min(1).nullable(),
    onboardingCompletedAt: z.string().min(1).nullable(),
    earlyAdopter: z.boolean(),
  })
  .strict();
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const defaultAppSettings: AppSettings = {
  showKeyboardHints: true,
  steerActiveThreadOnEnter: true,
  terminalCopyOnSelect: true,
  confirmThreadArchive: true,
  showDiagnosticEvents: false,
  keepHistoryAfterContextClear: false,
  summarizeShellCommands: true,
  providerOrder: [],
  agentProfiles: defaultAgentProfiles,
  defaultProviderId: null,
  providerCompletedTurnDisplay: {},
  streamerMode: false,
  allowFastServiceTier: true,
  telemetryEnabled: false,
  managedBranchPrefix: DEFAULT_MANAGED_BRANCH_PREFIX,
  idleProviderSessionTimeoutMinutes: 30,
  machineServerUrl: null,
  defaultMachineAccess: null,
  machineGitCredentialsEnabled: true,
  onboardingCompletedAt: null,
  earlyAdopter: false,
};

export const disabledProviderIdsSchema = z.array(z.string().min(1));

export const appSettingsUpdateSchema = z.union([
  appSettingsSchema.extend({
    idleProviderSessionTimeoutMinutes:
      idleProviderSessionTimeoutMinutesSchema.optional(),
    terminalCopyOnSelect: z.boolean().optional(),
    allowFastServiceTier: z.boolean().optional(),
    telemetryEnabled: z.boolean().optional(),
    confirmThreadArchive: z.boolean().optional(),
    keepHistoryAfterContextClear: z.boolean().optional(),
    summarizeShellCommands: z.boolean().optional(),
    showUnhandledProviderEvents: z.boolean().optional(),
    onboardingCompletedAt: z.string().min(1).nullable().optional(),
    earlyAdopter: z.boolean().optional(),
  }),
  appSettingsSchema.omit({ showDiagnosticEvents: true }).extend({
    idleProviderSessionTimeoutMinutes:
      idleProviderSessionTimeoutMinutesSchema.optional(),
    terminalCopyOnSelect: z.boolean().optional(),
    allowFastServiceTier: z.boolean().optional(),
    telemetryEnabled: z.boolean().optional(),
    confirmThreadArchive: z.boolean().optional(),
    keepHistoryAfterContextClear: z.boolean().optional(),
    summarizeShellCommands: z.boolean().optional(),
    showUnhandledProviderEvents: z.boolean(),
    onboardingCompletedAt: z.string().min(1).nullable().optional(),
    earlyAdopter: z.boolean().optional(),
  }),
]);
export type AppSettingsUpdate = z.infer<typeof appSettingsUpdateSchema>;
