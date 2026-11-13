import { useState } from "react";
import type { ExperimentalThreadContextSegmentInput } from "@get-bb/plugin-sdk";
import {
  ThreadContextSegmentMount,
  threadContextSegmentKey,
  useThreadContextSegments,
} from "./PluginThreadContextSegments";

export function PluginTimelineEndSegments(
  input: ExperimentalThreadContextSegmentInput,
) {
  const { entries, observers } = useThreadContextSegments(input, []);
  const [expanded, setExpanded] = useState<string | null>(null);
  const visible = entries.filter(
    ({ slot }) => slot.experimental_placement === "timeline-end",
  );
  const segments = visible.map(({ slot }) => ({
    key: threadContextSegmentKey(slot),
    pluginId: slot.pluginId,
  }));
  return (
    <>
      {observers}
      {visible.map((entry) => {
        const key = threadContextSegmentKey(entry.slot);
        const props = {
          ...input,
          entry,
          segments,
          isExpanded: expanded === key,
          onToggle: () => setExpanded((value) => (value === key ? null : key)),
        };
        return (
          <section
            key={key}
            aria-label={entry.slot.title}
            className="my-3 overflow-hidden rounded-xl border border-border bg-surface-raised"
          >
            <div className="flex items-center gap-3 p-3">
              <ThreadContextSegmentMount {...props} part="summary" />
              <ThreadContextSegmentMount {...props} part="action" />
            </div>
            <ThreadContextSegmentMount {...props} part="details" />
          </section>
        );
      })}
    </>
  );
}
