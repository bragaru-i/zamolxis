import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Id } from "../../../../convex/_generated/dataModel";

vi.mock("convex/react", () => ({ useMutation: () => vi.fn(), useQuery: () => [] }));

import { ApprovalCard, type PendingApproval } from "./approvals";

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
