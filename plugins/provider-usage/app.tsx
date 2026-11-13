import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import {
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  experimental_useSidebarThreads,
  experimental_usePluginId,
  experimental_useProviders,
  type ExperimentalSidebarFooterDisclosureProps,
  useBbContext,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  formatUsageReset,
  formatUsdCents,
  usageBarColorClass,
} from "./usage-format.js";
import { LIST_HOVER_TRANSITION } from "@/components/ui/motion";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
} from "@/components/ui/option-display";
import {
  providerUsageTone,
  selectUsageMachine,
  usageRpcSuccessSchema,
  type UsageMachine,
  type UsageProvider,
  type UsageSnapshot,
  type UsageWindow as UsageWindowValue,
} from "./usage-schema.js";
import {
  emptyUsageMessage,
  hasReportedUsage,
  offlineUsageMessage,
  usageFeedbackMessages,
} from "./usage-feedback.js";

import { UsageSettings } from "./settings.js";

export interface UsageStoreSnapshot {
  data: UsageSnapshot | null;
  error: string | null;
  isRefreshing: boolean;
}

const ALL_PROVIDERS_TAB_ID = "all";
const CARD_MAX_AGE_MS = 60_000;
const FOCUS_MAX_AGE_MS = 30_000;
const SAFETY_REFRESH_INTERVAL_MS = 60_000;
const storeListeners = new Set<() => void>();
let storeSnapshot: UsageStoreSnapshot = {
  data: null,
  error: null,
  isRefreshing: false,
};
let activeRefreshCount = 0;
let queuedRefresh: Promise<void> = Promise.resolve();
let lastMachineId: string | null = null;
let lastProviderIdByMachine = new Map<string, string>();

function readSelectedMachine(storageKey: string | null): string | null {
  if (lastMachineId !== null) return lastMachineId;
  if (storageKey !== null) {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored !== null && stored.length > 0) return stored;
    } catch {}
  }
  return lastMachineId;
}

function updateStore(next: UsageStoreSnapshot): void {
  storeSnapshot = next;
  for (const listener of storeListeners) listener();
}

function subscribeStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => storeListeners.delete(listener);
}

function getStoreSnapshot(): UsageStoreSnapshot {
  return storeSnapshot;
}

function useUsageMachine(snapshot: UsageStoreSnapshot) {
  const pluginId = experimental_usePluginId();
  const { threadId } = useBbContext();
  const sidebarThreads = experimental_useSidebarThreads();
  return selectUsageMachine(
    snapshot.data?.machines ?? [],
    readSelectedMachine(`bb.${pluginId}.selected-machine.v1`),
    sidebarThreads.threads.find((thread) => thread.id === threadId)?.host?.id ??
      null,
  );
}

function rpcErrorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = Reflect.get(body, "error");
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return null;
  const message = Reflect.get(error, "message");
  return typeof message === "string" ? message : null;
}

