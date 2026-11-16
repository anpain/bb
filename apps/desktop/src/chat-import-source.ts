import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
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
  archived: boolean;
  path: string;
  paths?: string[];
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
    source: z.unknown().optional(),
  }),
});
const kimiMeta = z.object({
  id: sessionId,
  title: z.string().nullish(),
  cwd: z.string().nullish(),
});
const maxFilesPerProvider = 500;
const codexIndexEntry = z.object({ id: sessionId, thread_name: z.string() });

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
  const images =
    role === "user"
      ? Array.from(
          text.matchAll(
            /(?:<image\b[^>]*\bpath="([^"]+)"|^## [^\r\n]+\.(?:png|jpe?g|gif|webp):\s*([^\r\n]+))/gimu,
          ),
          (match) => match[1] ?? match[2] ?? "",
        ).filter(Boolean)
      : [];
  return text.trim()
    ? [
        {
          role,
          text,
          ...(images.length ? { images: [...new Set(images)] } : {}),
        },
      ]
    : [];
}

function contentImages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block: unknown) => {
    const image = z
      .object({
        type: z.enum(["image_url", "input_image", "image"]),
        image_url: z
          .union([z.string(), z.object({ url: z.string() })])
          .optional(),
        url: z.string().optional(),
      })
      .safeParse(block);
    if (!image.success) return [];
    const reference =
      typeof image.data.image_url === "string"
        ? image.data.image_url
        : (image.data.image_url?.url ?? image.data.url);
    return reference ? [reference] : [];
  });
}

function codexMessage(role: Message["role"], text: string): Message[] {
  const trimmed = text.trimStart();
  if (
    role === "user" &&
    /^(?:The following is the Codex agent history added since your last approval assessment|<environment_context>|<user_instructions>|# AGENTS\.md instructions)/u.test(
      trimmed,
    )
  )
    return [];
  return message(role, text);
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
        if (item.type === "UserMessage") {
          const messages = codexMessage("user", textContent(item.content));
          const images = contentImages(item.content);
          if (messages[0] && images.length)
            messages[0].images = [
              ...new Set([...(messages[0].images ?? []), ...images]),
            ];
          return {
            preferred: messages,
            fallback: [],
          };
        }
        if (item.type === "AgentMessage")
          return {
            preferred: message("assistant", textContent(item.content)),
            fallback: [],
          };
      }
    }
    if (data.type === "user_message" && typeof data.message === "string") {
      return { preferred: [], fallback: codexMessage("user", data.message) };
    }
    if (data.type === "agent_message" && typeof data.message === "string") {
      return { preferred: [], fallback: message("assistant", data.message) };
    }
  }
  return { preferred: [], fallback: [] };
}

