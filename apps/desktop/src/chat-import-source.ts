import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  chatImportMaxBytes,
  chatImportRequestSchema,
  type ChatImportRequest,
} from "@bb/server-contract";

export interface SavedChat {
  providerId: ChatImportRequest["providerId"];
  sourceId: string;
  title: string;
  cwd: string | null;
  updatedAt: number;
  path: string;
  root: string;
}

type Message = ChatImportRequest["messages"][number];
const sessionId = z.string().min(1).max(256);
const maxTranscriptBytes = 128 * 1024 * 1024;
const record = z.record(z.string(), z.unknown());
const messageRole = z.enum(["user", "assistant"]);
const textBlock = z.object({
  type: z.enum(["text", "Text", "input_text", "output_text"]),
  text: z.string(),
});
const userMeta = z.object({
  type: z.literal("session_meta"),
  payload: z.object({
    id: sessionId,
    cwd: z.string().optional(),
    session_id: sessionId.optional(),
  }),
});
const kimiMeta = z.object({
  id: sessionId,
  title: z.string().nullish(),
  cwd: z.string().nullish(),
});
const maxFilesPerProvider = 500;

function parsedLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((block: unknown) => {
      const parsed = textBlock.safeParse(block);
      return parsed.success ? [parsed.data.text] : [];
    })
    .join("\n");
}

function message(role: Message["role"], text: string): Message[] {
  return text.trim() ? [{ role, text }] : [];
}

function codexMessages(row: Record<string, unknown>): {
  preferred: Message[];
  fallback: Message[];
} {
  const payload = record.safeParse(row.payload);
  if (!payload.success) return { preferred: [], fallback: [] };
  const data = payload.data;
  if (row.type === "event_msg") {
    if (data.type === "item_completed") {
      const parsed = record.safeParse(data.item);
      if (parsed.success) {
        const item = parsed.data;
        if (item.type === "UserMessage")
          return {
            preferred: message("user", textContent(item.content)),
            fallback: [],
          };
        if (item.type === "AgentMessage")
          return {
            preferred: message("assistant", textContent(item.content)),
            fallback: [],
          };
      }
    }
    if (data.type === "user_message" && typeof data.message === "string") {
      return { preferred: [], fallback: message("user", data.message) };
    }
    if (data.type === "agent_message" && typeof data.message === "string") {
      return { preferred: [], fallback: message("assistant", data.message) };
    }
  }
  return { preferred: [], fallback: [] };
}

function kimiMessages(row: Record<string, unknown>): Message[] {
  if (row.type !== "agent.message.appended") return [];
  const parsed = z
    .object({
      message: z.object({
        message: z.object({ role: messageRole, content: z.unknown() }),
      }),
    })
    .safeParse(row);
  return parsed.success
    ? message(
        parsed.data.message.message.role,
        textContent(parsed.data.message.message.content),
      )
    : [];
}

async function readLines(
  file: string,
  visit: (row: unknown) => boolean | void,
): Promise<void> {
  const stream = createReadStream(file, {
    encoding: "utf8",
    end: maxTranscriptBytes - 1,
  });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (visit(parsedLine(line)) === false) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

function displayTitle(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 200);
}

async function safeFile(root: string, file: string): Promise<string> {
  const resolved = await realpath(file);
  const relative = path.relative(root, resolved);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Transcript is outside the session directory.");
  }
  const info = await stat(resolved);
  if (!info.isFile() || info.size > maxTranscriptBytes) {
    throw new Error("Transcript is missing or larger than 128 MiB.");
  }
  return resolved;
}

async function* filesAt(
  root: string,
  depth: number,
  match: (name: string) => boolean,
): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => b.name.localeCompare(a.name));
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isFile() && match(entry.name)) yield file;
    if (depth > 0 && entry.isDirectory())
      yield* filesAt(file, depth - 1, match);
  }
}

