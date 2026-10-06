import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import { refreshSession } from "../convex/lib/lifecycle";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
};

async function sessionWithTasks(
  reopenedAt: number | undefined,
  tasks: Array<{ createdAt: number; status: "completed" | "failed" | "running" }>,
) {
  const t = convexTest(schema, modules);
  const { userId } = await seedHuman(t, "alice");
  const sessionId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("workSessions", {
      ownerId: userId as Id<"users">,
      title: "Reopened",
      goal: "Reopened",
      status: "running",
      activeRunCount: 0,
      completedTaskCount: 0,
      totalTaskCount: tasks.length,
      needsInputCount: 0,
      createdAt: 1,
      updatedAt: 1,
      lastActivityAt: 1,
      ...(reopenedAt !== undefined ? { reopenedAt } : {}),
    });
    for (const [index, task] of tasks.entries())
      await ctx.db.insert("tasks", {
        workSessionId: id,
        title: `Task ${index}`,
        description: "",
        kind: "implementation",
        status: task.status,
        phase: task.status === "running" ? "building" : task.status,
        runtimePolicyMode: "auto",
        priority: 1,
        createdAt: task.createdAt,
        updatedAt: task.createdAt,
      });
    return id;
  });
  await t.run((ctx) => refreshSession(ctx, sessionId));
  return t.run((ctx) => ctx.db.get("workSessions", sessionId));
}

it("judges a reopened Session only by work planned since it reopened", async () => {
  const reopened = await sessionWithTasks(100, [
    { createdAt: 10, status: "failed" },
    { createdAt: 200, status: "completed" },
  ]);
  expect(reopened?.status).toBe("completed");
  expect(reopened?.completedAt).toBeDefined();
  expect(reopened?.completedTaskCount).toBe(1);

  const newFailure = await sessionWithTasks(100, [
    { createdAt: 10, status: "completed" },
    { createdAt: 200, status: "failed" },
  ]);
  expect(newFailure?.status).toBe("failed");

  const notReopened = await sessionWithTasks(undefined, [
    { createdAt: 10, status: "failed" },
    { createdAt: 200, status: "completed" },
  ]);
  expect(notReopened?.status).toBe("failed");

  const nothingNew = await sessionWithTasks(100, [{ createdAt: 10, status: "failed" }]);
  expect(nothingNew?.status).toBe("waiting");
});
