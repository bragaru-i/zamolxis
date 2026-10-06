import type { Doc } from "../_generated/dataModel";

/** A Node that has not reported for this long is treated as offline. */
export const HEARTBEAT_FRESH_MS = 45_000;

/** Whether the Node on this computer is online and reporting right now. */
export function deviceOnline(device: Doc<"workstations">, now = Date.now()): boolean {
  return device.status === "online" && (device.lastHeartbeatAt ?? 0) > now - HEARTBEAT_FRESH_MS;
}
