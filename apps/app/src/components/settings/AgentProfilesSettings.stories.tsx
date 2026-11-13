import { useState } from "react";
import { defaultAppSettings } from "@bb/domain";
import { ModelPickerStoryQueryProvider } from "../../../.ladle/model-picker-query-provider";
import { AgentProfilesSettings } from "./AgentProfilesSettings";

export default { title: "settings/Agent profiles" };

export function CompactProfiles() {
  const [settings, setSettings] = useState({
    ...defaultAppSettings,
    agentProfiles: defaultAppSettings.agentProfiles.filter(
      (profile) =>
        profile.providerId === "codex" || profile.providerId === "claude-code",
    ),
  });
  return (
    <ModelPickerStoryQueryProvider>
      <div className="mx-auto w-full max-w-2xl p-6">
        <AgentProfilesSettings
          settings={settings}
          disabled={false}
          onChange={(patch) =>
            setSettings((current) => ({ ...current, ...patch }))
          }
        />
      </div>
    </ModelPickerStoryQueryProvider>
  );
}
