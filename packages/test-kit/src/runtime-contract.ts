import type { NormalizedRunEventDto } from "@zamolxis/contracts";
import type { AgentRuntime, StartRunInput } from "@zamolxis/runtime-core";
import { describe, expect, it } from "vitest";

export interface RuntimeContractHarness {
  create(): AgentRuntime;
  input(): StartRunInput;
}
export interface RuntimeApprovalHarness extends RuntimeContractHarness {
  // Makes the started session request exactly one approval.
  requestApproval(runtime: AgentRuntime, nativeSessionId: string): Promise<void>;
}
async function readUntil(
  runtime: AgentRuntime,
  nativeSessionId: string,
  done: (event: NormalizedRunEventDto) => boolean,
): Promise<NormalizedRunEventDto[]> {
  const events: NormalizedRunEventDto[] = [];
  for await (const event of runtime.subscribe({ nativeSessionId })) {
    events.push(event);
    if (done(event)) return events;
  }
  return events;
}
/** Shared semantics for adapters that hold operations for human approval. */
export function defineRuntimeApprovalContract(name: string, harness: RuntimeApprovalHarness): void {
  describe(`${name} approval contract`, () => {
    const requested = async (runtime: AgentRuntime) => {
      const session = await runtime.start(harness.input());
      await harness.requestApproval(runtime, session.nativeSessionId);
      const events = await readUntil(
        runtime,
        session.nativeSessionId,
        (event) => event.type === "approval.requested",
      );
      const event = events.at(-1);
      if (event?.type !== "approval.requested") throw new Error("approval not requested");
      return { session, event };
    };
    it("holds the operation until a human approves it, once", async () => {
      const runtime = harness.create();
      expect(runtime.capabilities().canApprove).toBe(true);
      const { session, event } = await requested(runtime);
      expect(event.payload.approvalId.length).toBeGreaterThan(0);
      expect(event.payload.approvalId.length).toBeLessThanOrEqual(256);
      expect(event.payload.summary.length).toBeLessThanOrEqual(2000);
      expect(["command", "fileChange", "tool", "other"]).toContain(event.payload.kind);
      expect(["low", "medium", "high", "critical"]).toContain(event.payload.risk);
      expect(event.runId).toBe(harness.input().runId);
      const snapshot = await runtime.inspect(session.nativeSessionId);
      expect(["completed", "failed", "stopped"]).not.toContain(snapshot.state);
      await expect(
        runtime.resolveApproval?.({
          nativeSessionId: session.nativeSessionId,
          approvalId: "unknown",
          decision: "approve",
        }),
      ).rejects.toThrow("APPROVAL_NOT_PENDING");
      await runtime.resolveApproval?.({
        nativeSessionId: session.nativeSessionId,
        approvalId: event.payload.approvalId,
        decision: "approve",
      });
      const after = await readUntil(
        runtime,
        session.nativeSessionId,
        (item) => item.type === "approval.resolved",
      );
      expect(after.at(-1)?.payload).toEqual({
        approvalId: event.payload.approvalId,
        decision: "approved",
        reason: "user",
      });
      await expect(
        runtime.resolveApproval?.({
          nativeSessionId: session.nativeSessionId,
          approvalId: event.payload.approvalId,
          decision: "reject",
        }),
      ).rejects.toThrow("APPROVAL_NOT_PENDING");
      await runtime.stop({ nativeSessionId: session.nativeSessionId });
    });
    it("rejects pending approvals before reporting a stop", async () => {
      const runtime = harness.create();
      const { session, event } = await requested(runtime);
      await runtime.stop({ nativeSessionId: session.nativeSessionId });
      const events = await readUntil(runtime, session.nativeSessionId, (item) =>
        ["run.stopped", "run.completed", "run.failed"].includes(item.type),
      );
      const resolved = events.findIndex((item) => item.type === "approval.resolved");
      expect(events[resolved]?.payload).toEqual({
        approvalId: event.payload.approvalId,
        decision: "rejected",
        reason: "stopped",
      });
      expect(resolved).toBeLessThan(events.length - 1);
      await expect(
        runtime.resolveApproval?.({
          nativeSessionId: session.nativeSessionId,
          approvalId: event.payload.approvalId,
          decision: "approve",
        }),
      ).rejects.toThrow();
    });
  });
}
export function defineRuntimeAdapterContract(name: string, harness: RuntimeContractHarness): void {
  describe(`${name} shared runtime adapter contract`, () => {
    it("advertises its identity and executes only the supplied assignment", async () => {
      const runtime = harness.create();
      const input = harness.input();
      expect(runtime.capabilities().runtime).toBe(runtime.id);
      expect(runtime.capabilities().canStart).toBe(true);
      const started = await runtime.start(input);
      expect(started.workspace).toEqual(input.workspace);
      expect(started.runId).toBe(input.runId);
      expect((await runtime.inspect(started.nativeSessionId)).workspace).toEqual(input.workspace);
    });
    it("deduplicates start and replays stable, ordered event identities", async () => {
      const runtime = harness.create();
      const input = harness.input();
      const a = await runtime.start(input);
      const b = await runtime.start(input);
      expect(b.nativeSessionId).toBe(a.nativeSessionId);
      const collect = async (cursor = 0) => {
        const result: NormalizedRunEventDto[] = [];
        for await (const event of runtime.subscribe({
          nativeSessionId: a.nativeSessionId,
          afterSequence: cursor,
        })) {
          result.push(event);
          if (["run.completed", "run.failed", "run.stopped", "run.waiting"].includes(event.type))
            break;
        }
        return result;
      };
      const events = await collect();
      expect(events.length).toBeGreaterThan(0);
      expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
      expect(events.map((event) => event.sequence)).toEqual(
        [...events].map((event) => event.sequence).sort((a, b) => a - b),
      );
      expect(
        events.every(
          (event) =>
            event.runId === input.runId &&
            event.workspaceId === input.workspace.workspaceId &&
            event.workstationId === input.workstationId,
        ),
      ).toBe(true);
      expect(await collect()).toEqual(events);
      expect(await collect(events[0]?.sequence)).toEqual(events.slice(1));
    });
    it("rejects retries or resume against a different workspace", async () => {
      const runtime = harness.create();
      const input = harness.input();
      const session = await runtime.start(input);
      const other = {
        ...input,
        workspace: { ...input.workspace, cwd: `${input.workspace.cwd}/wrong` },
      };
      await expect(runtime.start(other)).rejects.toThrow();
      if (runtime.capabilities().canResume)
        await expect(
          runtime.resume({ ...other, nativeSessionId: session.nativeSessionId }),
        ).rejects.toThrow();
    });
  });
}
export interface RuntimeResumeHarness {
  /** A new runtime process that shares the native state of earlier ones (a restart). */
  create(): AgentRuntime;
  input(): StartRunInput;
  /** Makes the started session hold exactly one approval while its turn is in flight. */
  requestApproval(runtime: AgentRuntime, nativeSessionId: string): Promise<void>;
}
/**
 * Resume after a restart: a new runtime process reattaches to the native session, continues
 * event sequences after the Node's cursor (no duplicates, original provenance), withdraws
 * approvals that died with the old process (never approving them), and settles or
 * continues the interrupted turn exactly as asked. It never starts the run again.
 */
