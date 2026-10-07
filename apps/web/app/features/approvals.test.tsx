import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Id } from "../../../../convex/_generated/dataModel";

const state = vi.hoisted(() => ({ pending: [] as unknown[] }));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (_reference: unknown, args: unknown) => (args === "skip" ? undefined : state.pending),
}));

import {
  ApprovalCard,
  ApprovalStatusBadge,
  ApprovalToasts,
  matchesFocus,
  type PendingApproval,
  showApprovals,
} from "./approvals";

const approval = (overrides: Partial<PendingApproval> = {}): PendingApproval => ({
  _id: "approval" as Id<"approvals">,
  workSessionId: "session" as Id<"workSessions">,
  action: "command",
  risk: "medium",
  request: { kind: "command", summary: "Run: node scripts/preview-brand.mjs access" },
  requestedAt: 1,
  ...overrides,
});

it("offers run-scoped approval only when the runtime allows it", () => {
  const scoped = renderToStaticMarkup(
    createElement(ApprovalCard, {
      approval: approval({
        request: {
          kind: "command",
          summary: "Run: node scripts/preview-brand.mjs access",
          allowForSession: true,
        },
      }),
    }),
  );
  expect(scoped).toContain("Approve once");
  expect(scoped).toContain("Approve for run");
  expect(scoped).toContain("similar safe commands");

  const oneTime = renderToStaticMarkup(
    createElement(ApprovalCard, { approval: approval({ risk: "high" }) }),
  );
  expect(oneTime).toContain(">Approve<");
  expect(oneTime).not.toContain("Approve for run");
});

it("shows pending requests as toasts everywhere, the open session too, three at a time", () => {
  state.pending = [1, 2, 3, 4, 5].map((index) =>
    approval({
      _id: `a${index}` as Id<"approvals">,
      workSessionId: (index === 1 ? "open" : "other") as Id<"workSessions">,
      requestedAt: index,
      request: { kind: "command", summary: `Run: step ${index}` },
    }),
  );
  const html = renderToStaticMarkup(
    createElement(ApprovalToasts, { ready: true, onOpen: vi.fn() }),
  );
  expect(html).toContain('popover="manual"');
  expect(html).toContain('aria-label="Approvals waiting"');
  // The three oldest become toasts, whichever session is open.
  expect(html).toContain("Run: step 1");
  expect(html).toContain("Run: step 3");
  expect(html).not.toContain("Run: step 4");
  expect(html).toContain("2 more waiting");
  expect(html).toContain("Medium risk");
  expect(html).toContain(">Approve<");
  expect(html).toContain("Open session");
  expect(html).toContain('aria-label="Dismiss"');
  // Nothing pending: nothing rendered, no empty region.
  state.pending = [];
  expect(
    renderToStaticMarkup(createElement(ApprovalToasts, { ready: true, onOpen: vi.fn() })),
  ).toBe("");
});

it("makes a Needs approval chip bring up that run's request", () => {
  const chip = renderToStaticMarkup(
    createElement(ApprovalStatusBadge, { status: "needs_approval", runId: "r1" }),
  );
  expect(chip).toContain("<button");
  expect(chip).toContain("Needs approval ›");
  expect(
    renderToStaticMarkup(createElement(ApprovalStatusBadge, { status: "running", runId: "r1" })),
  ).not.toContain("<button");
  const request = approval({
    runId: "r1" as Id<"agentRuns">,
    workSessionId: "s1" as Id<"workSessions">,
  });
  expect(matchesFocus(request, { runId: "r1" })).toBe(true);
  expect(matchesFocus(request, { runId: "r2" })).toBe(false);
  expect(matchesFocus(request, { workSessionId: "s1" })).toBe(true);
  // Without a mounted toast stack the call is a harmless no-op.
  expect(() => showApprovals({ runId: "r1" })).not.toThrow();
});