function codexResponseMessage(row: Record<string, unknown>): Message[] {
  if (row.type !== "response_item") return [];
  const parsed = z
    .object({
      type: z.literal("message"),
      role: messageRole,
      content: z.unknown(),
    })
    .safeParse(row.payload);
  if (!parsed.success) return [];
  const messages = codexMessage(
    parsed.data.role,
    textContent(parsed.data.content),
  );
  const images =
    parsed.data.role === "user" ? contentImages(parsed.data.content) : [];
  if (images.length) {
    const item = messages[0];
    if (item) item.images = [...new Set([...(item.images ?? []), ...images])];
    else messages.push({ role: "user", text: "Image attachment", images });
  }
  return messages;
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

async function readCodexTitles(home: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const file = path.join(home, "session_index.jsonl");
  await readLines(await safeFile(await realpath(home), file), (row) => {
    const entry = codexIndexEntry.safeParse(row);
    if (!entry.success) return;
    const title = displayTitle(entry.data.thread_name);
    if (title) titles.set(entry.data.id, title);
  });
  return titles;
}

async function codexSessions(
  root: string,
  titles: ReadonlyMap<string, string>,
  archived: boolean,
): Promise<SavedChat[]> {
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
      let subagent = false;
      await readLines(sourcePath, (row) => {
        rows += 1;
        const meta = userMeta.safeParse(row);
        if (meta.success && metadata === undefined) {
          metadata = meta.data.payload;
          const source = record.safeParse(metadata.source);
          subagent = source.success && "subagent" in source.data;
          if (subagent) return false;
          const indexedTitle = titles.get(metadata.id);
          if (indexedTitle) {
            title = indexedTitle;
            return false;
          }
        }
        const entry = record.safeParse(row);
        if (entry.success) {
          const { preferred, fallback } = codexMessages(entry.data);
          const user = [
            ...preferred,
            ...fallback,
            ...codexResponseMessage(entry.data),
          ].find((item) => item.role === "user");
          if (user && !title) title = displayTitle(user.text);
        }
        return rows < 80 && !(metadata && title);
      });
      if (!metadata || subagent || !title) return null;
      return {
        providerId: "codex",
        sourceId: metadata.id,
        title,
        cwd: metadata.cwd ?? null,
        updatedAt: (await stat(sourcePath)).mtimeMs,
        archived,
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
        archived: false,
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
  const codexTitles = await readCodexTitles(codex).catch(
    () => new Map<string, string>(),
  );
  const scan = async (
    root: string,
    list: (root: string) => Promise<SavedChat[]>,
  ) => {
    const info = await lstat(root).catch(() => null);
    return info?.isDirectory() ? list(await realpath(root)) : [];
  };
  const lists = await Promise.all([
    scan(path.join(codex, "sessions"), (root) =>
      codexSessions(root, codexTitles, false),
    ),
    scan(path.join(codex, "archived_sessions"), (root) =>
      codexSessions(root, codexTitles, true),
    ),
    scan(path.join(kimi, "sessions"), kimiSessions),
  ]);
  const seen = new Map<string, SavedChat>();
  return lists
    .flat()
    .sort(
      (a, b) =>
        Number(a.archived) - Number(b.archived) || b.updatedAt - a.updatedAt,
    )
    .filter((chat) => {
      const key = JSON.stringify([chat.providerId, chat.sourceId]);
      const existing = seen.get(key);
      if (existing) {
        existing.paths ??= [existing.path];
        existing.paths.push(chat.path);
        return false;
      }
      seen.set(key, chat);
      return true;
    });
}

export async function readSavedChat(
  chat: SavedChat,
): Promise<ChatImportRequest> {
  const entries: Array<{
    message: Message;
    timestamp: number;
    stream: string;
    order: number;
  }> = [];
  let order = 0;
  for (const [fileIndex, candidate] of [...new Set(chat.paths ?? [chat.path])]
    .reverse()
    .entries()) {
    const file = await safeFile(chat.root, candidate);
    await readLines(file, (row) => {
      const entry = record.safeParse(row);
      if (!entry.success) return;
      const parsedTimestamp =
        typeof entry.data.timestamp === "string"
          ? Date.parse(entry.data.timestamp)
          : typeof entry.data.timestamp === "number"
            ? entry.data.timestamp *
              (entry.data.timestamp < 100_000_000_000 ? 1000 : 1)
            : NaN;
      const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0;
      const streams =
        chat.providerId === "codex"
          ? {
              ...codexMessages(entry.data),
              responses: codexResponseMessage(entry.data),
            }
          : { kimi: kimiMessages(entry.data) };
      for (const [stream, messages] of Object.entries(streams)) {
        for (const message of messages)
          entries.push({
            message:
              timestamp > 0
                ? { ...message, timestamp: Math.trunc(timestamp) }
                : message,
            timestamp,
            stream: `${fileIndex}:${stream}`,
            order: order++,
          });
      }
      if (entries.length > 100_000)
        throw new Error("Chat history exceeds the import limit.");
    });
  }
  entries.sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);
  const occurrences = new Map<string, number>();
  const seen = new Map<string, Message>();
  const messages: Message[] = [];
  let bytes = 0;
  for (const { message, stream } of entries) {
    const hash = createHash("sha256")
      .update(JSON.stringify([message.role, message.text]))
      .digest("hex");
    const occurrenceKey = `${stream}:${hash}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const key = `${hash}:${occurrence}`;
    const previous = seen.get(key);
    if (previous) {
      const images = [
        ...new Set([...(previous.images ?? []), ...(message.images ?? [])]),
      ];
      if (images.length) previous.images = images;
      if (previous.timestamp === undefined && message.timestamp !== undefined)
        previous.timestamp = message.timestamp;
      continue;
    }
    bytes += Buffer.byteLength(message.text);
    if (bytes > chatImportMaxBytes)
      throw new Error("Chat history exceeds the import limit.");
    seen.set(key, message);
    messages.push(message);
  }
  const parsed = chatImportRequestSchema.safeParse({
    providerId: chat.providerId,
    sourceId: chat.sourceId,
    title: chat.title,
    messages,
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
