import os from "node:os";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
  internal_DO_NOT_USE_nativeSessionTransferHostContract,
  type ExperimentalNativeRootsResolveAnswer,
} from "@get-bb/plugin-sdk/host";
import {
  completeCodexInference,
  transcribeCodexVoice,
} from "./ai/chatgpt-client.js";
import { readCodexAuthCredentials } from "./ai/codex-auth.js";
import { AiServiceFailure, toAiServiceFailure } from "./ai/failure.js";
import {
  codexAiHostContract,
  type CodexAiStatus,
  type CodexAiTextResult,
} from "./ai/host-contract.js";
import { resolveCodexNativeRoots } from "./native-roots.js";
import { transferCodexNativeSession } from "./native-session-transfer.js";

export { experimental_providerBridge } from "./bridge/bridge.js";

const codexHostContract = defineRpcContract({
  ...codexAiHostContract,
  ...experimental_nativeRootsHostContract,
  ...internal_DO_NOT_USE_nativeSessionTransferHostContract,
});

async function textResult(work: Promise<string>): Promise<CodexAiTextResult> {
  try {
    return { ok: true, text: await work };
  } catch (error) {
    return toAiServiceFailure(error);
  }
}

export default experimental_defineHostEntry({
  contract: codexHostContract,
  handlers: {
    transferNativeSession: (input, context) =>
      transferCodexNativeSession(
        input,
        context.experimental_paths.dataDir,
        context.signal,
      ),
    resolveNativeRoots: (): Promise<ExperimentalNativeRootsResolveAnswer> =>
      resolveCodexNativeRoots({ homeDir: os.homedir(), env: process.env }),
    "codex.ai.complete": (input, context) =>
      textResult(completeCodexInference(input, context.signal)),
    "codex.ai.transcribe": (input, context) =>
      textResult(transcribeCodexVoice(input, context.signal)),
    "codex.ai.status": async (): Promise<CodexAiStatus> => {
      try {
        await readCodexAuthCredentials();
        return { ready: true };
      } catch (error) {
        return {
          ready: false,
          message:
            error instanceof AiServiceFailure &&
            error.detailCode !== "codex_auth_missing"
              ? error.message
              : "Run `codex login` on the primary machine to sign in",
        };
      }
    },
  },
});
