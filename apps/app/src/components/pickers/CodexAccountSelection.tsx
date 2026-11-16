import type { z } from "zod";
import type { codexPoolRoutingSchema } from "@bb/server-contract";

type Routing = z.infer<typeof codexPoolRoutingSchema>;
type Account = Routing["accounts"][number];
type Window = NonNullable<Account["windows"]>[number];

function periodLabel(minutes: number | null) {
  if (minutes === null) return "Limit";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function limitLabel(window: Window) {
  const period = periodLabel(window.minutes);
  return window.remainingPercent === null
    ? period
    : `${period} ${window.remainingPercent}% left`;
}

function statusLabel(account: Account) {
  if (!account.enabled) return "Disabled";
  if (account.status === "exhausted") return "Limit reached";
  if (account.status === "held") return "Temporarily limited";
  if (account.status === "error") return "Account unavailable";
  return null;
}

export interface CodexAccountSelectionProps {
  accountId: string | null;
  defaultLabel: string;
  accounts: readonly Account[];
  onChange: (accountId: string | null) => void;
  disabled?: boolean;
  error?: string;
}

export function CodexAccountSelection({
  accountId,
  defaultLabel,
  accounts,
  onChange,
  disabled,
  error,
}: CodexAccountSelectionProps) {
  const quotaAccounts = accounts.filter(
    (account) =>
      account.enabled && (account.windows?.length || statusLabel(account)),
  );
  return (
    <div className="shrink-0 border-t border-border px-3 py-2">
      <label className="flex items-center justify-between gap-2 text-xs">
        <span>Account</span>
        <select
          value={accountId ?? ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value || null)}
          className="min-w-0 max-w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
        >
          <option value="">{defaultLabel}</option>
          {accountId !== null &&
          !accounts.some((account) => account.id === accountId) ? (
            <option value={accountId} disabled>
              Removed account
            </option>
          ) : null}
          {accounts.map((account) => (
            <option
              key={account.id}
              value={account.id}
              disabled={!account.enabled}
            >
              {[
                account.label,
                statusLabel(account),
                ...(account.windows ?? [])
                  .filter((window) => window.remainingPercent !== null)
                  .map(limitLabel),
              ]
                .filter(Boolean)
                .join(" · ")}
            </option>
          ))}
        </select>
      </label>
      {quotaAccounts.length > 0 ? (
        <details className="mt-1.5 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Account limits</summary>
          <div className="mt-1 max-h-24 space-y-1.5 overflow-y-auto">
            {quotaAccounts.map((account) => (
              <div key={account.id}>
                <p className="truncate font-medium text-foreground">
                  {account.label}
                  {statusLabel(account) ? ` · ${statusLabel(account)}` : ""}
                </p>
                {account.windows?.map((window, index) => (
                  <p key={index}>
                    {limitLabel(window)}
                    {window.resetAt === null
                      ? ""
                      : ` · Resets ${new Date(window.resetAt).toLocaleString()}`}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function codexAccountControl(
  routing: Routing | null | undefined,
  model: string,
  accountId: string | null,
  onChange: CodexAccountSelectionProps["onChange"],
  disabled = false,
  error?: string,
): (CodexAccountSelectionProps & { label: string | null }) | undefined {
  if (
    !routing ||
    (routing.accounts.length === 0 &&
      routing.rules.length === 0 &&
      accountId === null)
  ) {
    return undefined;
  }
  if (!routing.enabled && accountId === null) return undefined;
  const modelAccountId =
    routing.rules.find((rule) => rule.model === model)?.accountId ?? null;
  const accountLabel = (id: string) =>
    routing.accounts.find((account) => account.id === id)?.label ??
    "Removed account";
  const effectiveAccount = accountId ?? modelAccountId;
  return {
    accountId,
    accounts: routing.enabled
      ? routing.accounts
      : routing.accounts.map((account) => ({ ...account, enabled: false })),
    defaultLabel:
      modelAccountId === null
        ? "Default (automatic)"
        : `Default · ${accountLabel(modelAccountId)}`,
    label: effectiveAccount === null ? null : accountLabel(effectiveAccount),
    onChange,
    disabled,
    error,
  };
}
