import { afterEach, expect, it, vi } from "vitest";
import { retryDelay, Wake } from "./wake";

afterEach(() => vi.useRealTimers());

it("wakes every waiting loop at once, and otherwise after the timeout", async () => {
  vi.useFakeTimers();
  const wake = new Wake();
  const order: string[] = [];
  const first = wake.wait(120_000).then(() => order.push("first"));
  const second = wake.wait(120_000).then(() => order.push("second"));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(order).toEqual([]);
  expect(wake.lastWakeAt).toBe(0);
  wake.wake();
  expect(wake.lastWakeAt).toBe(Date.now());
  await Promise.all([first, second]);
  expect(order).toEqual(["first", "second"]);
  const late = wake.wait(5_000).then(() => order.push("timeout"));
  await vi.advanceTimersByTimeAsync(5_000);
  await late;
  expect(order).toEqual(["first", "second", "timeout"]);
  wake.wake(); // nobody waiting: nothing happens
});

it("backs off between start attempts up to 10 minutes", () => {
  expect([0, 1, 2, 3, 6, 20].map(retryDelay)).toEqual([
    15_000, 30_000, 60_000, 120_000, 600_000, 600_000,
  ]);
});