function refreshUsage({
  pluginId,
  force,
  machineIds,
  maxAgeMs,
  providerIds,
  signal,
}: {
  pluginId: string;
  force: boolean;
  machineIds: string[] | null;
  maxAgeMs: number;
  providerIds: string[];
  signal?: AbortSignal;
}): Promise<void> {
  activeRefreshCount += 1;
  updateStore({ ...storeSnapshot, error: null, isRefreshing: true });
  queuedRefresh = queuedRefresh.then(async () => {
    try {
      const response = await fetch(
        `/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/getUsage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force, machineIds, maxAgeMs, providerIds }),
          signal:
            signal === undefined
              ? AbortSignal.timeout(60_000)
              : AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        },
      );
      if (!response.ok)
        throw new Error(`Usage request returned HTTP ${response.status}.`);
      const body: unknown = await response.json();
      const parsed = usageRpcSuccessSchema.safeParse(body);
      if (!parsed.success) {
        throw new Error(
          rpcErrorMessage(body) ?? "Provider usage could not be loaded.",
        );
      }
      updateStore({
        data: parsed.data.result,
        error: null,
        isRefreshing: activeRefreshCount > 1,
      });
    } catch (cause) {
      if (signal?.aborted === true) {
        return;
      }
      console.warn("Provider usage refresh failed", cause);
      updateStore({
        ...storeSnapshot,
        error: "Couldn’t refresh usage.",
      });
    } finally {
      activeRefreshCount -= 1;
      if (activeRefreshCount === 0 && storeSnapshot.isRefreshing) {
        updateStore({ ...storeSnapshot, isRefreshing: false });
      }
    }
  });
  return queuedRefresh;
}

function formatResetCountdown(resetsAt: string | null): string | null {
  if (resetsAt === null) return null;
  const remaining = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(remaining)) return null;
  if (remaining <= 0) return "now";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}
function usageToneTextClass(usedPercent: number): string {
  if (usedPercent >= 95) return "text-destructive";
  if (usedPercent >= 80) return "text-warning";
  return "text-sidebar-foreground";
}

type MessageNotice = {
  kind: "stale" | "empty";
  icon: "CloudOff" | "AlertTriangle" | "AlertCircle" | "Info";
  message: string;
  retry: boolean;
};

type CardNotice = { kind: "loading" } | MessageNotice;

function UsageSkeleton({ rows }: { rows: number }) {
  return (
    <div role="status" aria-label={usageFeedbackMessages.loading}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-6 items-center gap-2">
          <Skeleton className="size-3.5 rounded-full" />
          <Skeleton
            className={cn("h-2", index % 2 === 0 ? "w-2/5" : "w-1/3")}
          />
          <span className="flex-1" />
          <Skeleton className="h-2 w-9" />
          <Skeleton className="h-2 w-9" />
        </div>
      ))}
    </div>
  );
}

function UsageNotice({
  notice,
  onRetry,
  className,
}: {
  notice: MessageNotice;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex min-w-0 items-start gap-1.5 text-2xs text-subtle-foreground",
        className,
      )}
    >
      <Icon
        name={notice.icon}
        aria-hidden="true"
        className={cn(
          "mt-px size-3 shrink-0",
          notice.icon === "AlertTriangle" && "text-warning",
        )}
      />
      <span className="min-w-0 flex-1">{notice.message}</span>
      {notice.retry ? (
        <button
          type="button"
          className="shrink-0 rounded-sm text-sidebar-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          onClick={onRetry}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

const USAGE_GRID_CLASS_NAME = "grid grid-cols-1 gap-3";

function UsageWindow({ window }: { window: UsageWindowValue }) {
  const [showReset, setShowReset] = useState(false);
  const reset = formatUsageReset(window.resetsAt);
  const countdown = formatResetCountdown(window.resetsAt);
  const value =
    window.cost === null
      ? Math.max(0, Math.round(100 - window.usedPercent)) + "% remaining"
      : formatUsdCents(window.cost.usedUsdCents, true) +
        " / " +
        formatUsdCents(window.cost.limitUsdCents, false);
  return (
    <button
      type="button"
      className="col-span-full flex flex-col gap-1.5 rounded-md p-1 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      title={`${window.label} · ${reset ?? "Reset time not reported"}`}
      aria-label={`${window.label}: ${value}. ${reset ?? "Reset time not reported"}`}
      aria-expanded={showReset}
      onClick={() => setShowReset((shown) => !shown)}
    >
      <span className="flex items-center justify-between gap-3 text-xs">
        <span className="min-w-0 truncate text-sidebar-foreground">
          {window.label}
        </span>
        <span
          className={cn(
            "shrink-0 font-medium tabular-nums",
            usageToneTextClass(window.usedPercent),
          )}
        >
          {Math.max(0, Math.round(100 - window.usedPercent))}% left
        </span>
      </span>
      <span className="h-1.5 w-full overflow-hidden rounded-full bg-sidebar-border">
        <span
          className={
            "block h-full rounded-full " +
            usageBarColorClass(window.usedPercent)
          }
          style={{
            width: Math.max(0, Math.min(100, 100 - window.usedPercent)) + "%",
          }}
        />
      </span>
      <span className="flex w-full justify-between gap-2 text-2xs text-subtle-foreground">
        <span>
          {countdown === null
            ? "Reset time unavailable"
            : `Resets in ${countdown}`}
        </span>
        {window.cost === null ? null : (
          <span className="tabular-nums">{value}</span>
        )}
      </span>
      {showReset ? (
        <span className="col-span-full pb-1 text-2xs text-subtle-foreground">
          {reset ?? "Reset time not reported."}
          {window.cost === null ? "" : ` · ${value}`}
        </span>
      ) : null}
    </button>
  );
}

function accountStatusMessage(account: UsageProvider): string | null {
  const usage = account.usage;
  switch (usage?.status) {
    case undefined:
      return "Usage not reported.";
    case "ok":
      return usage.windows.length === 0
        ? "No usage limits reported for this plan."
        : null;
    case "not_installed":
      return "Not installed on this machine.";
    case "unauthenticated":
      return account.signInHint;
    case "expired":
      return account.expiredHint;
    case "error":
      return usage.message;
  }
}

function AccountUsage({
  account,
  loading,
  unavailable,
  showProvider,
  framed,
}: {
  account: UsageProvider;
  loading: boolean;
  unavailable: boolean;
  showProvider: boolean;
  framed: boolean;
}) {
  const usage = account.usage;
  const email = usage?.status === "ok" ? usage.accountEmail : null;
  const title = account.accountLabel ?? email ?? account.displayName;
  const plan = usage?.status === "ok" ? usage.planLabel : null;
  const message =
    usage === null && loading
      ? usageFeedbackMessages.loading
      : usage === null && unavailable
        ? usageFeedbackMessages.unavailable
        : accountStatusMessage(account);
  return (
    <section
      aria-label={showProvider ? `${account.displayName} ${title}` : title}
      className={cn(
        "col-span-full grid grid-cols-1 gap-2",
        framed && "rounded-xl border border-sidebar-border bg-sidebar/60 p-3",
      )}
    >
      <div className="col-span-full flex min-w-0 items-center gap-2">
        {showProvider ? (
          <ProviderIcon
            providerKind="agent"
            provider={account}
            fallback="Bot"
            className="size-5 shrink-0"
          />
        ) : null}
        <h3
          title={title}
          className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-foreground"
        >
          {title}
        </h3>
        {plan === null ? null : (
          <span className="shrink-0 rounded-sm bg-sidebar-border/60 px-1 py-0.5 text-2xs leading-none text-subtle-foreground">
            {plan}
          </span>
        )}
      </div>
      {email !== null && email !== title ? (
        <p
          title={email}
          className="col-span-full truncate text-2xs text-subtle-foreground"
        >
          {email}
        </p>
      ) : null}
      {message !== null ? (
        <p className="col-span-full text-2xs text-subtle-foreground">
          {message}
        </p>
      ) : usage?.status === "ok" ? (
        usage.windows.map((window) => (
          <UsageWindow key={window.label} window={window} />
        ))
      ) : null}
    </section>
  );
}

function ProviderAccounts({
  accounts,
  loading,
  unavailable,
  showProvider,
  framed = true,
}: {
  accounts: UsageProvider[];
  loading: boolean;
  unavailable: boolean;
  showProvider: boolean;
  framed?: boolean;
}) {
  return accounts.map((account) => (
    <AccountUsage
      key={account.id}
      account={account}
      loading={loading}
      unavailable={unavailable}
      showProvider={showProvider}
      framed={framed}
    />
  ));
}

function MachineSelector({
  machines,
  activeMachine,
  onSelect,
}: {
  machines: UsageMachine[];
  activeMachine: UsageMachine | null;
  onSelect: (machineId: string) => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={machines.length === 0}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={
            activeMachine === null
              ? "Usage machine"
              : "Usage machine: " + activeMachine.displayName
          }
          disabled={machines.length === 0}
          className={cn(
            OPTION_BASE_CLASS_NAME,
            OPTION_INTERACTIVE_CLASS_NAME,
            LIST_HOVER_TRANSITION,
            "h-6 shrink overflow-hidden px-1.5 text-2xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground",
          )}
        >
          <span className="block min-w-0 flex-1 truncate">
            {activeMachine?.displayName ?? "Usage"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        mobileTitle="Usage source"
        className="max-w-72"
      >
        {machines.map((machine) => {
          const isActive = machine.id === activeMachine?.id;
          return (
            <DropdownMenuItem
              key={machine.id}
              role="menuitemradio"
              aria-label={machine.displayName}
              aria-checked={isActive}
              onSelect={() => onSelect(machine.id)}
              className="flex items-center gap-2"
            >
              <Icon
                name={machine.id.startsWith("source:") ? "Layers" : "Laptop"}
                className="size-3.5 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate">
                {machine.displayName}
              </span>
              <Icon
                name="Check"
                aria-hidden="true"
                className={cn(
                  "size-3.5 shrink-0",
                  isActive ? "opacity-100" : "opacity-0",
                )}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ProviderUsageStatusContent({
  pluginId,
  dismiss,
  snapshot,
  threadMachineId,
  refreshEnabled = true,
  machineSelectionStorageKey = null,
}: ExperimentalSidebarFooterDisclosureProps & {
  pluginId: string;
  snapshot: UsageStoreSnapshot;
  threadMachineId: string | null;
  refreshEnabled?: boolean;
  machineSelectionStorageKey?: string | null;
}) {
  const [, refreshCountdowns] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(
      () => refreshCountdowns((tick) => tick + 1),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, []);
  const machines = snapshot.data?.machines ?? [];
  const requestedMachineId = readSelectedMachine(machineSelectionStorageKey);
  const [requestedProviderIds, setRequestedProviderIds] = useState(
    lastProviderIdByMachine,
  );
  const activeMachine = selectUsageMachine(
    machines,
    requestedMachineId,
    threadMachineId,
  );
  const providers = useMemo(() => {
    const groups = new Map<
      string,
      UsageProvider & { accounts: UsageProvider[] }
    >();
    for (const account of activeMachine?.providers ?? []) {
      if (account.usage?.status === "not_installed") continue;
      const group = groups.get(account.providerId);
      if (group) group.accounts.push(account);
      else
        groups.set(account.providerId, {
          ...account,
          id: account.providerId,
          accounts: [account],
        });
    }
    return [...groups.values()];
  }, [activeMachine]);
  const requestedProviderId =
    activeMachine === null
      ? null
      : (requestedProviderIds.get(activeMachine.id) ?? null);
  const showAllTab = providers.length > 1;
  const tabIds = useMemo(
    () => [
      ...(showAllTab ? [ALL_PROVIDERS_TAB_ID] : []),
      ...providers.map((provider) => provider.id),
    ],
    [providers, showAllTab],
  );
  const activeTabId = tabIds.includes(requestedProviderId ?? "")
    ? requestedProviderId
    : (tabIds[0] ?? null);
  const isAllTab = activeTabId === ALL_PROVIDERS_TAB_ID;
  const activeProvider = isAllTab
    ? null
    : (providers.find((provider) => provider.id === activeTabId) ?? null);
  const activeAccounts = isAllTab
    ? providers.flatMap((provider) => provider.accounts)
    : (activeProvider?.accounts ?? []);
  const hasActiveUsage = hasReportedUsage(activeAccounts);
  const unavailable = activeMachine?.error != null || snapshot.error !== null;
  const notice: CardNotice | null =
    activeMachine === null
      ? snapshot.error !== null
        ? {
            kind: "empty",
            icon: "AlertCircle",
            message: usageFeedbackMessages.loadFailed,
            retry: true,
          }
        : snapshot.isRefreshing
          ? { kind: "loading" }
          : {
              kind: "empty",
              icon: "Info",
              message: usageFeedbackMessages.noSources,
              retry: false,
            }
      : activeMachine.status === "disconnected"
        ? {
            kind: hasActiveUsage ? "stale" : "empty",
            icon: "CloudOff",
            message: offlineUsageMessage(activeMachine, hasActiveUsage),
            retry: false,
          }
        : snapshot.error !== null || activeMachine.error !== null
          ? hasActiveUsage
            ? {
                kind: "stale",
                icon: "AlertTriangle",
                message: usageFeedbackMessages.refreshFailed,
                retry: true,
              }
            : {
                kind: "empty",
                icon: "AlertCircle",
                message: usageFeedbackMessages.loadFailed,
                retry: true,
              }
          : activeAccounts.length === 0
            ? {
                kind: "empty",
                icon: "Info",
                message: emptyUsageMessage(activeMachine),
                retry: false,
              }
            : null;
  const panelId = useId();
  const activeMachineId = activeMachine?.id ?? null;
  const activeProviderId = activeProvider?.id ?? null;
  const refreshProviderIds = isAllTab
    ? providers.map((provider) => provider.id)
    : activeProviderId === null
      ? []
      : [activeProviderId];
  const refreshProviderKey = refreshProviderIds.join("\n");

  useEffect(() => {
    if (!refreshEnabled) return;
    if (activeMachineId === null || refreshProviderKey === "") return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void refreshUsage({
        pluginId,
        force: false,
        machineIds: [activeMachineId],
        providerIds: refreshProviderKey.split("\n"),
        maxAgeMs: CARD_MAX_AGE_MS,
      });
    };
    refresh();
    const timer = window.setInterval(refresh, CARD_MAX_AGE_MS);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [activeMachineId, pluginId, refreshProviderKey, refreshEnabled]);

  const selectMachine = useCallback(
    (machineId: string) => {
      lastMachineId = machineId;
      updateStore({ ...storeSnapshot });
      if (machineSelectionStorageKey !== null) {
        try {
          window.localStorage.setItem(machineSelectionStorageKey, machineId);
        } catch {}
      }
    },
    [machineSelectionStorageKey],
  );

  const selectProvider = useCallback(
    (providerId: string) => {
      if (activeMachine === null) return;
      setRequestedProviderIds((current) => {
        const next = new Map(current);
        next.set(activeMachine.id, providerId);
        lastProviderIdByMachine = next;
        return next;
      });
    },
    [activeMachine],
  );

  const reload = () => {
    void refreshUsage({
      pluginId,
      force: true,
      machineIds: activeMachineId === null ? null : [activeMachineId],
      maxAgeMs: 0,
      providerIds: refreshProviderIds,
    });
  };

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    let nextIndex: number;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % tabIds.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + tabIds.length) % tabIds.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabIds.length - 1;
    } else {
      return;
    }
    const nextTabId = tabIds[nextIndex];
    if (nextTabId === undefined) return;
    event.preventDefault();
    selectProvider(nextTabId);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      .item(nextIndex)
      .focus();
  };

  return (
    <div className="flex max-h-80 flex-col">
      <div
        data-provider-usage-header=""
        className="flex h-9 min-w-0 shrink-0 items-center gap-1 border-b border-sidebar-border px-1.5"
      >
        {providers.length < 2 ? (
          <span className="px-1.5 text-2xs font-medium text-sidebar-foreground">
            Usage
          </span>
        ) : (
          <div
            role="tablist"
            aria-label="Usage provider"
            className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto"
          >
            {showAllTab ? (
              <button
                type="button"
                role="tab"
                title="All accounts"
                aria-label="All accounts"
                aria-selected={isAllTab}
                aria-controls={panelId}
                tabIndex={isAllTab ? 0 : -1}
                className={cn(
                  "relative flex h-6 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring px-2",
                  isAllTab
                    ? "bg-sidebar-accent text-sidebar-foreground"
                    : "text-muted-foreground hover:text-sidebar-foreground",
                )}
                onClick={() => selectProvider(ALL_PROVIDERS_TAB_ID)}
                onKeyDown={(event) => handleTabKeyDown(event, 0)}
              >
                <span aria-hidden="true" className="text-2xs font-medium">
                  All
                </span>
              </button>
            ) : null}
            {providers.map((provider, providerIndex) => {
              const index = providerIndex + (showAllTab ? 1 : 0);
              const isActive = provider.id === activeProvider?.id;
              const tones = provider.accounts.map(providerUsageTone);
              const tone = tones.includes("critical")
                ? "critical"
                : tones.includes("warning")
                  ? "warning"
                  : null;
              return (
                <button
                  key={provider.id}
                  type="button"
                  role="tab"
                  title={
                    tone === null
                      ? provider.displayName
                      : `${provider.displayName}: an account usage window is at least ${tone === "critical" ? "95" : "80"}% used.`
                  }
                  aria-label={provider.displayName}
                  aria-selected={isActive}
                  aria-controls={panelId}
                  tabIndex={isActive ? 0 : -1}
                  className={cn(
                    "relative flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-foreground"
                      : "group/tab text-muted-foreground hover:text-sidebar-foreground",
                  )}
                  onClick={() => selectProvider(provider.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                >
                  <ProviderIcon
                    providerKind="agent"
                    provider={
                      isActive
                        ? provider
                        : { ...provider, strings: { iconTint: null } }
                    }
                    fallback="Bot"
                    className={cn(
                      "size-3.5",
                      !isActive && "opacity-60 group-hover/tab:opacity-100",
                    )}
                  />
                  <span>{provider.displayName}</span>
                  {tone === null || isActive || isAllTab ? null : (
                    <span
                      aria-hidden="true"
                      data-provider-usage-tone={tone}
                      className={cn(
                        "absolute right-0.5 top-0.5 size-1.5 rounded-full ring-2 ring-sidebar",
                        tone === "critical" ? "bg-destructive" : "bg-warning",
                      )}
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}
        <div className="flex min-w-0 flex-1 justify-end">
          {machines.length === 0 ? null : (
            <MachineSelector
              machines={machines}
              activeMachine={activeMachine}
              onSelect={selectMachine}
            />
          )}
        </div>
        <button
          type="button"
          aria-label="Reload provider usage"
          disabled={snapshot.isRefreshing}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-50"
          onClick={reload}
        >
          <Icon
            name="RotateCcw"
            aria-hidden="true"
            className={
              "size-3.5 " + (snapshot.isRefreshing ? "animate-spin" : "")
            }
          />
        </button>
        <button
          type="button"
          aria-label="Collapse provider usage"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          onClick={dismiss}
        >
          <Icon name="ChevronDown" aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-label={
          activeMachine === null
            ? "Provider usage"
            : isAllTab
              ? activeMachine.displayName + " usage for all accounts"
              : activeProvider === null
                ? "Provider usage"
                : activeMachine.displayName +
                  " " +
                  activeProvider.displayName +
                  " usage"
        }
        className="min-h-0 overflow-y-auto p-2.5"
      >
        {notice !== null && notice.kind !== "loading" ? (
          <UsageNotice
            notice={notice}
            onRetry={reload}
            className={notice.kind === "stale" ? "mb-2" : undefined}
          />
        ) : null}
        {notice?.kind === "empty" ? null : notice?.kind === "loading" ? (
          <UsageSkeleton rows={3} />
        ) : isAllTab ? (
          <div className={cn(USAGE_GRID_CLASS_NAME, "gap-y-2.5")}>
            {providers.map((provider) => (
              <div
                key={provider.id}
                className="col-span-full grid grid-cols-1 gap-3"
              >
                <ProviderAccounts
                  accounts={provider.accounts}
                  loading={snapshot.isRefreshing}
                  unavailable={unavailable}
                  showProvider
                />
              </div>
            ))}
          </div>
        ) : activeProvider === null ? null : (
          <div className={cn(USAGE_GRID_CLASS_NAME, "gap-y-2")}>
            <ProviderAccounts
              accounts={activeProvider.accounts}
              loading={snapshot.isRefreshing}
              unavailable={unavailable}
              showProvider
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderUsageStatus(props: ExperimentalSidebarFooterDisclosureProps) {
  const pluginId = experimental_usePluginId();
  const snapshot = useSyncExternalStore(
    subscribeStore,
    getStoreSnapshot,
    getStoreSnapshot,
  );
  const { threadId } = useBbContext();
  const sidebarThreads = experimental_useSidebarThreads();
  const threadMachineId = useMemo(
    () =>
      sidebarThreads.threads.find((thread) => thread.id === threadId)?.host
        ?.id ?? null,
    [sidebarThreads.threads, threadId],
  );
  return (
    <ProviderUsageStatusContent
      {...props}
      pluginId={pluginId}
      snapshot={snapshot}
      threadMachineId={threadMachineId}
      machineSelectionStorageKey={`bb.${pluginId}.selected-machine.v1`}
    />
  );
}

function ProviderUsageGauge() {
  const snapshot = useSyncExternalStore(
    subscribeStore,
    getStoreSnapshot,
    getStoreSnapshot,
  );
  const machine = useUsageMachine(snapshot);
  const windows = (machine?.providers ?? []).flatMap((provider) =>
    provider.usage?.status === "ok" ? provider.usage.windows : [],
  );
  const used =
    windows.length === 0
      ? null
      : Math.max(...windows.map((window) => window.usedPercent));
  const remaining =
    used === null ? null : Math.max(0, Math.min(100, 100 - used));
  return (
    <span
      className="relative flex size-5 items-center justify-center"
      aria-hidden="true"
    >
      <Icon
        name="Zap"
        className={cn(
          "size-5",
          snapshot.isRefreshing && "animate-pulse",
          remaining !== null && used !== null && usageToneTextClass(used),
        )}
      />
    </span>
  );
}

export function railUsageWindows(
  provider: UsageProvider,
): (UsageWindowValue | null)[] {
  const windows = provider.usage?.status === "ok" ? provider.usage.windows : [];
  const worst = (values: UsageWindowValue[]) =>
    values.reduce<UsageWindowValue | null>(
      (result, value) =>
        result === null || value.usedPercent > result.usedPercent
          ? value
          : result,
      null,
    );
  return [
    worst(
      windows.filter((window) => /five.hour|5.hour|daily/iu.test(window.label)),
    ),
    worst(windows.filter((window) => /weekly/iu.test(window.label))) ??
      worst(windows.filter((window) => /monthly/iu.test(window.label))),
  ];
}

function ProviderUsageRail({
  providerIds,
}: {
  providerIds: readonly string[];
}) {
  const directory = experimental_useProviders();
  const pluginId = experimental_usePluginId();
  const snapshot = useSyncExternalStore(
    subscribeStore,
    getStoreSnapshot,
    getStoreSnapshot,
  );
  const machine = useUsageMachine(snapshot);
  const groups = new Map<string, UsageProvider[]>();
  for (const provider of machine?.providers ?? []) {
    if (provider.usage?.status === "not_installed") continue;
    const group = groups.get(provider.providerId) ?? [];
    group.push(provider);
    groups.set(provider.providerId, group);
  }
  const railProviderIds = new Set([
    ...directory.providers
      .filter((provider) => provider.maintenance?.usage)
      .map((provider) => provider.id),
    ...providerIds,
  ]);
  for (const id of railProviderIds) {
    if (groups.has(id)) continue;
    const provider = directory.providers.find((provider) => provider.id === id);
    if (!provider) continue;
    groups.set(id, [
      {
        id,
        providerId: id,
        accountLabel: null,
        displayName: provider.displayName,
        logoUrl: provider.logoUrl,
        icon: provider.icon ?? null,
        strings: { iconTint: provider.strings?.iconTint ?? null },
        signInHint: provider.strings?.signInHint ?? "Sign in to this provider.",
        expiredHint: provider.strings?.expiredHint ?? "Sign in again.",
        usage: null,
      },
    ]);
  }
  return (
    <div className="flex flex-col items-center gap-4">
      {[...groups].map(([id, accounts]) => {
        const provider = accounts[0]!;
        const windows = [0, 1].map((index) =>
          accounts
            .map(railUsageWindows)
            .map((values) => values[index])
            .reduce<UsageWindowValue | null>(
              (worst, value) =>
                value && (!worst || value.usedPercent > worst.usedPercent)
                  ? value
                  : worst,
              null,
            ),
        );
        return (
          <Popover
            key={id}
            onOpenChange={(open) => {
              if (!open || !machine) return;
              void refreshUsage({
                pluginId,
                force: false,
                machineIds: [machine.id],
                maxAgeMs: CARD_MAX_AGE_MS,
                providerIds: [id],
              });
            }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${provider.displayName} usage: ${windows.map((window, index) => (window ? `${window.label}, ${Math.max(0, Math.min(100, 100 - window.usedPercent)).toFixed(0)}% remaining` : `${index === 0 ? "Short-period" : "Weekly"} limit not reported`)).join("; ")}`}
                    className="relative flex size-(--bb-sidebar-control-size) items-center justify-center rounded-md p-0 data-[state=open]:bg-state-active"
                  >
                    <ProviderIcon
                      providerKind="agent"
                      provider={
                        directory.providers.find(
                          (entry) => entry.id === id,
                        ) ?? {
                          ...provider,
                          id,
                        }
                      }
                      className="size-4"
                    />
                    <svg
                      viewBox="0 0 40 40"
                      aria-hidden="true"
                      className="pointer-events-none absolute size-8 overflow-visible"
                      fill="none"
                      strokeWidth="2.3"
                      strokeLinecap="round"
                    >
                      {windows.map((window, index) => (
                        <g key={index}>
                          <path
                            d={
                              index === 0
                                ? "M7 10 A17 17 0 0 1 33 10"
                                : "M4 19 A16 16 0 1 0 36 19"
                            }
                            className="stroke-muted-foreground/30"
                          />
                          {window ? (
                            <path
                              d={
                                index === 0
                                  ? "M7 10 A17 17 0 0 1 33 10"
                                  : "M4 19 A16 16 0 1 0 36 19"
                              }
                              className={cn(
                                "stroke-current",
                                usageToneTextClass(window.usedPercent),
                              )}
                              pathLength="100"
                              strokeDasharray={`${Math.max(0, Math.min(100, 100 - window.usedPercent))} 100`}
                            />
                          ) : null}
                        </g>
                      ))}
                    </svg>
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="right">
                {windows[0]
                  ? `${windows[0].label} · ${Math.max(0, Math.min(100, 100 - windows[0].usedPercent)).toFixed(0)}% remaining`
                  : `${provider.displayName} · Limit not reported`}
              </TooltipContent>
            </Tooltip>
            <PopoverContent
              side="right"
              align="end"
              mobileTitle={`${provider.displayName} usage`}
              className="max-h-[min(32rem,80svh)] w-80 overflow-y-auto p-3"
            >
              <div className="grid gap-2">
                <ProviderAccounts
                  accounts={accounts}
                  loading={snapshot.isRefreshing}
                  unavailable={snapshot.error !== null}
                  showProvider={true}
                  framed={false}
                />
              </div>
            </PopoverContent>
          </Popover>
        );
      })}
    </div>
  );
}

