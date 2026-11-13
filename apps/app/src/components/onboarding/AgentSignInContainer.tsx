import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isActiveTerminalSessionStatus } from "@bb/domain";
import type { TerminalOutputChunk, TerminalSession } from "@bb/server-contract";
import { ThreadTerminalView } from "@/components/thread/terminal/ThreadTerminalView";
import { appToast } from "@/components/ui/app-toast";
import { terminalOutputTailQueryKey } from "@/hooks/queries/query-keys";
import {
  useCloseTerminal,
  useCreateTerminal,
} from "@/hooks/queries/thread-terminal-queries";
import { decodeBase64Bytes } from "@/lib/base64-bytes";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { AgentSignInGuide, AgentSignInPanel } from "./OnboardingViews";
import {
  agentSignInView,
  connectFlowFailed,
  type AgentSignInView,
  type TerminalConnectFlow,
} from "./onboarding-model";
import type { AgentSignInTerminals, SignInMethod } from "./useAgentSignIns";
import { useSendAfterFirstOutput } from "./useSendAfterFirstOutput";

const SIGN_IN_TERMINAL_COLS = 200;
const SIGN_IN_TERMINAL_ROWS = 14;
const SIGN_IN_OUTPUT_POLL_INTERVAL_MS = 1_000;
const SIGN_IN_OUTPUT_TAIL_BYTES = 64 * 1024;
const SIGN_IN_TERMINAL_FALLBACK_DELAY_MS = 6_000;
const REDESIGN_SIGN_IN_TERMINAL_FALLBACK_DELAY_MS = 3_000;
const CONNECT_INPUT_SETTLE_MS = 500;

async function closeAbandonedSignInTerminals({
  hostId,
  title,
}: {
  hostId: string;
  title: string;
}): Promise<void> {
  const listing = await sdk.terminals
    .list({ scope: { kind: "host_path", hostId } })
    .catch(() => null);
  const abandoned = (listing?.sessions ?? []).filter(
    (session) =>
      session.title === title && isActiveTerminalSessionStatus(session.status),
  );
  await Promise.all(
    abandoned.map((session) =>
      sdk.terminals
        .close({ mode: "force", terminalId: session.id })
        .catch(() => null),
    ),
  );
}

export function useAgentSignInTerminals(): AgentSignInTerminals {
  const { mutateAsync: createTerminalAsync } = useCreateTerminal();
  const { mutate: closeTerminalMutate } = useCloseTerminal();
  return useMemo(
    () => ({
      closeAbandoned: closeAbandonedSignInTerminals,
      create: ({ hostId: targetHostId, title, command }) =>
        createTerminalAsync({
          cols: SIGN_IN_TERMINAL_COLS,
          rows: SIGN_IN_TERMINAL_ROWS,
          title,
          start: { mode: "command", command },
          target: { kind: "host_path", hostId: targetHostId, cwd: null },
        }),
      close: (terminalId) => closeTerminalMutate({ mode: "force", terminalId }),
    }),
    [closeTerminalMutate, createTerminalAsync],
  );
}

function decodeTerminalChunks(chunks: readonly TerminalOutputChunk[]): string {
  const decoder = new TextDecoder();
  return chunks
    .map((chunk) =>
      decoder.decode(decodeBase64Bytes(chunk.dataBase64), { stream: true }),
    )
    .join("");
}