export function defineRuntimeResumeContract(name: string, harness: RuntimeResumeHarness): void {
  describe(`${name} resume contract`, () => {
    // Starts a run that holds an approval, as the old process saw it before it ended.
    const interrupted = async () => {
      const before = harness.create();
      const input = harness.input();
      const session = await before.start(input);
      await harness.requestApproval(before, session.nativeSessionId);
      const events = await readUntil(
        before,
        session.nativeSessionId,
        (event) => event.type === "approval.requested",
      );
      const requested = events.at(-1);
      if (requested?.type !== "approval.requested") throw new Error("approval not requested");
      return { input, session, events, approvalId: requested.payload.approvalId };
    };
    it("continues after the Node's cursor in a new process and withdraws held approvals", async () => {
      const { input, session, events, approvalId } = await interrupted();
      const cursor = events.at(-1)?.sequence ?? 0;
      const after = harness.create();
      expect(after.capabilities().canResume).toBe(true);
      const resumed = await after.resume({
        ...input,
        nativeSessionId: session.nativeSessionId,
        afterSequence: cursor,
        pendingApprovalIds: [approvalId],
        interrupted: "continue",
      });
      expect(resumed.nativeSessionId).toBe(session.nativeSessionId);
      expect(resumed.runId).toBe(input.runId);
      expect(resumed.workspace).toEqual(input.workspace);
      const next = await readUntil(
        after,
        session.nativeSessionId,
        (event) => event.type === "approval.requested",
      );
      expect(next[0]?.sequence).toBe(cursor + 1);
      expect(next.map((event) => event.sequence)).toEqual(
        next.map((_, index) => cursor + index + 1),
      );
      expect(next[0]?.type).toBe("approval.resolved");
      expect(next[0]?.payload).toEqual({ approvalId, decision: "rejected", reason: "withdrawn" });
      const ids = new Set(events.map((event) => event.eventId));
      expect(next.some((event) => ids.has(event.eventId))).toBe(false);
      for (const event of next) {
        expect(event.runId).toBe(input.runId);
        expect(event.workspaceId).toBe(input.workspace.workspaceId);
        expect(event.workstationId).toBe(input.workstationId);
      }
      // The agent asks again under a new identity.
      const asked = next.at(-1);
      expect(asked?.type).toBe("approval.requested");
      if (asked?.type === "approval.requested")
        expect(asked.payload.approvalId).not.toBe(approvalId);
      // Resuming an attached session again changes nothing.
      const again = await after.resume({
        ...input,
        nativeSessionId: session.nativeSessionId,
        afterSequence: cursor,
        pendingApprovalIds: [approvalId],
        interrupted: "continue",
      });
      expect(again.lastSequence).toBe((await after.inspect(session.nativeSessionId)).lastSequence);
      await after.stop({ nativeSessionId: session.nativeSessionId });
    });
    it("announces the run, then fails or stops an interrupted turn instead of continuing it", async () => {
      for (const [policy, terminal] of [
        ["fail", "run.failed"],
        ["stop", "run.stopped"],
      ] as const) {
        const { input, session, approvalId } = await interrupted();
        const after = harness.create();
        const resumed = await after.resume({
          ...input,
          nativeSessionId: session.nativeSessionId,
          announce: true,
          pendingApprovalIds: [approvalId],
          interrupted: policy,
        });
        expect(resumed.state).toBe(policy === "fail" ? "failed" : "stopped");
        const events: NormalizedRunEventDto[] = [];
        for await (const event of after.subscribe({ nativeSessionId: session.nativeSessionId }))
          events.push(event);
        // Usage and activity reports are informational and may appear in between.
        expect(
          events
            .map((event) => event.type)
            .filter((type) => type !== "run.usage" && type !== "run.activity"),
        ).toEqual(["run.started", "approval.resolved", terminal]);
        expect(events[0]?.sequence).toBe(1);
        await expect(
          after.resolveApproval?.({
            nativeSessionId: session.nativeSessionId,
            approvalId,
            decision: "approve",
          }),
        ).rejects.toThrow();
      }
    });
    it("never resumes an unknown session or another workspace", async () => {
      const { input, session } = await interrupted();
      const after = harness.create();
      await expect(after.resume({ ...input, nativeSessionId: "unknown-native" })).rejects.toThrow();
      await expect(
        after.resume({
          ...input,
          workspace: { ...input.workspace, cwd: `${input.workspace.cwd}/wrong` },
          nativeSessionId: session.nativeSessionId,
        }),
      ).rejects.toThrow();
    });
  });
}
