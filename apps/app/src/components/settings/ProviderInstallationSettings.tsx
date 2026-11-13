import { Button } from "@bb/shared-ui/button";
import {
  SettingsBadge,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import { useHostProviderCliStatus } from "@/hooks/queries/system-queries";
import { usePrimaryHost } from "@/hooks/queries/host-queries";
import {
  useProviderCliInstallRunner,
  type ProviderCliActionableIssue,
} from "@/components/provider-cli/provider-cli-install";
import {
  openProviderCliInstallLog,
  providerCliJobKey,
} from "@/components/provider-cli/provider-cli-install-store";
import type {
  ProviderCliInstallAction,
  ProviderCliStatus,
} from "@bb/host-daemon-contract";

export function ProviderInstallationSettings({
  disabled,
}: {
  disabled: boolean;
}) {
  const host = usePrimaryHost();
  const statuses = useHostProviderCliStatus({
    hostId: host?.id ?? null,
    enabled: host?.status === "connected",
  });
  const { startInstall, runningJobKey, queuedJobKeys, failuresByJobKey } =
    useProviderCliInstallRunner();

  const run = (
    provider: string,
    status: ProviderCliStatus,
    action: ProviderCliInstallAction,
  ) => {
    if (host === null) return;
    const issue: ProviderCliActionableIssue = {
      provider,
      status,
      action,
      title: `${action.label} ${status.displayName}`,
      description: action.command,
      fingerprint: `${provider}:${action.kind}:${status.currentVersion ?? "missing"}`,
    };
    startInstall({ hostId: host.id, issue });
  };

  return (
    <SettingsSection
      title="Provider installation"
      description={
        host === null
          ? undefined
          : `Install or remove agent CLI tools on ${host.name}.`
      }
    >
      {host?.status !== "connected" ? (
        <p className="text-sm text-muted-foreground">
          Connect the server machine to manage its agent CLI tools.
        </p>
      ) : statuses.isPending ? (
        <p className="text-sm text-muted-foreground">
          Checking installed providers…
        </p>
      ) : statuses.isError ? (
        <SettingsRow>
          <span className="flex-1">Could not check installed providers.</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void statuses.refetch()}
          >
            Retry
          </Button>
        </SettingsRow>
      ) : (
        <SettingsRowList>
          {Object.entries(statuses.data ?? {}).map(([provider, status]) => {
            const jobKey = providerCliJobKey(host.id, provider);
            const running = runningJobKey === jobKey;
            const queued = queuedJobKeys.has(jobKey);
            const busy = running || queued;
            const failure = failuresByJobKey.get(jobKey);
            return (
              <SettingsRow key={provider} className="flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{status.displayName}</div>
                  {status.currentVersion && (
                    <div className="text-xs text-muted-foreground">
                      {status.currentVersion}
                    </div>
                  )}
                </div>
                <SettingsBadge>
                  {running
                    ? "Working…"
                    : queued
                      ? "Queued"
                      : status.installed
                        ? "Installed"
                        : "Not installed"}
                </SettingsBadge>
                {failure && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Show ${status.displayName} operation log`}
                    onClick={() =>
                      openProviderCliInstallLog(failure.logDialogState)
                    }
                  >
                    View error
                  </Button>
                )}
                {status.installAction && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled || busy}
                    aria-label={`${status.installAction.label} ${status.displayName} CLI`}
                    onClick={() => {
                      if (status.installAction)
                        run(provider, status, status.installAction);
                    }}
                  >
                    {status.installAction.label}
                  </Button>
                )}
                {status.installed && status.removeAction && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled || busy}
                    aria-label={`Remove ${status.displayName} CLI`}
                    onClick={() => {
                      if (status.removeAction)
                        run(provider, status, status.removeAction);
                    }}
                  >
                    Remove
                  </Button>
                )}
              </SettingsRow>
            );
          })}
        </SettingsRowList>
      )}
    </SettingsSection>
  );
}
