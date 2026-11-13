import { useState } from "react";
import {
  agentProfilesSchema,
  defaultAgentProfiles,
  type AppSettings,
} from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Icon } from "@bb/shared-ui/icon";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@bb/shared-ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { ProviderIcon } from "@/components/plugin/ProviderIcon";
import {
  SettingsSection,
  SettingsRow,
  SettingsRowList,
  SettingsBadge,
} from "@/components/ui/settings-section";
import {
  useProviderPreviewExecutionOptions,
  useSystemProviders,
} from "@/hooks/queries/system-queries";

type Profile = AppSettings["agentProfiles"][number];

function ProfileDialog({
  initial,
  creating,
  disabled,
  onSave,
  onClose,
}: {
  initial: Profile;
  creating: boolean;
  disabled: boolean;
  onSave(profile: Profile): Promise<void>;
  onClose(): void;
}) {
  const [profile, setProfile] = useState(initial);
  const [aliases, setAliases] = useState(
    initial.aliases.map((alias) => `@${alias}`).join(", "),
  );
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const catalog = useProviderPreviewExecutionOptions({
    providerId: profile.providerId,
  });
  const providers = useSystemProviders();
  const provider = providers.data?.find(
    (item) => item.id === profile.providerId,
  );
  const model = catalog.data?.models.find(
    (item) => item.model === profile.model,
  );
  const models = (catalog.data?.models ?? []).filter((item) =>
    `${item.displayName} ${item.model}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const busy = disabled || saving;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
      modal={false}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{creating ? "Add alias" : "Change alias"}</DialogTitle>
          <DialogDescription>
            Choose the agent and model called by your @mention.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            const nextAliases = [
              ...new Set(
                aliases
                  .split(/[,\s]+/u)
                  .map((value) => value.replace(/^@/u, ""))
                  .filter(Boolean),
              ),
            ];
            const next = {
              ...profile,
              aliases: nextAliases,
              name: creating ? nextAliases[0] || profile.name : profile.name,
            };
            setSaving(true);
            setError(null);
            try {
              await onSave(next);
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Alias could not be saved.",
              );
            } finally {
              setSaving(false);
            }
          }}
        >
          <label className="grid gap-2 text-xs font-medium">
            Aliases
            <Input
              aria-label="Aliases"
              placeholder="@opencode, @опен"
              value={aliases}
              disabled={busy}
              onChange={(event) => setAliases(event.target.value)}
            />
            <span className="font-normal text-muted-foreground">
              Separate alternative names with commas.
            </span>
          </label>
          <div className="grid gap-2">
            <span className="text-xs font-medium">Provider</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="justify-start gap-2"
                  aria-label="Choose provider"
                  disabled={busy}
                >
                  <ProviderIcon
                    providerKind="agent"
                    provider={
                      provider ?? {
                        id: profile.providerId,
                        logoUrl: null,
                        icon: null,
                      }
                    }
                    className="size-4"
                  />
                  {provider?.displayName ?? profile.providerId}
                  <Icon name="ChevronDown" className="ml-auto size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent mobileTitle="Choose provider">
                {(providers.data ?? []).map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    onSelect={() => {
                      setProfile({
                        ...profile,
                        providerId: item.id,
                        model: null,
                        reasoningLevel: null,
                        serviceTier: null,
                      });
                      setSearch("");
                    }}
                  >
                    <ProviderIcon
                      providerKind="agent"
                      provider={item}
                      className="size-4"
                    />
                    {item.displayName}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Model</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Refresh model catalog"
                disabled={busy || catalog.isFetching}
                onClick={() => void catalog.refetch()}
              >
                <Icon name="RefreshCw" className="size-3.5" />
              </Button>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="justify-between gap-2"
                  aria-label="Choose default profile model"
                  disabled={busy || catalog.isPending}
                >
                  <span className="truncate">
                    {model?.displayName ?? profile.model ?? "Provider default"}
                  </span>
                  <Icon name="ChevronDown" className="size-4 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                mobileTitle="Choose model"
                className="min-w-72"
              >
                <div className="sticky top-0 z-10 bg-popover p-1 pb-2">
                  <Input
                    aria-label="Search provider models"
                    placeholder="Search models by name or ID"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape" && event.key !== "Tab")
                        event.stopPropagation();
                    }}
                  />
                </div>
                <DropdownMenuItem
                  onSelect={() =>
                    setProfile({
                      ...profile,
                      model: null,
                      reasoningLevel: null,
                      serviceTier: null,
                    })
                  }
                >
                  Provider default
                </DropdownMenuItem>
                {models.map((item) => (
                  <DropdownMenuItem
                    key={item.model}
                    onSelect={() =>
                      setProfile({
                        ...profile,
                        model: item.model,
                        reasoningLevel: null,
                        serviceTier: null,
                      })
                    }
                  >
                    <span className="flex min-w-0 flex-col">
                      <span>
                        {item.displayName}
                        {item.model === profile.model ? " ✓" : ""}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {item.model}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
                {models.length === 0 ? (
                  <DropdownMenuItem disabled>
                    {catalog.isFetching
                      ? "Loading models…"
                      : "No matching models"}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="grid gap-2">
            <span className="text-xs font-medium">Reasoning</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="justify-between gap-2"
                  aria-label="Choose reasoning level"
                  disabled={
                    busy ||
                    (!profile.reasoningLevel &&
                      !model?.supportedReasoningEfforts.length)
                  }
                >
                  {profile.reasoningLevel ?? "Provider default"}
                  <Icon name="ChevronDown" className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent mobileTitle="Reasoning">
                <DropdownMenuItem
                  onSelect={() =>
                    setProfile({ ...profile, reasoningLevel: null })
                  }
                >
                  Provider default
                </DropdownMenuItem>
                {(model?.supportedReasoningEfforts ?? []).map((effort) => (
                  <DropdownMenuItem
                    key={effort.reasoningEffort}
                    onSelect={() =>
                      setProfile({
                        ...profile,
                        reasoningLevel: effort.reasoningEffort,
                      })
                    }
                  >
                    <span className="flex flex-col">
                      <span className="capitalize">
                        {effort.reasoningEffort}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {effort.description}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {!model?.supportedReasoningEfforts.length ? (
              <p className="text-xs text-muted-foreground">
                {profile.model
                  ? "This model does not report adjustable reasoning levels."
                  : "Choose a model to see its reasoning levels."}
              </p>
            ) : null}
          </div>
          {catalog.isError || catalog.data?.modelLoadError ? (
            <p role="status" className="text-xs text-muted-foreground">
              Model catalog unavailable. Check provider authentication or
              refresh. Your existing model is preserved.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {saving ? "Saving…" : creating ? "Add alias" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProfileRow({
  profile,
  disabled,
  onEdit,
  onDelete,
}: {
  profile: Profile;
  disabled: boolean;
  onEdit(): void;
  onDelete(): void;
}) {
  const catalog = useProviderPreviewExecutionOptions({
    providerId: profile.providerId,
  });
  const providers = useSystemProviders();
  const provider = providers.data?.find(
    (item) => item.id === profile.providerId,
  );
  const model = catalog.data?.models.find(
    (item) => item.model === profile.model,
  );
  const label = profile.aliases.map((alias) => `@${alias}`).join(" · ");
  return (
    <SettingsRow>
      <ProviderIcon
        providerKind="agent"
        provider={
          provider ?? { id: profile.providerId, logoUrl: null, icon: null }
        }
        className="size-5 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="whitespace-nowrap text-sm font-medium">
            {provider?.displayName ?? profile.providerId}
          </span>
          <span
            className="relative -top-1.5 inline-flex flex-wrap gap-1"
            aria-label="Chat aliases"
          >
            {profile.aliases.map((alias) => (
              <SettingsBadge key={alias}>@{alias}</SettingsBadge>
            ))}
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {model?.displayName ?? profile.model ?? "Provider default"}
          {profile.reasoningLevel ? ` · ${profile.reasoningLevel}` : ""}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground"
            aria-label={`Actions for ${profile.name}`}
            disabled={disabled}
          >
            <Icon name="MoreHorizontal" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" mobileTitle={label || profile.name}>
          <DropdownMenuItem onSelect={onEdit}>Change</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
  );
}

export function AgentProfilesSettings({
  settings,
  disabled,
  onChange,
}: {
  settings: AppSettings;
  disabled: boolean;
  onChange(patch: Partial<AppSettings>): Promise<unknown> | void;
}) {
  const [profiles, setProfiles] = useState(settings.agentProfiles);
  const [editor, setEditor] = useState<{
    profile: Profile;
    creating: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const persist = async (next: Profile[]) => {
    const parsed = agentProfilesSchema.safeParse(next);
    if (!parsed.success)
      throw new Error(
        parsed.error.issues.map((issue) => issue.message).join("; "),
      );
    await onChange({ agentProfiles: parsed.data });
    setProfiles(parsed.data);
  };
  return (
    <SettingsSection
      title="Agent profiles"
      description="Choose which agent and model your @aliases call. Only message text is forwarded, not attachments or chat history."
      action={
        <Button
          variant="outline"
          disabled={disabled || saving}
          onClick={() => {
            setError(null);
            setEditor({
              creating: true,
              profile: {
                ...defaultAgentProfiles[0],
                id: crypto.randomUUID(),
                name: "New alias",
                aliases: [],
                model: null,
                reasoningLevel: null,
                serviceTier: null,
              },
            });
          }}
        >
          <Icon name="Plus" className="size-4" />
          Add alias
        </Button>
      }
    >
      <SettingsRowList>
        {profiles.map((profile) => (
          <ProfileRow
            key={profile.id}
            profile={profile}
            disabled={disabled || saving}
            onEdit={() => {
              setError(null);
              setEditor({ profile, creating: false });
            }}
            onDelete={() => {
              setSaving(true);
              setError(null);
              void persist(profiles.filter((item) => item.id !== profile.id))
                .catch(() => setError("Alias could not be deleted."))
                .finally(() => setSaving(false));
            }}
          />
        ))}
      </SettingsRowList>
      {profiles.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">
          No aliases yet. Add an alias to choose an agent and model.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {editor ? (
        <ProfileDialog
          key={editor.profile.id}
          initial={editor.profile}
          creating={editor.creating}
          disabled={disabled}
          onClose={() => setEditor(null)}
          onSave={async (profile) => {
            await persist(
              editor.creating
                ? [...profiles, profile]
                : profiles.map((item) =>
                    item.id === profile.id ? profile : item,
                  ),
            );
            setEditor(null);
          }}
        />
      ) : null}
    </SettingsSection>
  );
}