async function codexSessions(root: string): Promise<SavedChat[]> {
  const chats: SavedChat[] = [];
  for await (const file of filesAt(
    root,
    3,
    (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
  )) {
    if (chats.length === maxFilesPerProvider) break;
    const chat = await (async (): Promise<SavedChat | null> => {
      const sourcePath = await safeFile(root, file);
      let metadata: z.infer<typeof userMeta>["payload"] | undefined;
      let title = "";
      let rows = 0;
      await readLines(sourcePath, (row) => {
        rows += 1;
        const meta = userMeta.safeParse(row);
        if (meta.success) metadata = meta.data.payload;
        const entry = record.safeParse(row);
        if (entry.success) {
          const { preferred, fallback } = codexMessages(entry.data);
          const user = [...preferred, ...fallback].find(
            (item) => item.role === "user",
          );
          if (user) title = displayTitle(user.text);
        }
        return rows < 80 && !(metadata && title);
      });
      if (!metadata) return null;
      return {
        providerId: "codex",
        sourceId: metadata.id,
        title: title || "Codex chat",
        cwd: metadata.cwd ?? null,
        updatedAt: (await stat(sourcePath)).mtimeMs,
        path: sourcePath,
        root,
      };
    })().catch(() => null);
    if (chat) chats.push(chat);
  }
  return chats;
}

async function kimiSessions(root: string): Promise<SavedChat[]> {
  const chats: SavedChat[] = [];
  for await (const file of filesAt(root, 2, (name) => name === "state.json")) {
    if (chats.length === maxFilesPerProvider) break;
    const chat = await (async (): Promise<SavedChat | null> => {
      const metaPath = await safeFile(root, file);
      const info = await stat(metaPath);
      if (info.size > 1024 * 1024) return null;
      const meta = kimiMeta.safeParse(
        parsedLine(await readFile(metaPath, "utf8")),
      );
      if (!meta.success) return null;
      const sourcePath = await safeFile(
        root,
        path.join(path.dirname(file), "agents", "main", "wire.jsonl"),
      );
      return {
        providerId: "acp-kimi",
        sourceId: meta.data.id,
        title: displayTitle(meta.data.title ?? "") || "Kimi Code chat",
        cwd: meta.data.cwd ?? null,
        updatedAt: (await stat(sourcePath)).mtimeMs,
        path: sourcePath,
        root,
      };
    })().catch(() => null);
    if (chat) chats.push(chat);
  }
  return chats;
}

export async function listSavedChats(
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<SavedChat[]> {
  const codex = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const kimi = env.KIMI_CODE_HOME?.trim() || path.join(home, ".kimi-code");
  const scan = async (
    root: string,
    list: (root: string) => Promise<SavedChat[]>,
  ) => {
    const info = await lstat(root).catch(() => null);
    return info?.isDirectory() ? list(await realpath(root)) : [];
  };
  const lists = await Promise.all([
    scan(path.join(codex, "sessions"), codexSessions),
    scan(path.join(codex, "archived_sessions"), codexSessions),
    scan(path.join(kimi, "sessions"), kimiSessions),
  ]);
  const seen = new Set<string>();
  return lists
    .flat()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((chat) => {
      const key = JSON.stringify([chat.providerId, chat.sourceId]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export async function readSavedChat(
  chat: SavedChat,
): Promise<ChatImportRequest> {
  const file = await safeFile(chat.root, chat.path);
  const preferred: Message[] = [];
  const fallback: Message[] = [];
  let size = 0;
  await readLines(file, (row) => {
    const entry = record.safeParse(row);
    if (!entry.success) return;
    const messages =
      chat.providerId === "codex"
        ? codexMessages(entry.data)
        : { preferred: kimiMessages(entry.data), fallback: [] };
    for (const item of [...messages.preferred, ...messages.fallback])
      size += Buffer.byteLength(item.text);
    if (
      size > chatImportMaxBytes * 2 ||
      preferred.length + fallback.length > 20_000
    ) {
      throw new Error("Chat history exceeds the import limit.");
    }
    preferred.push(...messages.preferred);
    fallback.push(...messages.fallback);
  });
  const parsed = chatImportRequestSchema.safeParse({
    providerId: chat.providerId,
    sourceId: chat.sourceId,
    title: chat.title,
    messages:
      preferred.some((item) => item.role === "user") || fallback.length === 0
        ? preferred
        : fallback,
  });
  if (
    !parsed.success ||
    Buffer.byteLength(JSON.stringify(parsed.data)) > chatImportMaxBytes
  ) {
    throw new Error(
      "Chat has no supported text history or exceeds the import limit.",
    );
  }
  return parsed.data;
}
