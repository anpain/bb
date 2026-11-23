import { z } from "zod";

export const desktopComputerActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("request_access"),
      reason: z.string().trim().min(1).max(500),
    })
    .strict(),
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("screenshot") }).strict(),
  z.object({ action: z.literal("stop") }).strict(),
  z
    .object({
      action: z.literal("click"),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      button: z.enum(["left", "right", "double"]),
    })
    .strict(),
  z
    .object({ action: z.literal("type"), text: z.string().min(1).max(1000) })
    .strict(),
  z
    .object({
      action: z.literal("key"),
      key: z.enum([
        "Enter",
        "Tab",
        "Escape",
        "Backspace",
        "Delete",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "Ctrl+A",
        "Ctrl+C",
        "Ctrl+V",
        "Ctrl+S",
        "Ctrl+Z",
        "Ctrl+Y",
        "Ctrl+F",
      ]),
    })
    .strict(),
  z
    .object({
      action: z.literal("scroll"),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      steps: z
        .number()
        .int()
        .min(-10)
        .max(10)
        .refine((n) => n !== 0),
    })
    .strict(),
]);
export type DesktopComputerAction = z.infer<typeof desktopComputerActionSchema>;
export const desktopComputerResultSchema = z
  .object({
    active: z.boolean(),
    window: z.string().nullable(),
    expiresAt: z.number().int().positive().nullable(),
    screenshot: z
      .object({
        mimeType: z.literal("image/jpeg"),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        base64: z.string().max(16 * 1024 * 1024),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type DesktopComputerResult = z.infer<typeof desktopComputerResultSchema>;
