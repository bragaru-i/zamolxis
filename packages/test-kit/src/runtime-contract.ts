import type { NormalizedRunEventDto } from "@zamolxis/contracts";
import type { AgentRuntime, StartRunInput } from "@zamolxis/runtime-core";
import { describe, expect, it } from "vitest";

export interface RuntimeContractHarness {
  create(): AgentRuntime;
  input(): StartRunInput;
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
