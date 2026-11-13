// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { defaultAppSettings } from "@bb/domain";
import { AgentProfilesSettings } from "./AgentProfilesSettings";

const catalog = vi.hoisted(() => ({ refetch: vi.fn() }));
vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemProviders: () => ({
    data: [
      {
        id: "acp-opencode",
        displayName: "OpenCode",
        logoUrl: "/provider-logo.svg",
        strings: { iconTint: { light: "#3456ff", dark: "#789aff" } },
      },
    ],
  }),
  useProviderPreviewExecutionOptions: () => ({
    data: {
      providers: [{ id: "acp-opencode", displayName: "OpenCode" }],
      models: [
        {
          model: "rurout/gpt-6.1-sol",
          displayName: "GPT Sol",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low reasoning effort" },
            { reasoningEffort: "high", description: "High reasoning effort" },
          ],
          supportedServiceTiers: [],
        },
        {
          model: "other/model",
          displayName: "Other model",
          supportedReasoningEfforts: [],
          supportedServiceTiers: [],
        },
      ],
    },
    isPending: false,
    isFetching: false,
    isError: false,
    refetch: catalog.refetch,
  }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const profile = defaultAppSettings.agentProfiles.find(
  (item) => item.id === "opencode",
)!;

async function change(view: ReturnType<typeof render>) {
  fireEvent.pointerDown(
    view.getByRole("button", { name: `Actions for ${profile.name}` }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await view.findByRole("menuitem", { name: "Change" }));
  return within(await view.findByRole("dialog"));
}

it("filters models and saves exact IDs and deduplicated aliases from Change", async () => {
  const onChange = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <AgentProfilesSettings
      settings={{ ...defaultAppSettings, agentProfiles: [profile] }}
      disabled={false}
      onChange={onChange}
    />,
  );
  expect(view.queryByRole("textbox")).toBeNull();
  expect(
    view.container.querySelector('[data-provider-logo="/provider-logo.svg"]'),
  ).not.toBeNull();
  const dialog = await change(view);
  expect(
    dialog
      .getByRole("button", { name: "Choose provider" })
      .querySelector('[data-provider-logo="/provider-logo.svg"]'),
  ).not.toBeNull();
  fireEvent.pointerDown(
    dialog.getByRole("button", { name: "Choose default profile model" }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.change(
    await view.findByRole("textbox", { name: "Search provider models" }),
    { target: { value: "rurout" } },
  );
  expect(view.queryByRole("menuitem", { name: /Other model/u })).toBeNull();
  fireEvent.click(view.getByRole("menuitem", { name: /GPT Sol/u }));
  fireEvent.pointerDown(
    dialog.getByRole("button", { name: "Choose reasoning level" }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(
    await view.findByRole("menuitem", { name: /High reasoning effort/u }),
  );
  fireEvent.change(dialog.getByRole("textbox", { name: "Aliases" }), {
    target: { value: "@sol, опен, sol" },
  });
  fireEvent.click(
    dialog.getByRole("button", { name: "Refresh model catalog" }),
  );
  expect(catalog.refetch).toHaveBeenCalledOnce();
  fireEvent.click(dialog.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith({
      agentProfiles: [
        {
          ...profile,
          name: profile.name,
          model: "rurout/gpt-6.1-sol",
          reasoningLevel: "high",
          aliases: ["sol", "опен"],
        },
      ],
    }),
  );
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
});

it("clears incompatible reasoning when changing models", async () => {
  const onChange = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <AgentProfilesSettings
      settings={{
        ...defaultAppSettings,
        agentProfiles: [
          { ...profile, model: "rurout/gpt-6.1-sol", reasoningLevel: "high" },
        ],
      }}
      disabled={false}
      onChange={onChange}
    />,
  );
  const dialog = await change(view);
  fireEvent.pointerDown(
    dialog.getByRole("button", { name: "Choose default profile model" }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await view.findByRole("menuitem", { name: /Other model/u }));
  expect(
    dialog.getByRole("button", { name: "Choose reasoning level" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(dialog.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith({
      agentProfiles: [
        expect.objectContaining({ model: "other/model", reasoningLevel: null }),
      ],
    }),
  );
});

it("cancels edits without persisting and adds an alias with a selected model", async () => {
  const onChange = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <AgentProfilesSettings
      settings={{ ...defaultAppSettings, agentProfiles: [profile] }}
      disabled={false}
      onChange={onChange}
    />,
  );
  const dialog = await change(view);
  fireEvent.change(dialog.getByRole("textbox", { name: "Aliases" }), {
    target: { value: "discarded" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Add alias" }));
  const add = within(await view.findByRole("dialog"));
  fireEvent.change(add.getByRole("textbox", { name: "Aliases" }), {
    target: { value: "@new" },
  });
  fireEvent.pointerDown(
    add.getByRole("button", { name: "Choose default profile model" }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await view.findByRole("menuitem", { name: /Other model/u }));
  fireEvent.click(add.getByRole("button", { name: "Add alias" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith({
      agentProfiles: [
        profile,
        expect.objectContaining({ aliases: ["new"], model: "other/model" }),
      ],
    }),
  );
});

it("keeps the modal draft after a failed save and allows retry", async () => {
  const onChange = vi
    .fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce(undefined);
  const view = render(
    <AgentProfilesSettings
      settings={{ ...defaultAppSettings, agentProfiles: [profile] }}
      disabled={false}
      onChange={onChange}
    />,
  );
  const dialog = await change(view);
  fireEvent.change(dialog.getByRole("textbox", { name: "Aliases" }), {
    target: { value: "@retry" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Save changes" }));
  expect(await view.findByRole("alert")).toHaveProperty(
    "textContent",
    "Offline",
  );
  expect(dialog.getByRole("textbox", { name: "Aliases" })).toHaveProperty(
    "value",
    "@retry",
  );
  fireEvent.click(dialog.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
});

it("deletes through the row menu and retains the row when persistence fails", async () => {
  const onChange = vi
    .fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce(undefined);
  const view = render(
    <AgentProfilesSettings
      settings={{ ...defaultAppSettings, agentProfiles: [profile] }}
      disabled={false}
      onChange={onChange}
    />,
  );
  const remove = async () => {
    fireEvent.pointerDown(
      view.getByRole("button", { name: `Actions for ${profile.name}` }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await view.findByRole("menuitem", { name: "Delete" }));
  };
  await remove();
  expect(await view.findByRole("alert")).toHaveProperty(
    "textContent",
    "Alias could not be deleted.",
  );
  await remove();
  await waitFor(() =>
    expect(
      view.queryByRole("button", { name: `Actions for ${profile.name}` }),
    ).toBeNull(),
  );
  expect(onChange).toHaveBeenLastCalledWith({ agentProfiles: [] });
});
