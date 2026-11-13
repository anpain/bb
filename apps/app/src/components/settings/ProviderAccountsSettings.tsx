import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import {
  AgentSignInContainer,
  useAgentSignInTerminals,
} from "@/components/onboarding/AgentSignInContainer";
import { AgentSignInInstruction } from "@/components/onboarding/OnboardingViews";
import {
  useAgentSignIns,
  type RefetchProviderStates,
} from "@/components/onboarding/useAgentSignIns";
import {
  SettingsBadge,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import { invalidateSystemExecutionOptions } from "@/hooks/cache-owners/system-cache-effects";
import { usePrimaryHost } from "@/hooks/queries/host-queries";
import { useSystemProviderStates } from "@/hooks/queries/system-queries";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const isLocalHost = () => false;

export function ProviderAccountsSettings({ disabled }: { disabled: boolean }) {
  const host = usePrimaryHost();
  return (
    <SettingsSection
      title="Provider accounts"
      description={
        host === null
          ? undefined
          : `Sign in on ${host.name}, where the agents run.`
      }
    >
      {host?.status === "connected" ? (
        <ProviderAccounts key={host.id} hostId={host.id} disabled={disabled} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Connect the server machine to manage provider accounts.
        </p>
      )}
    </SettingsSection>
  );
}

function ProviderAccounts({
  hostId,
  disabled,
}: {
  hostId: string;
  disabled: boolean;
}) {
  const queryClient = useQueryClient();
  const { data, dataUpdatedAt, errorUpdatedAt, isError, isPending, refetch } =
    useSystemProviderStates({ hostId, poll: false });
  const terminals = useAgentSignInTerminals();
  const refetchStates = useCallback<RefetchProviderStates>(
    (options) => {
      void refetch(options);
    },
    [refetch],
  );
  const onSignedIn = useCallback(() => {
    void invalidateSystemExecutionOptions({ queryClient, hostId });
  }, [queryClient, hostId]);
  const signIns = useAgentSignIns({
    redesign: true,
    hostId,
    states: data?.providers,
    statesSettledAt: Math.max(dataUpdatedAt, errorUpdatedAt),
    isLocalHost,
    terminals,
    refetchStates,
    onSignedIn,
  });

  if (data === undefined) {
    if (isPending)
      return (
        <p className="text-sm text-muted-foreground">
          Checking provider accounts…
        </p>
      );
    if (isError)
      return (
        <SettingsRow>
          <span className="flex-1">Could not check provider accounts.</span>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Retry
          </Button>
        </SettingsRow>
      );
  }

  const providers = data?.providers ?? [];
  if (providers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No providers available on this machine.
      </p>
    );
  }

  return (
    <SettingsRowList>
      {providers.map((provider) => {
        const id = provider.providerId;
        const session = signIns.signIns.get(id);
        const view = signIns.views.get(id);
        const starting = signIns.startingProviderIds.has(id);
        const failed = signIns.failedProviderIds.has(id);
        const canSignIn =
          provider.loginCommand !== null &&
          (provider.status === "unauthenticated" ||
            provider.status === "expired");
        const status = {
          ready: "Ready",
          unauthenticated: "Sign-in required",
          expired: "Sign-in expired",
          not_installed: "Not installed",
          unsupported_version: "Update required",
          unknown: "Status unavailable",
        }[provider.status];
        return (
          <div className="py-2.5 first:pt-0 last:pb-0" key={id}>
            <SettingsRow className="flex-wrap py-0">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{provider.displayName}</div>
                {provider.accountEmail && (
                  <div className="truncate text-xs text-muted-foreground">
                    {provider.accountEmail}
                  </div>
                )}
              </div>
              <SettingsBadge>
                {session || starting ? "Signing in…" : status}
              </SettingsBadge>
              {session || starting ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Cancel ${provider.displayName} sign-in`}
                  onClick={() => signIns.end(id)}
                >
                  Cancel
                </Button>
              ) : canSignIn ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  aria-label={`Sign in to ${provider.displayName}`}
                  onClick={() => void signIns.start(id, "remote")}
                >
                  {failed ? "Try again" : "Sign in"}
                </Button>
              ) : null}
            </SettingsRow>
            {failed && !session && (
              <p className="mt-2 text-xs text-destructive" role="status">
                Sign-in did not complete. Try again.
              </p>
            )}
            {session && (
              <div className="mt-2">
                {view?.started && (
                  <p className="text-sm text-muted-foreground">
                    <AgentSignInInstruction
                      agentName={provider.displayName}
                      view={view}
                      onOpenUrl={openUrlInExternalBrowser}
                    />
                  </p>
                )}
                <AgentSignInContainer
                  key={session.session.id}
                  redesign
                  parsed={provider.internal_DO_NOT_USE_guidedSignIn}
                  connectFlow={null}
                  agentName={provider.displayName}
                  session={session.session}
                  alternate={null}
                  onUseAlternate={() => {}}
                  onExit={(exitCode) => signIns.handleExit(id, exitCode)}
                  onFail={() => signIns.fail(id)}
                  onViewChange={(next) => signIns.setView(id, next)}
                />
              </div>
            )}
          </div>
        );
      })}
    </SettingsRowList>
  );
}
