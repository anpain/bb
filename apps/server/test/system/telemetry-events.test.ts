import { describe, expect, it } from "vitest";
import { withTestHarness } from "../helpers/test-app.js";

describe("retired telemetry route", () => {
  it("rejects events sent by older clients", async () => {
    await withTestHarness(async ({ app }) => {
      const response = await app.request("/api/v1/system/telemetry/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "onboarding_exposed",
          properties: { entry: "first_run" },
        }),
      });

      expect(response.status).toBe(404);
    });
  });
});
