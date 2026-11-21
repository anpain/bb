import { useEffect, useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { useServerChoices } from "@/hooks/useServerChoices";
import { getBbDesktopInfo } from "@/lib/bb-desktop";

export function ExecutionLocationControl() {
  const choices = useServerChoices();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(
    "Preparing project and native session…",
  );
  useEffect(
    () =>
      getBbDesktopInfo()?.onExecutionProgress?.((value) => {
        setProgress(
          `${value.phase}${value.path === null ? "…" : ` · ${value.path}`}${value.totalBytes > 1024 * 1024 ? ` · ${Math.round(value.bytes / 1024 / 1024)}/${Math.round(value.totalBytes / 1024 / 1024)} MiB` : ""}`,
        );
      }),
    [],
  );
  if (choices === null) return null;
  const desktop = getBbDesktopInfo();
  const local = choices.servers.find((server) => server.kind === "local");
  const remotes = choices.servers.filter((server) => server.kind !== "local");
  const activeRemote = remotes.find((server) => server.active);
  const remote = activeRemote ?? remotes[0];
  const loading = choices.status === "loading" || busy;
  const switchTo = async (id: string) => {
    if (busy) return;
    setError(null);
    setProgress("Synchronizing project and native session…");
    if (!desktop?.switchExecution) {
      choices.switchTo(id);
      return;
    }
    setBusy(true);
    try {
      const result = await desktop.switchExecution(id);
      if (!result.ok) setError(result.message);
    } catch {
      setError(
        "Could not change execution location. Both copies were preserved.",
      );
    } finally {
      setBusy(false);
    }
  };
  const selectRemote = () => {
    if (remote) void switchTo(remote.id);
    else desktop?.addServer?.();
  };
  const remoteButton = (
    <Button
      type="button"
      variant={activeRemote ? "secondary" : "ghost"}
      size="sm"
      className="h-7 gap-1.5 rounded-md px-2 text-xs"
      aria-label={
        activeRemote ? `Working on VPS: ${activeRemote.name}` : "Work on VPS"
      }
      aria-pressed={Boolean(activeRemote)}
      disabled={loading || (remotes.length === 0 && !desktop?.addServer)}
      onClick={remotes.length > 1 ? undefined : selectRemote}
    >
      <Icon name="ComputerCloud" className="size-3.5" />
      VPS
      {activeRemote ? (
        <span className="hidden max-w-28 truncate md:inline">
          · {activeRemote.name}
        </span>
      ) : null}
      {remotes.length > 1 ? (
        <Icon name="ChevronDown" className="size-3" />
      ) : null}
    </Button>
  );
  return (
    <div className="relative ml-auto shrink-0">
      <div
        role="group"
        aria-label="Execution location"
        className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={local?.active ? "secondary" : "ghost"}
              size="sm"
              className="h-7 gap-1.5 rounded-md px-2 text-xs"
              aria-label="Work locally"
              aria-pressed={Boolean(local?.active)}
              disabled={loading || local === undefined}
              onClick={() => {
                if (local && !local.active) void switchTo(local.id);
              }}
            >
              <Icon name="Laptop" className="size-3.5" />
              Local
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Open this computer's bb workspace and accounts
          </TooltipContent>
        </Tooltip>
        {remotes.length > 1 ? (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>{remoteButton}</PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-72 p-1"
              mobileTitle="Execution server"
            >
              {remotes.map((server) => (
                <Button
                  key={server.id}
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start gap-2 px-2 py-2 text-sm"
                  aria-pressed={server.active}
                  disabled={loading}
                  onClick={() => {
                    setOpen(false);
                    if (!server.active) void switchTo(server.id);
                  }}
                >
                  <Icon name="ComputerCloud" className="size-4 shrink-0" />
                  <span className="truncate">{server.name}</span>
                  {server.active ? (
                    <Icon name="Check" className="ml-auto size-4 shrink-0" />
                  ) : null}
                </Button>
              ))}
            </PopoverContent>
          </Popover>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>{remoteButton}</TooltipTrigger>
            <TooltipContent>
              {remote
                ? `Open ${remote.name}'s bb workspace and accounts`
                : "Add a VPS connection"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {busy ? (
        <span
          role="status"
          className="absolute right-0 bottom-full mb-1 w-72 rounded-md border border-border bg-surface p-2 text-xs"
        >
          {progress}
        </span>
      ) : null}
      {error ? (
        <span
          role="alert"
          className="absolute right-0 bottom-full mb-1 w-80 rounded-md border border-border bg-surface p-2 text-xs text-destructive"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