function encodeTerminalInput(text: string): string {
  return btoa(
    Array.from(new TextEncoder().encode(text), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  );
}

export function AgentSignInContainer({
  redesign,
  parsed,
  connectFlow,
  agentName,
  session,
  alternate,
  onUseAlternate,
  onExit,
  onFail,
  onViewChange,
}: {
  redesign: boolean;
  parsed: boolean;
  connectFlow: TerminalConnectFlow | null;
  onViewChange: (view: AgentSignInView) => void;
  agentName: string;
  session: TerminalSession;
  alternate: { label: string; method: SignInMethod } | null;
  onUseAlternate: (method: SignInMethod) => void;
  onExit: (exitCode: number | null) => void;
  onFail: () => void;
}) {
  const outputQuery = useQuery({
    queryKey: terminalOutputTailQueryKey(session.id),
    queryFn: ({ signal }) =>
      sdk.terminals.output({
        terminalId: session.id,
        tailBytes: SIGN_IN_OUTPUT_TAIL_BYTES,
        signal,
      }),
    refetchInterval: SIGN_IN_OUTPUT_POLL_INTERVAL_MS,
    gcTime: 0,
    retry: false,
  });
  const output = outputQuery.data;
  const outputText = useMemo(
    () => (output === undefined ? null : decodeTerminalChunks(output.chunks)),
    [output],
  );
  const connectFailed =
    connectFlow !== null &&
    outputText !== null &&
    connectFlowFailed(connectFlow, outputText);
  useEffect(() => {
    if (connectFailed) onFail();
  }, [connectFailed, onFail]);
  const [code, setCode] = useState("");
  const [codeSubmitted, setCodeSubmitted] = useState(false);
  const [terminalChoice, setTerminalChoice] = useState<boolean | null>(null);
  const [fallbackDue, setFallbackDue] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setFallbackDue(true),
      redesign
        ? REDESIGN_SIGN_IN_TERMINAL_FALLBACK_DELAY_MS
        : SIGN_IN_TERMINAL_FALLBACK_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [redesign]);
  const view = useMemo(
    () =>
      agentSignInView({
        parsed,
        connect: connectFlow !== null,
        outputText,
        fallbackDue,
        terminalChoice,
        signInLink: redesign ? "last" : "first",
      }),
    [connectFlow, fallbackDue, outputText, parsed, redesign, terminalChoice],
  );
  const { guide, terminalVisible } = view;
  useEffect(() => {
    onViewChange(view);
  }, [onViewChange, view]);
  useSendAfterFirstOutput({
    enabled: connectFlow !== null,
    hasOutput: (output?.chunks.length ?? 0) > 0,
    settleMs: CONNECT_INPUT_SETTLE_MS,
    send: () => {
      if (connectFlow === null) return;
      void sdk.terminals
        .input({
          terminalId: session.id,
          dataBase64: encodeTerminalInput(connectFlow.input),
        })
        .catch(() => undefined);
    },
  });

  const exited =
    output !== undefined && !isActiveTerminalSessionStatus(output.status);
  const exitCode = output?.exitCode ?? null;
  useEffect(() => {
    if (exited) onExit(exitCode);
  }, [exitCode, exited, onExit]);

  const submitCode = () => {
    const trimmed = code.trim();
    if (trimmed.length === 0) return;
    setCodeSubmitted(true);
    sdk.terminals
      .input({
        terminalId: session.id,
        dataBase64: encodeTerminalInput(`${trimmed}\r`),
      })
      .catch(() => {
        setCodeSubmitted(false);
        appToast.error("Couldn't send the code. Try again.");
      });
  };

  const terminal = (
    <ThreadTerminalView autoFocus={false} isPanelOpen session={session} />
  );
  if (redesign) {
    return (
      <AgentSignInPanel
        connect={connectFlow !== null}
        agentName={agentName}
        view={view}
        code={code}
        codeSubmitted={codeSubmitted}
        terminal={terminal}
        onCodeChange={(next) => {
          setCode(next);
          setCodeSubmitted(false);
        }}
        onSubmitCode={submitCode}
        onCopy={(text) => void copyToClipboardWithToast(text)}
        onToggleTerminal={() => setTerminalChoice(!terminalVisible)}
      />
    );
  }
  return (
    <AgentSignInGuide
      agentName={agentName}
      guide={guide}
      code={code}
      codeSubmitted={codeSubmitted}
      terminalVisible={terminalVisible}
      terminal={terminal}
      onCodeChange={(next) => {
        setCode(next);
        setCodeSubmitted(false);
      }}
      onSubmitCode={submitCode}
      onOpenUrl={openUrlInExternalBrowser}
      onCopy={(text) => void copyToClipboardWithToast(text)}
      onToggleTerminal={() => setTerminalChoice(!terminalVisible)}
      alternateLabel={alternate?.label ?? null}
      onUseAlternate={() => {
        if (alternate !== null) onUseAlternate(alternate.method);
      }}
    />
  );
}
