import type { RepositoryContext } from "@zamolxis/contracts";
import { expect, it } from "vitest";
import { planWithRepositoryContext } from "./repository-planning";

const context: RepositoryContext = {
  repositoryId: "repo",
  workspaceId: "workspace",
  gitSha: "sha",
  snapshotDigest: "digest",
  instructions: [],
  skills: [],
  discoveredSources: [],
  conventions: [],
  resolvedCapabilities: {},
};
it("discovers and checks freshness before invoking the planner", async () => {
  const order: string[] = [];
  await planWithRepositoryContext(
    "workspace",
    {
      discover: () => {
        order.push("discovery");
        return context;
      },
      assertCurrent: () => {
        order.push("freshness");
      },
    },
    (input) => {
      order.push("planning");
      expect(input.context).toBe(context);
    },
  );
  expect(order).toEqual(["discovery", "freshness", "planning"]);
});
it("prevents planning from a stale repository snapshot", async () => {
  let planned = false;
  await expect(
    planWithRepositoryContext(
      "workspace",
      {
        discover: () => context,
        assertCurrent: () => {
          throw new Error("STALE");
        },
      },
      () => {
        planned = true;
      },
    ),
  ).rejects.toThrow("STALE");
  expect(planned).toBe(false);
});
