import { Button } from "@bb/shared-ui/button";
import {
  SettingsBadge,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import { useServerChoices } from "@/hooks/useServerChoices";
import { getBbDesktopInfo } from "@/lib/bb-desktop";

export function ExecutionModeSettings() {
  const choices = useServerChoices();
  const desktop = getBbDesktopInfo();
  return (
    <SettingsSection
      title="Execution mode"
      description="Choose where bb runs providers and works with files. Each server has its own projects, history, settings and provider accounts. Cloud models still require an internet connection in local mode."
      action={
        desktop?.addServer ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => desktop.addServer?.()}
          >
            Add server
          </Button>
        ) : undefined
      }
    >
      {choices === null ? (
        <p className="text-sm text-subtle-foreground">
          This browser is connected to {window.location.origin}. Open bb Desktop
          to switch between local execution and a remote server.
        </p>
      ) : choices.status === "loading" ? (
        <p className="text-sm text-subtle-foreground">Loading connections…</p>
      ) : (
        <SettingsRowList>
          {choices.servers.map((server) => (
            <SettingsRow key={server.id}>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {server.kind === "local"
                      ? "Local on this computer"
                      : server.name}
                  </span>
                  {server.active ? <SettingsBadge>active</SettingsBadge> : null}
                </div>
                <p className="break-all text-xs text-subtle-foreground">
                  {server.kind === "local"
                    ? "Providers and files on this computer"
                    : server.origin}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={server.active}
                onClick={() => choices.switchTo(server.id)}
              >
                {server.active
                  ? "Connected"
                  : server.kind === "local"
                    ? "Use local"
                    : "Use server"}
              </Button>
            </SettingsRow>
          ))}
        </SettingsRowList>
      )}
    </SettingsSection>
  );
}
