import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  CODEX_POOL_PLUGIN_ID,
  codexPoolRoutingSchema,
} from "@bb/server-contract";
import { BbHttpError, sdk } from "@/lib/sdk";
import { wsManager } from "@/lib/ws";

export function useCodexPoolRouting(threadId: string | null, enabled: boolean) {
  const queryClient = useQueryClient();
  const key = [CODEX_POOL_PLUGIN_ID, "codex-routing", threadId] as const;
  const routing = useQuery({
    queryKey: key,
    enabled,
    retry: false,
    staleTime: 30_000,
    refetchInterval: enabled ? 60_000 : false,
    queryFn: async ({ signal }) => {
      try {
        return await sdk.plugins.callRpc({
          pluginId: CODEX_POOL_PLUGIN_ID,
          method: "codexRouting.get",
          input: { threadId },
          outputSchema: codexPoolRoutingSchema,
          signal,
        });
      } catch (error) {
        if (error instanceof BbHttpError && [404, 503].includes(error.status))
          return null;
        throw error;
      }
    },
  });
  useEffect(() => {
    if (!enabled) return;
    return wsManager.onPluginSignal((event) => {
      if (
        event.pluginId === CODEX_POOL_PLUGIN_ID &&
        ["accounts-changed", "config-changed"].includes(event.channel)
      ) {
        void queryClient.invalidateQueries({
          queryKey: [CODEX_POOL_PLUGIN_ID, "codex-routing"],
        });
      }
    });
  }, [enabled, queryClient]);
  const mutation = useMutation({
    mutationFn: (accountId: string | null) =>
      sdk.plugins.callRpc({
        pluginId: CODEX_POOL_PLUGIN_ID,
        method: "codexRouting.setThread",
        input: { threadId, accountId },
        outputSchema: z.null(),
      }),
    onSuccess: (_result, accountId) => {
      queryClient.setQueryData<typeof routing.data>(key, (data) =>
        data == null ? data : { ...data, accountId },
      );
    },
  });
  return {
    routing: routing.data,
    changeAccount: mutation.mutate,
    changeAccountAsync: mutation.mutateAsync,
    saving: mutation.isPending,
    error: mutation.error?.message,
  };
}
