import { ipcRenderer } from "electron";
import {
  estimateChatImportContext,
  type ChatImportContext,
  type ChatImportMessageSummary,
} from "@bb/server-contract";
import {
  chatImportCloseChannel,
  chatImportFeedbackSchema,
  chatImportSubmitChannel,
  chatImportPreviewChannel,
  chatImportPreviewSchema,
} from "./chat-import-ipc.js";

window.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("form");
  const submit = document.querySelector<HTMLButtonElement>(
    "button[type=submit]",
  );
  const close = document.querySelector<HTMLButtonElement>("button[data-close]");
  const status = document.querySelector<HTMLElement>("[data-status]");
  const enabled = document.querySelector<HTMLInputElement>(
    "[data-send-context]",
  );
  const chatPicker = document.querySelector<HTMLSelectElement>(
    "[data-context-chat]",
  );
  const period = document.querySelector<HTMLSelectElement>(
    "[data-context-period]",
  );
  const refreshPreview = document.querySelector<HTMLButtonElement>(
    "[data-refresh-preview]",
  );
  if (
    !form ||
    !submit ||
    !close ||
    !status ||
    !enabled ||
    !chatPicker ||
    !period ||
    !refreshPreview
  )
    return;
  const choices = Array.from(
    form.querySelectorAll<HTMLInputElement>("input[name=chat]"),
  );
  const remote = form.querySelector<HTMLInputElement>("input[name=remote]");
  const search = form.querySelector<HTMLInputElement>("[data-search]");
  const rows = Array.from(
    form.querySelectorAll<HTMLElement>("[data-chat]"),
    (row) => ({ row, text: (row.textContent ?? "").toLocaleLowerCase() }),
  );
  const rangeStart =
    form.querySelector<HTMLInputElement>("[data-range-start]")!;
  const rangeEnd = form.querySelector<HTMLInputElement>("[data-range-end]")!;
  const numberStart = form.querySelector<HTMLInputElement>(
    "[data-number-start]",
  )!;
  const numberEnd = form.querySelector<HTMLInputElement>("[data-number-end]")!;
  const dateStart = form.querySelector<HTMLInputElement>("[data-date-start]")!;
  const dateEnd = form.querySelector<HTMLInputElement>("[data-date-end]")!;
  const cache = new Map<
    number,
    { sourceHash: string; messages: ChatImportMessageSummary[] }
  >();
  const settings = new Map<
    number,
    { period: string; context: ChatImportContext }
  >();
  const errors = new Set<number>();
  let busy = false;
  let loading = false;
  const selected = () =>
    choices
      .filter((input) => input.checked)
      .map((input) => Number(input.value));
  const currentIndex = () => Number(chatPicker.value);
  const setting = (index: number) =>
    settings.get(index) ?? { period: "all", context: { mode: "all" } as const };
  const showText = (selector: string, text: string) => {
    const element = form.querySelector<HTMLElement>(selector);
    if (element) element.textContent = text;
  };
  const hide = (selector: string, hidden: boolean) => {
    const element = form.querySelector<HTMLElement>(selector);
    if (element) element.hidden = hidden;
  };
  const formatTokens = (value: number) => value.toLocaleString();
  const tokenText = (min: number, max: number) =>
    max === 0 ? "0" : `approximately ${formatTokens(min)}–${formatTokens(max)}`;
  const dateValue = (timestamp: number | null) => {
    if (timestamp === null) return "";
    const date = new Date(timestamp);
    return new Date(timestamp - date.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
  };
  const boundaryText = (
    messages: ChatImportMessageSummary[],
    index: number,
  ) => {
    const message = messages[index];
    return message
      ? `${index + 1}. ${message.role === "user" ? "You" : "Assistant"} · ${message.timestamp === null ? "Time unavailable" : new Date(message.timestamp).toLocaleString()}\n${message.excerpt}`
      : "No messages selected";
  };
  const refresh = () => {
    const indexes = selected();
    const previous = chatPicker.value;
    if (
      Array.from(chatPicker.options)
        .map((option) => option.value)
        .join(",") !== indexes.join(",")
    ) {
      chatPicker.replaceChildren(
        ...indexes.map((index) => {
          const option = document.createElement("option");
          option.value = String(index);
          option.textContent =
            rows[index]?.row.querySelector("strong")?.textContent ??
            `Chat ${index + 1}`;
          return option;
        }),
      );
      if (previous !== "" && indexes.includes(Number(previous)))
        chatPicker.value = previous;
    }
    const pending =
      enabled.checked && indexes.some((index) => !cache.has(index));
    submit.disabled =
      busy ||
      indexes.length === 0 ||
      indexes.length > 100 ||
      pending ||
      loading;
    submit.textContent =
      indexes.length === 0
        ? "Import selected"
        : `Import selected (${indexes.length})`;
    close.disabled = busy;
    enabled.disabled = busy;
    for (const choice of choices) choice.disabled = busy;
    if (remote) remote.disabled = busy;
    hide("[data-context-controls]", !enabled.checked);
    hide("[data-context-off]", enabled.checked);
    refreshPreview.hidden = !enabled.checked;
    refreshPreview.disabled = busy || loading;
    chatPicker.disabled = busy || indexes.length === 0;
    const preview = indexes.includes(currentIndex())
      ? cache.get(currentIndex())
      : undefined;
    const state = setting(currentIndex());
    period.value = state.period;
    period.disabled = busy || !preview;
    const messages = preview?.messages ?? [];
    const dated = messages.filter((message) => message.timestamp !== null);
    for (const option of period.options)
      if (["hour", "day", "week"].includes(option.value))
        option.disabled = dated.length === 0;
    hide("[data-manual]", state.period !== "manual" || !preview);
    showText(
      "[data-date-warning]",
      preview && dated.length !== messages.length
        ? `${messages.length - dated.length} messages have no source timestamp. Use message sliders to include them precisely.`
        : "",
    );
    const first =
      state.context.mode === "range" ? state.context.startMessage : 0;
    const end =
      state.context.mode === "range"
        ? state.context.endMessage
        : messages.length;
    for (const control of [rangeStart, rangeEnd, numberStart, numberEnd]) {
      control.max = String(messages.length);
      control.disabled = busy || !preview;
    }
    rangeStart.value = numberStart.value = String(first + 1);
    rangeEnd.value = numberEnd.value = String(end);
    dateStart.disabled = dateEnd.disabled = busy || dated.length === 0;
    if (document.activeElement !== dateStart)
      dateStart.value = dateValue(messages[first]?.timestamp ?? null);
    if (document.activeElement !== dateEnd)
      dateEnd.value = dateValue(messages[end - 1]?.timestamp ?? null);
    showText("[data-start-preview]", boundaryText(messages, first));
    showText("[data-end-preview]", boundaryText(messages, end - 1));
    const estimate = estimateChatImportContext(
      messages,
      enabled.checked ? state.context : { mode: "none" },
    );
    showText(
      "[data-chat-estimate]",
      preview
        ? `This chat: ${estimate.messages} of ${estimate.totalMessages} messages · ${tokenText(estimate.estimatedTextTokens.min, estimate.estimatedTextTokens.max)} text tokens + ${estimate.images} images`
        : "Select chats to preview context and token usage.",
    );
    hide("[data-large-context]", !estimate.mayExceedModelContext);
    let min = 0;
    let max = 0;
    let images = 0;
    if (enabled.checked)
      for (const index of indexes) {
        const chat = cache.get(index);
        if (!chat) continue;
        const total = estimateChatImportContext(
          chat.messages,
          setting(index).context,
        );
        min += total.estimatedTextTokens.min;
        max += total.estimatedTextTokens.max;
        images += total.images;
      }
    showText(
      "[data-estimate]",
      `Imported context across selected chats: ${tokenText(min, max)} text tokens${images ? ` + ${images} images` : ""}${pending ? " (preview incomplete)" : ""}. Used only when each chat is first continued.`,
    );
  };
  const loadPreviews = async () => {
    if (loading || !enabled.checked) return;
    loading = true;
    try {
      for (;;) {
        const index = selected().find(
          (item) => !cache.has(item) && !errors.has(item),
        );
        if (index === undefined || !enabled.checked) break;
        status.textContent = "Reading selected chats and estimating context…";
        refresh();
        const result = chatImportPreviewSchema.safeParse(
          await ipcRenderer.invoke(chatImportPreviewChannel, index),
        );
        if (result.success && result.data.ok) cache.set(index, result.data);
        else {
          errors.add(index);
          status.textContent =
            result.success && !result.data.ok
              ? result.data.message
              : "Could not preview chat.";
        }
      }
      if (errors.size === 0) status.textContent = "";
    } catch {
      status.textContent = "Could not preview chat. Refresh previews to retry.";
    } finally {
      loading = false;
      refresh();
    }
  };
  const setPeriod = () => {
    const index = currentIndex();
    const preview = cache.get(index);
    if (!preview) return;
    if (period.value === "all" || period.value === "none")
      settings.set(index, {
        period: period.value,
        context: { mode: period.value },
      });
    else if (period.value === "manual")
      settings.set(index, {
        period: "manual",
        context: {
          mode: "range",
          startMessage: 0,
          endMessage: preview.messages.length,
        },
      });
    else {
      const duration =
        period.value === "hour"
          ? 3_600_000
          : period.value === "day"
            ? 86_400_000
            : 7 * 86_400_000;
      const timestamps = preview.messages.flatMap((message) =>
        message.timestamp === null ? [] : [message.timestamp],
      );
      const cutoff = Math.max(...timestamps) - duration;
      const included = preview.messages.flatMap((message, at) =>
        message.timestamp !== null && message.timestamp >= cutoff ? [at] : [],
      );
      if (included.length)
        settings.set(index, {
          period: period.value,
          context: {
            mode: "range",
            startMessage: included[0]!,
            endMessage: included.at(-1)! + 1,
          },
        });
    }
    refresh();
  };
  const updateRange = (changed: "start" | "end", value: string) => {
    const index = currentIndex();
    const messages = cache.get(index)?.messages;
    if (!messages?.length) return;
    const current = setting(index).context;
    let start = current.mode === "range" ? current.startMessage : 0;
    let end = current.mode === "range" ? current.endMessage : messages.length;
    const at = Math.max(
      1,
      Math.min(messages.length, Math.trunc(Number(value)) || 1),
    );
    if (changed === "start") {
      start = at - 1;
      end = Math.max(end, start + 1);
    } else {
      end = at;
      start = Math.min(start, end - 1);
    }
    settings.set(index, {
      period: "manual",
      context: { mode: "range", startMessage: start, endMessage: end },
    });
    refresh();
  };
  for (const control of [rangeStart, numberStart])
    control.addEventListener("input", () =>
      updateRange("start", control.value),
    );
  for (const control of [rangeEnd, numberEnd])
    control.addEventListener("input", () => updateRange("end", control.value));
  for (const [control, side] of [
    [dateStart, "start"],
    [dateEnd, "end"],
  ] as const)
    control.addEventListener("change", () => {
      const timestamp = new Date(control.value).getTime();
      const messages = cache.get(currentIndex())?.messages;
      if (!Number.isFinite(timestamp) || !messages) return;
      const indexes = messages.flatMap((message, index) =>
        message.timestamp !== null &&
        (side === "start"
          ? message.timestamp >= timestamp
          : message.timestamp <= timestamp + 59_999)
          ? [index]
          : [],
      );
      if (indexes.length)
        updateRange(
          side,
          String((side === "start" ? indexes[0]! : indexes.at(-1)!) + 1),
        );
      else
        status.textContent =
          "No dated messages at this boundary. Choose another time or use the message sliders.";
    });
  period.addEventListener("change", setPeriod);
  chatPicker.addEventListener("change", refresh);
  enabled.addEventListener("change", () => {
    refresh();
    void loadPreviews();
  });
  refreshPreview.addEventListener("click", () => {
    cache.clear();
    errors.clear();
    for (const index of selected())
      settings.set(index, { period: "none", context: { mode: "none" } });
    refresh();
    void loadPreviews();
  });
  search?.addEventListener("input", () => {
    const terms = search.value.trim().toLocaleLowerCase().split(/\s+/u);
    for (const { row, text } of rows)
      row.hidden = !terms.every((term) => text.includes(term));
    hide(
      "[data-no-matches]",
      rows.some(({ row }) => !row.hidden),
    );
  });
  close.addEventListener("click", () =>
    ipcRenderer.send(chatImportCloseChannel),
  );
  form.addEventListener("change", () => {
    refresh();
    void loadPreviews();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const indexes = selected();
    const payload = {
      selected: indexes,
      copyToServer: remote?.checked ?? false,
      contexts: indexes.map((index) => ({
        index,
        context: enabled.checked ? setting(index).context : { mode: "none" },
        ...(enabled.checked
          ? { sourceHash: cache.get(index)?.sourceHash }
          : {}),
      })),
    };
    busy = true;
    refresh();
    status.textContent = "Importing selected chats…";
    void ipcRenderer
      .invoke(chatImportSubmitChannel, payload)
      .then(
        (value: unknown) => {
          const result = chatImportFeedbackSchema.safeParse(value);
          status.textContent = result.success
            ? result.data.message
            : "Could not import chats.";
          if (result.success && result.data.ok)
            for (const choice of choices) choice.checked = false;
        },
        () => {
          status.textContent = "Could not import chats.";
        },
      )
      .finally(() => {
        busy = false;
        refresh();
      });
  });
  refresh();
});
