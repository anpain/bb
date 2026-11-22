import { useEffect, useState } from "react";
import type { BbDesktopExecutionProgress } from "@bb/desktop-contract";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { useServerChoices } from "@/hooks/useServerChoices";
import { getBbDesktopInfo } from "@/lib/bb-desktop";

function dataSize(bytes: number): string {
  const unit =
    bytes >= 1024 ** 3 ? 3 : bytes >= 1024 ** 2 ? 2 : bytes >= 1024 ? 1 : 0;
  return `${(bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${["B", "KiB", "MiB", "GiB"][unit]}`;
}

export function ExecutionLocationControl() {
  const choices = useServerChoices();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<BbDesktopExecutionProgress>({
    phase: "Preparing project and native session…",
    path: null,
    bytes: 0,
    totalBytes: 0,
  });
  useEffect(() => getBbDesktopInfo()?.onExecutionProgress?.(setProgress), []);
  if (choices === null) return null;
  const desktop = getBbDesktopInfo();
  const local = choices.servers.find((server) => server.kind === "local");
  const remotes = choices.servers.filter((server) => server.kind !== "local");
  const activeRemote = remotes.find((server) => server.active);
  const remote = activeRemote ?? remotes[0];
  const loading = choices.status === "loading" || busy;
  const determinate =
    progress.stage === "copying" ||
    progress.stage === "finalizing" ||
    progress.stage === "complete";
  const percent =
    progress.stage === "complete"
      ? 100
      : determinate
        ? Math.min(
            99,
            Math.floor(
              100 *
                (progress.totalBytes > 0
                  ? progress.bytes / progress.totalBytes
                  : (progress.totalFiles ?? 0) > 0
                    ? (progress.completedFiles ?? 0) / progress.totalFiles!
                    : 0),
            ),
          )
        : undefined;
  const stageLabel =
    progress.stage === "checking"
      ? "Checking files…"
      : progress.stage === "directories"
        ? "Preparing folders…"
        : progress.stage === "finalizing"
          ? "Finalizing files…"
          : progress.stage === "complete"
            ? "Files synchronized"
            : null;
  const switchTo = async (id: string) => {
    if (busy) return;
    setError(null);
    setProgress({
      phase: "Synchronizing project and native session…",
      path: null,
      bytes: 0,
      totalBytes: 0,
    });
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
        <div
          role="status"
          className="absolute right-0 bottom-full mb-1 w-80 max-w-[calc(100vw-2rem)] space-y-1.5 rounded-md border border-border bg-surface p-2 text-xs"
        >
          <div className="flex items-center justify-between gap-2">
            <span>{progress.phase}</span>
            {percent !== undefined ? (
              <span className="shrink-0 tabular-nums">{percent}%</span>
            ) : null}
          </div>
          <progress
            aria-label="Current transfer stage"
            max={100}
            value={percent}
            className="h-1.5 w-full accent-foreground"
          />
          {stageLabel ? (
            <p className="text-subtle-foreground">{stageLabel}</p>
          ) : null}
          {progress.totalFiles !== undefined &&
          progress.stage !== "checking" ? (
            <p className="tabular-nums">
              {progress.completedFiles ?? 0} / {progress.totalFiles} files ·{" "}
              {dataSize(progress.bytes)} / {dataSize(progress.totalBytes)}
            </p>
          ) : null}
          {progress.path ? (
            <p className="break-all text-subtle-foreground">{progress.path}</p>
          ) : null}
        </div>
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
