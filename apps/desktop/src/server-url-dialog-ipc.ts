import { z } from "zod";

export const BB_DESKTOP_SERVER_URL_DIALOG_SUBMIT_CHANNEL =
  "bb-desktop:server-url-dialog:submit";
export const BB_DESKTOP_SERVER_URL_DIALOG_CANCEL_CHANNEL =
  "bb-desktop:server-url-dialog:cancel";

export const serverUrlDialogSubmitRequestSchema = z
  .object({
    name: z.string().max(1024),
    url: z.string().max(4096),
    sshTarget: z.string().max(255),
    sshIdentityFile: z.string().max(4096),
    sshRemotePort: z.string().max(5),
  })
  .strict();

export const serverUrlDialogSubmitResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), message: z.string() }).strict(),
]);
export type ServerUrlDialogSubmitResponse = z.infer<
  typeof serverUrlDialogSubmitResponseSchema
>;
