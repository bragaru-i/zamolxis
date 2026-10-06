import { expect, it } from "vitest";
import { groupByRecency, recencyGroup, relativeTime } from "./time";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// A fixed local afternoon so "today" starts a known number of hours earlier.
const now = new Date(2026, 9, 6, 15, 0, 0).getTime();

it("groups by the viewer's calendar day", () => {
  expect(recencyGroup(now, now)).toBe("Today");
  expect(recencyGroup(now + HOUR, now)).toBe("Today");
  expect(recencyGroup(now - 14 * HOUR, now)).toBe("Today");
  expect(recencyGroup(now - 16 * HOUR, now)).toBe("Yesterday");
  expect(recencyGroup(now - 2 * DAY, now)).toBe("Previous 7 days");
  expect(recencyGroup(now - 10 * DAY, now)).toBe("Previous 30 days");
  expect(recencyGroup(now - 40 * DAY, now)).toBe("Older");
});

it("keeps the newest-first order and merges neighbours into one group", () => {
  const items = [
    { id: "a", at: now - HOUR },
    { id: "b", at: now - 2 * HOUR },
    { id: "c", at: now - 3 * DAY },
    { id: "d", at: now - 60 * DAY },
  ];
  expect(groupByRecency(items, (item) => item.at, now)).toEqual([
    { label: "Today", items: [items[0], items[1]] },
    { label: "Previous 7 days", items: [items[2]] },
    { label: "Older", items: [items[3]] },
  ]);
  expect(groupByRecency([], () => 0, now)).toEqual([]);
});

it("keeps relative time short", () => {
  expect(relativeTime(now - 10_000, now)).toBe("just now");
  expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
  expect(relativeTime(now - 3 * HOUR, now)).toBe("3 h ago");
});
