import { randomUUID } from "node:crypto";
import type { CapabilityTrace } from "@zamolxis/contracts";
import type { LocalStateStore } from "../persistence/local-state";

export function capabilityTraceRecorder(store: LocalStateStore): (entry: CapabilityTrace) => void {
  return (entry) =>
    store.appendEvent({
      eventId: randomUUID(),
      type: "capability.resolved",
      createdAt: Date.now(),
      payload: entry,
    });
}
