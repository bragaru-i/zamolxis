import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assistantReply } from "./conversation";
import { failureReason, failureSummary, failureTime, RunFailure, runFailure } from "./failure";

const at = new Date(2026, 9, 7, 0, 13).getTime();

describe("failure details", () => {
  it("says who failed, on which runtime and model, and when", () => {
    expect(
      failureSummary(
        { who: "Supervisor", runtime: "claude", model: "claude-opus-5-5", at },
        at + 60_000,
      ),
    ).toBe("Supervisor · Claude · claude-opus-5-5 · failed at 00:13");
    expect(failureTime(at, at + 2 * 86_400_000)).toMatch(/Oct 7, 00:13/);
    expect(failureReason("Codex turn failed: Quota exceeded")).toBe("Quota exceeded");
    expect(failureReason("Codex turn failed")).toBeUndefined();
  });
  it("shows a failed Supervisor reply with its details", () => {
    const reply = assistantReply({
      planned: false,
      planTaskCount: 0,
      planStatus: "failed",
      planError: "SUPERVISOR_FAILED",
      planFailure: { agent: "supervisor", runtime: "claude", reason: "Session limit", at },
    });
    expect(reply).toMatchObject({
      kind: "error",
      failure: { who: "Supervisor", runtime: "claude", reason: "Session limit", at },
    });
  });
  it("shows a failed agent run only when it failed with a reported reason", () => {
    const run = {
      role: "builder",
      runtime: "codex",
      modelActual: "gpt-6.1-sol",
      status: "failed",
      failure: { code: "CODEX_TURN_FAILED", reason: "Codex turn failed: Quota exceeded", at },
    };
    expect(runFailure({ ...run, status: "completed" })).toBeUndefined();
    const html = renderToStaticMarkup(<RunFailure run={run} />);
    expect(html).toContain('aria-label="What failed"');
    expect(html).toContain("Builder · Codex · gpt-6.1-sol · failed at");
    expect(html).toContain("Reason: Quota exceeded");
  });
});
