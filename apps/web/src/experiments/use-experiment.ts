import { useExperimentBootstrap } from "./context";
import {
  experimentVariant,
  type ExperimentBootstrap,
  type ExperimentKey,
  type ExperimentVariant,
} from "./flags";

export { RouteExperimentsProvider } from "./context";

export function experimentsBeforeLoad({
  serverContext,
}: {
  serverContext?: { experiments: ExperimentBootstrap };
}): { experiments: ExperimentBootstrap } | undefined {
  return serverContext === undefined
    ? undefined
    : { experiments: serverContext.experiments };
}

export function useExperiment<K extends ExperimentKey>(
  key: K,
): ExperimentVariant<K> {
  return experimentVariant(useExperimentBootstrap(), key);
}
