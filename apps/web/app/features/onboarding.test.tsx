import { getFunctionName } from "convex/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) =>
    args === "skip" ? undefined : state.data[getFunctionName(reference)],
}));

import {
  currentSteps,
  OnboardingCard,
  OnboardingChecklist,
  type OnboardingProgress,
} from "./onboarding";

const NOW = 1_000_000;
const progress = (overrides: Partial<OnboardingProgress> = {}): OnboardingProgress => ({
  complete: false,
  steps: [
    { id: "signin", title: "Sign in", state: "done", detail: "You are signed in." },
    { id: "access", title: "Access approved", state: "done", detail: "Your account has access." },
    { id: "pair", title: "Pair your Mac", state: "done", detail: "Studio is paired." },
    {
      id: "repositories",
      title: "Choose repositories",
      state: "in_progress",
      detail: "1 repository registered. Studio checks them when Zamolxis starts.",
    },
    {
      id: "service",
      title: "Start Zamolxis on your Mac",
      state: "done",
      detail: "Studio is online.",
      staleAfter: NOW + 10_000,
      stale: {
        state: "failed",
        detail:
          "Studio is offline. Open Terminal on your Mac and run `pnpm zamolxis setup --repair`.",
      },
    },
    {
      id: "runtime",
      title: "Agent runtime ready",
      state: "failed",
      detail:
        "No agent runtime is available on Studio. Install and sign in to Codex or Claude Code, then run `pnpm zamolxis setup --repair`.",
    },
    { id: "session", title: "Start your first session", state: "upcoming", detail: "" },
  ],
  ...overrides,
});
const render = (value: OnboardingProgress, now = NOW) =>
  renderToStaticMarkup(createElement(OnboardingCard, { progress: value, now, onHide: () => {} }));

beforeEach(() => {
  state.data = {};
});

describe("onboarding checklist", () => {
  it("shows every step with its state spelled out and commands as code", () => {
    const html = render(progress());
    expect(html).toContain("Get started");
    expect(html).toContain("4 of 7 done");
    for (const label of ["Done", "In progress", "Failed", "Not yet"]) expect(html).toContain(label);
    expect(html).toContain("Codex or Claude Code");
    expect(html).toContain("<code>pnpm zamolxis setup --repair</code>");
    expect(html).toContain("Hide checklist");
    expect(html).not.toContain("`");
  });

  it("marks the Mac offline once its last heartbeat is too old", () => {
    expect(currentSteps(progress(), NOW).find((step) => step.id === "service")?.state).toBe("done");
    const later = currentSteps(progress(), NOW + 20_000).find((step) => step.id === "service");
    expect(later?.state).toBe("failed");
    expect(later?.detail).toContain("is offline");
    const html = render(progress(), NOW + 20_000);
    expect(html).toContain("Studio is offline");
    expect(html).toContain("3 of 7 done");
  });

  it("asks the owner for action with a distinct label", () => {
    const value = progress();
    value.steps[2] = {
      id: "pair",
      title: "Pair your Mac",
      state: "needs_you",
      detail: "Run `pnpm zamolxis setup` on your Mac, then scan the QR code it shows.",
    };
    const html = render(value);
    expect(html).toContain("Needs you");
    expect(html).toContain("z-tone-warning");
    expect(html).toContain("<code>pnpm zamolxis setup</code>");
  });

  it("renders nothing before progress arrives, once a session exists, or before storage is read", () => {
    const checklist = () =>
      renderToStaticMarkup(createElement(OnboardingChecklist, { ready: true }));
    expect(checklist()).toBe("");
    state.data["onboarding:progress"] = progress({ complete: true });
    expect(checklist()).toBe("");
    // Server markup stays empty: the dismissal lives in browser storage.
    state.data["onboarding:progress"] = progress();
    expect(checklist()).toBe("");
  });
});
