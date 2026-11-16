import { z } from "zod";

export const codexPoolAccountIdSchema = z.string().uuid();
export const codexPoolModelIdSchema = z.string().trim().min(1).max(256);

export const codexPoolModelRuleSchema = z.object({
  model: codexPoolModelIdSchema,
  accountId: codexPoolAccountIdSchema,
});

export const codexPoolModelRulesSchema = z.array(codexPoolModelRuleSchema);

const codexPoolQuotaWindowSchema = z.object({
  minutes: z.number().int().positive().nullable(),
  remainingPercent: z.number().min(0).max(100).nullable(),
  resetAt: z.number().int().nullable(),
});

export const codexPoolRoutingSchema = z.object({
  enabled: z.boolean(),
  accounts: z.array(
    z.object({
      id: codexPoolAccountIdSchema,
      label: z.string(),
      enabled: z.boolean(),
      status: z
        .enum(["ready", "held", "exhausted", "disabled", "error"])
        .optional(),
      windows: z.array(codexPoolQuotaWindowSchema).optional(),
    }),
  ),
  rules: codexPoolModelRulesSchema,
  accountId: codexPoolAccountIdSchema.nullable(),
});

export const codexPoolThreadSelectionSchema = z.object({
  threadId: z.string().min(1),
  accountId: codexPoolAccountIdSchema.nullable(),
});

export const codexPoolModelSelectionSchema = z.object({
  model: codexPoolModelIdSchema,
  accountId: codexPoolAccountIdSchema.nullable(),
});

export const CODEX_POOL_PLUGIN_ID = "account-pool";
