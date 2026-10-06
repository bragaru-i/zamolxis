export function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(timestamp).toLocaleDateString();
}

const DAY = 24 * 60 * 60 * 1000;
export type RecencyGroup = "Today" | "Yesterday" | "Previous 7 days" | "Previous 30 days" | "Older";

/** Which sidebar group a timestamp falls in, by the viewer's local calendar day. */
export function recencyGroup(timestamp: number, now: number): RecencyGroup {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dayStart = today.getTime();
  if (timestamp >= dayStart) return "Today";
  if (timestamp >= dayStart - DAY) return "Yesterday";
  if (timestamp >= dayStart - 7 * DAY) return "Previous 7 days";
  if (timestamp >= dayStart - 30 * DAY) return "Previous 30 days";
  return "Older";
}

/** Groups items already sorted newest first; group order follows the items. */
export function groupByRecency<T>(
  items: readonly T[],
  at: (item: T) => number,
  now: number,
): Array<{ label: RecencyGroup; items: T[] }> {
  const groups: Array<{ label: RecencyGroup; items: T[] }> = [];
  for (const item of items) {
    const label = recencyGroup(at(item), now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}
