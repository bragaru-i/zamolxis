import {
  TRACE_DETAIL_LIMIT,
  TRACE_LABEL_LIMIT,
  TRACE_OUTPUT_TAIL_LIMIT,
  traceStepProblem,
} from "@zamolxis/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStateStore } from "../persistence/local-state";
import { outputTail, type TraceBatch, TraceRecorder, traceStep } from "./recorder";
import { checkStep, runtimeStep } from "./steps";

const stores: LocalStateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function recorder(scope = "command") {
  const store = new LocalStateStore(":memory:");
  stores.push(store);
  return { store, trace: new TraceRecorder(store, "run", scope) };
}
const step = (stepId: string, extra: Partial<Parameters<typeof traceStep>[0]> = {}) => ({
  stepId,
  kind: "workspace" as const,
  label: stepId,
  status: "passed" as const,
  startedAt: 1000,
  finishedAt: 1001,
  ...extra,
});
function batches(store: LocalStateStore) {
  return store.listPendingEvents().map((event) => ({
    eventId: event.eventId,
    payload: event.payload as TraceBatch,
  }));
}

describe("TraceRecorder", () => {
  it("writes steps to the outbox in recording order under stable event ids", () => {
    const { store, trace } = recorder();
    expect(trace.persist()).toBe(false);
    trace.record(step("a"));
    trace.record(step("b"));
    expect(trace.persist()).toBe(true);
    trace.record(step("c"));
    trace.persist();
    const written = batches(store);
    expect(written.map((batch) => batch.eventId)).toEqual([
      "trace:command:0000",
      "trace:command:0001",
    ]);
    expect(written.map((batch) => batch.payload.steps.map((s) => s.stepId))).toEqual([
      ["a", "b"],
      ["c"],
    ]);
    expect(written[0]?.payload).toMatchObject({ kind: "run.trace", runId: "run" });
    // Outbox events are idempotent: the same event id is written once.
    store.appendEvent({
      eventId: "trace:command:0000",
      type: "control-plane.delivery",
      payload: { kind: "run.trace", runId: "run", steps: [] },
      createdAt: 1,
    });
    expect(batches(store)).toEqual(written);
  });

  it("keeps one entry per step id and its original start time when it settles", () => {
    const { store, trace } = recorder();
    trace.record(runtimeStep("run", "codex", 500, "started"));
    trace.persist();
    trace.record(runtimeStep("run", "codex", 900, "completed"));
    trace.record(step("x"));
    trace.record(step("x", { status: "failed" }));
    trace.persist();
    const [first, second] = batches(store);
    expect(first?.payload.steps).toMatchObject([
      { stepId: "run:run:runtime", status: "started", startedAt: 500 },
    ]);
    expect(second?.payload.steps).toMatchObject([
      {
        stepId: "run:run:runtime",
        status: "passed",
        startedAt: 500,
        label: "Runtime codex completed",
      },
      { stepId: "x", status: "failed" },
    ]);
  });

  it("splits large step sets into bounded batches", () => {
    const { store, trace } = recorder();
    for (let index = 0; index < 150; index++) trace.record(step(`s${index}`));
    trace.persist();
    expect(batches(store).map((batch) => batch.payload.steps.length)).toEqual([100, 50]);
  });
});

describe("trace step bounds and redaction", () => {
  it("bounds labels, details and output tails", () => {
    const bounded = traceStep(
      step("s", { label: "l".repeat(500), detail: "detail ".repeat(1000) }),
    );
    expect(bounded.label.length).toBe(TRACE_LABEL_LIMIT);
    expect(bounded.detail?.length).toBe(TRACE_DETAIL_LIMIT);
    const output = `${"head ".repeat(400)}THE END`;
    const tail = traceStep(step("o", { output })).detail ?? "";
    expect(tail.length).toBe(TRACE_OUTPUT_TAIL_LIMIT);
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("THE END")).toBe(true);
    expect(outputTail("   \n")).toBeUndefined();
    expect(traceStepProblem(bounded)).toBeUndefined();
  });

  it("redacts secrets in labels, details and output", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const redacted = traceStep(
      step("r", {
        label: `curl -H "Authorization: Bearer ${secret}"`,
        detail: `GITHUB_TOKEN=${secret} pnpm test`,
      }),
    );
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(redacted.detail).toContain("GITHUB_TOKEN=***");
    const check = traceStep(
      checkStep("c", 0, {
        command: "pnpm run test",
        script: "test",
        result: "failed",
        exitCode: 1,
        startedAt: 10,
        finishedAt: 20,
        // A secret at the very end of a long output stays redacted after the cut.
        output: `${"x".repeat(5000)}\npassword=hunter2hunter2`,
      }),
    );
    expect(check.detail).toContain("password=***");
    expect(check.detail).not.toContain("hunter2");
    expect(check).toMatchObject({ references: { script: "test", exitCode: 1 } });
  });

  it("drops references that would not validate instead of failing the batch", () => {
    const normalized = traceStep(
      step("refs", {
        references: { sha: "not-a-sha", script: "rm -rf /", exitCode: 1.5, runId: "run" },
      }),
    );
    expect(normalized.references).toEqual({ runId: "run" });
    expect(traceStepProblem(normalized)).toBeUndefined();
    expect(() => traceStep(step(""))).toThrow("INVALID_TRACE_STEP_ID");
  });
});
