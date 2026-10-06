import { getFunctionName } from "convex/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) =>
    args === "skip" ? undefined : state.data[getFunctionName(reference)],
}));
vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signOut: vi.fn() }) }));

import type { Profile } from "./agents";
import type { Device } from "./macs";
import { pageSummary, SETTINGS_PAGES, Settings } from "./settings";

const NOW = 1_000_000;
const mac = (overrides: Partial<Device> = {}): Device => ({
  _id: "w1" as Device["_id"],
  name: "Studio",
  status: "online",
  lastHeartbeatAt: NOW - 1000,
  runtimes: [{ runtime: "codex", status: "available" }],
  ...overrides,
});
const profile = (overrides: Partial<Profile>): Profile => ({
  _id: "p1" as Profile["_id"],
  name: "Builder",
  role: "builder",
  runtime: "codex",
  enabled: true,
  updatedAt: 1,
  ...overrides,
});

beforeEach(() => {
  state.data = {};
});

it("orders pages by how often the owner needs them", () => {
  expect(SETTINGS_PAGES.map((page) => page.title)).toEqual([
    "Agents",
    "Macs & repositories",
    "Usage",
    "Storage",
    "People & devices",
  ]);
});

it("summarizes each page's current state in one line", () => {
  expect(pageSummary("agents", { now: NOW, profiles: [] })).toBe(
    "Builder: Codex · default model · all on defaults",
  );
  expect(
    pageSummary("agents", {
      now: NOW,
      profiles: [
        profile({ model: "gpt-5.1-codex" }),
        profile({ role: "verifier", enabled: false }),
      ],
    }),
  ).toBe("Builder: Codex · gpt-5.1-codex · 1 of 6 customized");
  expect(pageSummary("macs", { now: NOW, devices: [] })).toBe("No Mac paired yet");
  expect(pageSummary("macs", { now: NOW, devices: [mac()] })).toBe("Studio · online");
  expect(pageSummary("macs", { now: NOW, devices: [mac({ lastHeartbeatAt: 0 })] })).toBe(
    "Studio · offline",
  );
  expect(
    pageSummary("macs", {
      now: NOW,
      devices: [mac(), mac({ _id: "w2" as Device["_id"], status: "offline" })],
    }),
  ).toBe("2 Macs · 1 online");
  const total = { items: 3, reported: true, totalTokens: 48_000 };
  expect(pageSummary("usage", { now: NOW, usage: { total, sessionCount: 2 } as never })).toContain(
    "tokens in the last 7 days",
  );
  expect(
    pageSummary("usage", {
      now: NOW,
      usage: { total: { ...total, items: 0 }, sessionCount: 0 } as never,
    }),
  ).toBe("No agent work in the last 7 days");
  expect(
    pageSummary("storage", {
      now: NOW,
      storage: { retentionDays: 7, macs: [{ eligible: 2 }, { eligible: 1 }] } as never,
    }),
  ).toBe("Keeps finished work 7 days · 3 ready to clean up");
  // Without data the menu falls back to the page's description.
  expect(pageSummary("agents", { now: NOW })).toBeUndefined();
  expect(pageSummary("access", { now: NOW })).toBeUndefined();
});

const render = (page: Parameters<typeof Settings>[0]["page"]) =>
  renderToStaticMarkup(
    createElement(Settings, {
      open: true,
      page,
      onPage: vi.fn(),
      onClose: vi.fn(),
      devices: [mac()],
      now: NOW,
      onOpenSession: vi.fn(),
    }),
  );

it("shows the menu on a phone, with live summaries and sign out last", () => {
  state.data = { "agentProfiles:list": [] };
  const html = render("");
  expect(html).toContain('aria-label="Settings sections"');
  expect(html).toContain("Studio · online");
  expect(html).toContain("Builder: Codex · default model · all on defaults");
  expect(html).toContain("Who can use Zamolxis");
  expect(html.indexOf("People &amp; devices")).toBeLessThan(html.indexOf("Sign out"));
  // Only the menu: no page is open yet.
  expect(html).not.toContain("z-settings__page");
});

it("shows one page with a way back to the menu", () => {
  const html = render("macs");
  expect(html).toContain("Back to Settings");
  expect(html).toContain("Macs &amp; repositories");
  expect(html).toContain("Remove this Mac…");
  expect(html).not.toContain('aria-label="Settings sections"');
});
