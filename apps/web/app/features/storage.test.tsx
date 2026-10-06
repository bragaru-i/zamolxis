import { getFunctionName } from "convex/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../../../convex/_generated/dataModel";

const state = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as Array<{ name: string; args: unknown }>,
}));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(reference);
    state.calls.push({ name, args });
    return args === "skip" ? undefined : state.data[name];
  },
}));

import { type MacStorage, plural, StorageSettings, type StorageSummary } from "./storage";

const NOW = Date.UTC(2026, 9, 6, 12);
function mac(overrides: Partial<MacStorage> = {}): MacStorage {
  return {
    workstationId: "w1" as Id<"workstations">,
    name: "Studio",
    online: true,
    managed: 42,
    eligible: 7,
    pending: 0,
    failed: 0,
    truncated: false,
    ...overrides,
  };
}
function summary(macs: MacStorage[], retentionDays = 3): StorageSummary {
  return {
    retentionDays,
    defaultRetentionDays: 3,
    minRetentionDays: 1,
    maxRetentionDays: 30,
    batch: 10,
    macs,
  };
}
const render = (active = true) =>
  renderToStaticMarkup(createElement(StorageSettings, { active, now: NOW }));

beforeEach(() => {
  state.data = {};
  state.calls = [];
});

describe("StorageSettings", () => {
  it("does not query while Settings is closed", () => {
    expect(render(false)).toContain("Loading storage");
    expect(state.calls[0]).toEqual({ name: "workspaces:storage", args: "skip" });
  });

  it("shows worktrees per computer, what can go now and the last cleanup", () => {
    state.data = {
      "workspaces:storage": summary([
        mac({ lastCleanupAt: NOW - 2 * 60 * 60 * 1000, pending: 2, failed: 1 }),
        mac({
          workstationId: "w2" as Id<"workstations">,
          name: "Laptop",
          online: false,
          managed: 300,
          truncated: true,
          eligible: 0,
        }),
      ]),
    };
    const html = render();
    expect(html).toContain("Studio");
    expect(html).toContain("Managed worktrees");
    expect(html).toContain("42");
    expect(html).toContain("Can be removed now");
    expect(html).toContain("Removal requested");
    expect(html).toContain("Kept after a failed removal");
    expect(html).toContain("2 h ago");
    expect(html).toContain("300+");
    expect(html).toContain("Offline");
    expect(html).toContain("Never");
    // One enabled button for the online computer with eligible worktrees, one disabled.
    expect(html.match(/Clean up now/g)).toHaveLength(2);
    expect(html.match(/disabled=""/g)).toHaveLength(1);
    expect(html).toContain("3 days (default)");
    expect(html).toContain("30 days");
    expect(html).toContain("Trusted work that was not published");
  });

  it("explains the empty state", () => {
    state.data = { "workspaces:storage": summary([], 1) };
    const html = render();
    expect(html).toContain("No computer paired yet.");
    expect(html).toMatch(/class="z-picker__value">1 day/);
  });

  it("pluralizes counts", () => {
    expect(plural(1, "worktree")).toBe("1 worktree");
    expect(plural(1200, "worktree")).toBe("1,200 worktrees");
  });
});
