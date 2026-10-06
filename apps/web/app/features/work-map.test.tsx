import { getFunctionName } from "convex/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) =>
    args === "skip"
      ? undefined
      : getFunctionName(reference) === "agentProfiles:list"
        ? []
        : undefined,
}));

import {
  currentStep,
  type MapRun,
  stepAgent,
  TaskProgress,
  taskProcess,
  WorkMap,
  workSteps,
} from "./work-map";

const run = (role: string, status: string, extra: Partial<MapRun> = {}): MapRun => ({
  role,
  status,
  runtime: "codex",
  _creationTime: 1,
  ...extra,
});
const states = (input: Parameters<typeof workSteps>[0]) =>
  Object.fromEntries(workSteps(input).map((step) => [step.key, `${step.state}: ${step.detail}`]));

it("shows planning before any task exists", () => {
  expect(states({ sessionStatus: "planning", tasks: [], runs: [] })).toMatchObject({
    plan: "active: Reading the repository and planning",
    build: "waiting: Starts after the plan",
    fix: "waiting: Only if a check fails",
  });
});

it("follows builders, the verifier and repairs as tasks move", () => {
  const building = states({
    sessionStatus: "running",
    tasks: [
      { phase: "building", status: "running" },
      { phase: "verifying", status: "running" },
      { phase: "ready_for_integration", status: "completed" },
    ],
    runs: [run("builder", "running"), run("verifier", "running"), run("builder", "completed")],
  });
  expect(building).toEqual({
    plan: "done: 3 tasks planned",
    build: "active: 1 agent writing code · 2 of 3 done",
    check: "active: Checking 1 result",
    fix: "skipped: Not needed so far",
    ready: "active: 1 of 3 ready",
  });

  const failed = states({
    sessionStatus: "running",
    tasks: [{ phase: "trust_failed", status: "running" }],
    runs: [run("builder", "completed"), run("verifier", "completed")],
  });
  expect(failed.check).toBe("attention: 1 result did not pass");

  const repairing = states({
    sessionStatus: "running",
    tasks: [{ phase: "repairing", status: "running" }],
    runs: [run("verifier", "completed"), run("repair", "running")],
  });
  expect(repairing.fix).toBe("active: Fixing 1 result");
});

it("says when everything is done and names the step that needs attention first", () => {
  const steps = workSteps({
    sessionStatus: "completed",
    tasks: [{ phase: "completed", status: "completed" }],
    runs: [run("builder", "completed"), run("verifier", "completed")],
  });
  expect(steps.map((step) => step.state)).toEqual(["done", "done", "done", "skipped", "done"]);
  expect(currentStep(steps)?.key).toBe("ready");
  const blocked = workSteps({
    sessionStatus: "running",
    tasks: [{ phase: "needs_input", status: "running" }],
    runs: [run("verifier", "running")],
  });
  expect(currentStep(blocked)?.key).toBe("build");
});

it("names the agent that did a step, else the one that would do it", () => {
  const runs = [
    run("verifier", "completed", {
      runtime: "claude",
      modelActual: "claude-sonnet-5-5",
      _creationTime: 1,
    }),
    run("verifier", "running", {
      runtime: "codex",
      modelRequested: "gpt-5.1-codex",
      _creationTime: 2,
    }),
  ];
  expect(stepAgent("verifier", runs, {})).toBe("Codex · gpt-5.1-codex");
  expect(stepAgent("repair", runs, {})).toBe("Codex · default model");
  expect(
    stepAgent("repair", [], {
      global: [
        {
          _id: "p" as never,
          name: "Repair",
          role: "repair",
          runtime: "claude",
          model: "claude-opus-5-5",
          enabled: true,
          updatedAt: 1,
        },
      ],
    }),
  ).toBe("Claude · claude-opus-5-5");
});

it("renders every step with its agent and a summary of now", () => {
  const html = renderToStaticMarkup(
    createElement(WorkMap, {
      ready: true,
      productId: undefined,
      sessionStatus: "running",
      tasks: [{ phase: "building", status: "running" }],
      runs: [run("builder", "running", { modelRequested: "gpt-5.1-codex" })],
    }),
  );
  for (const title of ["Plan", "Build", "Check", "Fix", "Ready"]) expect(html).toContain(title);
  expect(html).toContain("Builder");
  expect(html).toContain("Codex · gpt-5.1-codex");
  expect(html).toMatch(/<strong>Build<\/strong> · 1 agent writing code/);
});

it("colors tasks by process and renders their compact progress track", () => {
  expect(taskProcess({ phase: "building", status: "running" })).toBe("build");
  expect(taskProcess({ phase: "verifying", status: "running" })).toBe("check");
  expect(taskProcess({ phase: "repairing", status: "running" })).toBe("fix");
  expect(taskProcess({ phase: "completed", status: "completed" })).toBe("ready");
  expect(taskProcess({ phase: "queued", status: "waiting" })).toBe("queued");

  const html = renderToStaticMarkup(
    createElement(TaskProgress, {
      sessionStatus: "running",
      task: { phase: "verifying", status: "running" },
      runs: [run("builder", "completed"), run("verifier", "running")],
    }),
  );
  expect(html).toContain('aria-label="Task progress"');
  expect(html).toContain('aria-label="Build: Done"');
  expect(html).toContain('aria-label="Check: Working"');
  expect(html).toContain('aria-label="Fix: Skipped"');
  expect(html).toContain('aria-label="Ready: Not yet"');
});