function ProviderUsageTooltip() {
  const snapshot = useSyncExternalStore(
    subscribeStore,
    getStoreSnapshot,
    getStoreSnapshot,
  );
  const machine = useUsageMachine(snapshot);
  return (
    <div className="flex max-w-80 flex-col gap-1 text-xs">
      <span className="font-medium">
        Provider usage{snapshot.isRefreshing ? " · Refreshing…" : ""}
      </span>
      <span>
        Overview shows the lowest reported remaining allowance, not a combined
        quota.
      </span>
      {snapshot.error ? (
        <span>{snapshot.error} Last available data may be stale.</span>
      ) : null}
      {(machine?.providers ?? []).map((provider) => (
        <div key={provider.id}>
          {provider.usage?.status === "ok" &&
          provider.usage.windows.length > 0 ? (
            provider.usage.windows.map((window) => (
              <div key={window.label}>
                {provider.displayName} · {window.label} ·{" "}
                {Math.max(0, 100 - window.usedPercent).toFixed(0)}% remaining
              </div>
            ))
          ) : (
            <span>
              {provider.displayName} ·{" "}
              {provider.usage?.status === "ok"
                ? "No reported limits"
                : (provider.usage?.status ?? "Unknown")}
            </span>
          )}
        </div>
      ))}
      {!machine ? (
        <span>
          {snapshot.isRefreshing ? "Loading usage…" : "Usage unavailable"}
        </span>
      ) : null}
      <span>Click for details and refresh</span>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "usage", component: UsageSettings });
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "usage",
    label: "Provider usage",
    icon: "Gauge",
    component: ProviderUsageStatus,
    experimental_tooltip: ProviderUsageTooltip,
    experimental_placement: "rail-bottom",
    experimental_triggerIcon: ProviderUsageGauge,
    experimental_railContent: ProviderUsageRail,
  });
  app.contentScripts.register({
    id: "refresh-usage",
    mount({ pluginId, signal }) {
      let timer: number | null = null;
      let hiddenAt = document.visibilityState === "hidden" ? Date.now() : null;
      let blurredAt: number | null = null;
      const scheduleSafetyRefresh = () => {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        if (signal.aborted || document.visibilityState !== "visible") return;
        timer = window.setTimeout(runSafetyRefresh, SAFETY_REFRESH_INTERVAL_MS);
      };
      const reconcile = (maxAgeMs: number, machineIds: string[] | null) => {
        void refreshUsage({
          pluginId,
          force: false,
          machineIds,
          maxAgeMs,
          providerIds: [],
          signal,
        });
      };
      const runSafetyRefresh = () => {
        if (document.visibilityState === "visible") {
          reconcile(SAFETY_REFRESH_INTERVAL_MS, null);
        }
        scheduleSafetyRefresh();
      };
      const onActive = () => {
        const inactiveAt =
          hiddenAt === null
            ? blurredAt
            : blurredAt === null
              ? hiddenAt
              : Math.min(hiddenAt, blurredAt);
        hiddenAt = null;
        blurredAt = null;
        if (
          inactiveAt !== null &&
          Date.now() - inactiveAt >= FOCUS_MAX_AGE_MS
        ) {
          reconcile(FOCUS_MAX_AGE_MS, null);
        }
        scheduleSafetyRefresh();
      };
      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden") {
          hiddenAt ??= Date.now();
          if (timer !== null) window.clearTimeout(timer);
          timer = null;
          return;
        }
        onActive();
      };
      const onBlur = () => {
        blurredAt ??= Date.now();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("blur", onBlur);
      window.addEventListener("focus", onActive);
      if (storeSnapshot.data === null)
        reconcile(SAFETY_REFRESH_INTERVAL_MS, []);
      reconcile(SAFETY_REFRESH_INTERVAL_MS, null);
      scheduleSafetyRefresh();
      return () => {
        if (timer !== null) window.clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("focus", onActive);
      };
    },
  });
});
