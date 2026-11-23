import { getAppSettings, getEnvironment, getHost } from "@bb/db";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { requirePublicThread } from "../lib/entity-lookup.js";
import { callHostOnlineRpcForWork } from "../hosts/online-rpc.js";
import { joinHostPathSegments } from "../lib/host-path.js";

const start = "<!-- bb:execution-context:start -->";
const end = "<!-- bb:execution-context:end -->";
const guidance = [
  "## bb execution and connected computers",
  "The execution machine and project directory are supplied by bb in current runtime instructions. Shell commands and relative paths run on that execution machine, which may be a VPS rather than the user's PC. Do not infer location from the chat history or a Windows path in an old message.",
  "The Browser Automation plugin's bb_computer tool can operate a chosen Windows window on a separately enrolled PC while the model runs on a VPS. Use request_access with a reason to ask locally; only the user can choose and approve a window. Wait for an active grant before input. Take and inspect a fresh screenshot before every click, typing, key or scroll action. Normalized coordinates refer to that window. Commands typed into an approved terminal execute on the PC; this is not an unrestricted remote shell. Stop control when finished or asked.",
  "Desktop synchronizes project folders only after a Local/VPS handoff established a linked mirror and while Desktop and both endpoints are connected. Changes trigger a pass after about 250 ms, with a one-minute safety check. Copies take time; simultaneous edits can stop synchronization. A saved server or enrolled PC alone does not establish a mirror. Do not promise that all chats, account credentials or every PC folder are synchronized. Verify the intended file on the other endpoint before relying on it.",
  "Keep existing project instructions. This bb block is managed separately; actual tool availability and current runtime data take precedence over stale copies of it.",
].join("\n\n");

export function mergeExecutionInstructions(existing: string): string {
  const block = `${start}\n${guidance}\n${end}`;
  const first = existing.indexOf(start);
  const last = existing.indexOf(end);
  if (first < 0 && last < 0)
    return `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${existing ? "\n" : ""}${block}\n`;
  if (
    first < 0 ||
    last < first ||
    existing.indexOf(start, first + start.length) >= 0 ||
    existing.indexOf(end, last + end.length) >= 0
  )
    throw new Error(
      "The bb instruction block has malformed or duplicate markers. Existing content was preserved.",
    );
  return `${existing.slice(0, first)}${block}${existing.slice(last + end.length)}`;
}

export function currentExecutionInstructions(
  deps: LoggedWorkSessionDeps,
  hostId: string,
  path: string,
) {
  const host = getHost(deps.db, hostId);
  return [
    "Current bb execution location (not a persistent project setting):",
    JSON.stringify({
      hostId,
      hostName: host?.name ?? hostId,
      workspacePath: path,
    }),
    guidance,
  ].join("\n\n");
}

export async function generateThreadExecutionInstructions(
  deps: LoggedWorkSessionDeps,
  threadId: string,
) {
  const thread = requirePublicThread(deps.db, threadId);
  const environment = thread.environmentId
    ? getEnvironment(deps.db, thread.environmentId)
    : null;
  if (!environment?.path)
    throw new ApiError(
      409,
      "environment_not_ready",
      "Select a project folder before generating instructions",
    );
  const files: string[] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const path = joinHostPathSegments(environment.path, name);
    let existing = "";
    let expectedSha256: string | null = null;
    try {
      const read = await callHostOnlineRpcForWork(deps, {
        hostId: environment.hostId,
        timeoutMs: 15_000,
        command: {
          type: "host.read_file",
          rootPath: environment.path,
          path,
          followRootSymlink: false,
        },
      });
      if (
        !("content" in read) ||
        read.contentEncoding !== "utf8" ||
        read.sizeBytes > 1024 * 1024
      )
        throw new Error(
          `Cannot safely update ${name}: expected a UTF-8 file under 1 MiB`,
        );
      existing = read.content;
      expectedSha256 = read.sha256;
    } catch (error) {
      if (!(error instanceof ApiError && error.body.code === "ENOENT"))
        throw error;
    }
    const content = mergeExecutionInstructions(existing);
    if (content !== existing) {
      const result = await callHostOnlineRpcForWork(deps, {
        hostId: environment.hostId,
        timeoutMs: 15_000,
        command: {
          type: "host.write_file",
          rootPath: environment.path,
          path,
          content,
          contentEncoding: "utf8",
          createParents: false,
          expectedSha256,
        },
      });
      if (result.outcome !== "written")
        throw new ApiError(
          409,
          "conflict",
          `${name} changed while bb was generating instructions. Both versions were preserved; retry.`,
        );
    }
    files.push(path);
  }
  return { files };
}

export async function maybeGenerateExecutionInstructions(
  deps: LoggedWorkSessionDeps,
  threadId: string,
) {
  if (!getAppSettings(deps.db).generateExecutionInstructions) return;
  try {
    await generateThreadExecutionInstructions(deps, threadId);
  } catch (error) {
    deps.logger.warn(
      { err: error, threadId },
      "Could not generate execution instructions; existing files were preserved",
    );
  }
}
