// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  ExecutionControls,
  type ExecutionControlsProps,
} from "./ExecutionControls";
import { ModelReasoningMenu } from "@/components/pickers/ModelReasoningMenuSplit";

function makeExecutionControlsProps(
  providerOnChange?: (value: string) => void,
): ExecutionControlsProps {
  return {
    provider: {
      options: [
        { value: "codex", label: "Codex" },
        { value: "claude", label: "Claude Code" },
      ],
      selectedId: "codex",
      onChange: providerOnChange,
      hasMultiple: true,
    },
    model: {
      active: null,
      selected: "gpt-5",
      options: [{ value: "gpt-5", label: "GPT-5" }],
      moreOptions: [],
      isLoading: false,
      loadFailed: false,
      loadError: null,
      onChange: vi.fn(),
    },
    reasoning: {
      value: "medium",
      options: [{ value: "medium", label: "Medium" }],
      onChange: vi.fn(),
    },
  };
}

function renderExecutionControls(props: ExecutionControlsProps) {
  const { wrapper } = createQueryClientTestHarness();
  return render(<ExecutionControls {...props} />, { wrapper });
}

beforeAll(() => ModelReasoningMenu.preload());

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ExecutionControls", () => {
  it("shows the configured Codex account and allows a chat override", () => {
    const onChange = vi.fn();
    renderExecutionControls({
      ...makeExecutionControlsProps(),
      codexAccount: {
        accountId: null,
        label: "Work",
        defaultLabel: "Default · Work",
        accounts: [
          { id: "work", label: "Work", enabled: true },
          {
            id: "personal",
            label: "Personal",
            enabled: true,
            windows: [
              {
                minutes: 300,
                remainingPercent: 72,
                resetAt: 1_900_000_000_000,
              },
            ],
          },
        ],
        onChange,
      },
    });
    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });
    expect(trigger.textContent).toContain("Work");
    fireEvent.click(trigger);
    const accounts = screen.getByRole("combobox", { name: "Account" });
    expect(accounts).toHaveProperty("value", "");
    expect(
      screen.getByRole("option", { name: "Personal · 5h 72% left" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Account limits"));
    expect(screen.getByText(/5h 72% left · Resets/u)).toBeTruthy();
    fireEvent.change(accounts, { target: { value: "personal" } });
    expect(onChange).toHaveBeenCalledWith("personal");
  });

  it("offers a favorite profile before the list of models", () => {
    const onSelect = vi.fn();
    const profile = {
      id: "work",
      name: "Work setup",
      providerId: "codex",
      model: "gpt-5",
      aliases: [],
      reasoningLevel: "high" as const,
      serviceTier: null,
      favorite: true,
      codexAccountId: "11111111-1111-4111-8111-111111111111",
    };
    renderExecutionControls({
      ...makeExecutionControlsProps(),
      favorites: { profiles: [profile], onSelect, pending: false },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Provider, model and reasoning" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Work setup/u }));
    expect(onSelect).toHaveBeenCalledWith(profile);
  });

  it("hides provider tabs when the provider is locked", () => {
    renderExecutionControls(makeExecutionControlsProps());

    fireEvent.click(
      screen.getByRole("button", {
        name: "Provider, model and reasoning",
      }),
    );

    expect(screen.queryByText("Model")).not.toBeNull();
    expect(screen.queryByTitle("Claude Code")).toBeNull();
  });

  it("shows provider tabs when provider changes are allowed", () => {
    renderExecutionControls(makeExecutionControlsProps(vi.fn()));

    fireEvent.click(
      screen.getByRole("button", {
        name: "Provider, model and reasoning",
      }),
    );

    expect(screen.queryByTitle("Claude Code")).not.toBeNull();
  });

  it("keeps showing the known model when model options fail to load", () => {
    const props = makeExecutionControlsProps();
    renderExecutionControls({
      ...props,
      model: {
        ...props.model,
        active: { model: "o4-mini" },
        options: [],
        loadFailed: true,
        loadError: { providerId: "codex", code: "failed", detail: null },
      },
    });

    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });

    expect(trigger.textContent).toContain("o4-mini");
    expect(trigger.textContent).not.toContain("Failed to load models");
  });
});
