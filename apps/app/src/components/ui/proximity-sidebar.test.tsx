// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProximitySidebar } from "./proximity-sidebar";

afterEach(cleanup);

describe("ProximitySidebar", () => {
  it("navigates to actual message IDs without changing the URL", () => {
    const select = vi.fn();
    const href = window.location.href;
    render(
      <ProximitySidebar
        items={[
          { id: "message-1", label: "First request" },
          { id: "message-2", label: "Next request" },
        ]}
        activeId="message-2"
        onSelect={select}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "Jump to Next request" })
        .getAttribute("aria-current"),
    ).toBe("location");
    fireEvent.click(
      screen.getByRole("button", { name: "Jump to First request" }),
    );
    expect(select).toHaveBeenCalledWith("message-1");
    expect(window.location.href).toBe(href);
  });
});
