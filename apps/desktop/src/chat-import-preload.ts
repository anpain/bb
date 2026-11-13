import { ipcRenderer } from "electron";
import {
  chatImportCloseChannel,
  chatImportFeedbackSchema,
  chatImportSubmitChannel,
} from "./chat-import-ipc.js";

window.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("form");
  const submit = document.querySelector<HTMLButtonElement>(
    "button[type=submit]",
  );
  const close = document.querySelector<HTMLButtonElement>("button[data-close]");
  const status = document.querySelector<HTMLElement>("[data-status]");
  if (!form || !submit || !close || !status) return;
  const choices = Array.from(
    form.querySelectorAll<HTMLInputElement>("input[name=chat]"),
  );
  const remote = form.querySelector<HTMLInputElement>("input[name=remote]");
  let busy = false;
  const selected = () =>
    choices
      .filter((input) => input.checked)
      .map((input) => Number(input.value));
  const refresh = () => {
    const count = selected().length;
    submit.disabled = busy || count === 0 || count > 100;
    close.disabled = busy;
    for (const choice of choices) choice.disabled = busy;
    if (remote !== null) remote.disabled = busy;
  };
  close.addEventListener("click", () =>
    ipcRenderer.send(chatImportCloseChannel),
  );
  form.addEventListener("change", refresh);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const payload = {
      selected: selected(),
      copyToServer: remote?.checked ?? false,
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
          if (result.success && result.data.ok) {
            for (const choice of choices) choice.checked = false;
          }
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
});
