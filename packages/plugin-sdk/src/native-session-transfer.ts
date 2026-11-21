import { z } from "zod";
import { defineRpcContract } from "./rpc-contract.js";

const identity = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/u);
export const internal_DO_NOT_USE_nativeSessionTransferInputSchema = z
  .object({
    action: z.enum(["export", "prepare", "activate"]),
    threadId: identity,
    providerThreadId: identity,
    nativeHome: z.string().min(1).nullable(),
  })
  .strict();
export const internal_DO_NOT_USE_nativeSessionTransferOutputSchema = z
  .object({
    rootPath: z.string().min(1),
    nativeHome: z.string().min(1),
  })
  .strict();
export const internal_DO_NOT_USE_nativeSessionTransferHostContract =
  defineRpcContract({
    transferNativeSession: {
      input: internal_DO_NOT_USE_nativeSessionTransferInputSchema,
      output: internal_DO_NOT_USE_nativeSessionTransferOutputSchema,
    },
  });
