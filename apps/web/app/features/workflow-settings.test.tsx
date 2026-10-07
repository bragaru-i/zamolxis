import { describe, expect, it } from "vitest";
import { agentJobs, costOf, jobsText, runsHere } from "./workflow-settings";

const QWEN = "qwen/qwen3-coder-30b";

describe("Settings → Workflows and My agents", () => {
  it("labels what an agent costs by its first model", () => {
    expect(costOf([{ runtime: "local", model: QWEN }, { runtime: "codex" }])).toBe("free");
    expect(costOf([{ runtime: "codex-local", model: QWEN }])).toBe("free");
    expect(costOf([{ runtime: "claude", model: "claude-opus-5-5" }])).toBe("claude");
    expect(costOf([{ runtime: "codex" }])).toBe("codex");
    expect(costOf([{ runtime: "codex" }], true)).toBe("free");
    expect(costOf([{ runtime: "hermes" }])).toBeUndefined();
  });

  it("allows a job only when every model of the agent may do it", () => {
    expect(agentJobs([{ runtime: "claude" }, { runtime: "codex" }], false)).toHaveLength(5);
    expect(agentJobs([{ runtime: "local" }, { runtime: "codex" }], false)).toEqual([
      "orchestrator",
    ]);
    expect(agentJobs([{ runtime: "codex-local" }, { runtime: "claude" }], false)).toEqual([
      "orchestrator",
      "supervisor",
      "verifier",
    ]);
    expect(agentJobs([{ runtime: "codex" }], true)).toEqual(["verifier"]);
    expect(jobsText(["orchestrator", "supervisor", "verifier"])).toBe("chat, plan, check");
  });

  it("runs the first model a computer has, and says when that is a backup", () => {
    const chain = [
      { runtime: "codex-local", model: QWEN },
      { runtime: "claude" },
      { runtime: "codex" },
    ];
    expect(runsHere(chain, ["codex", "claude", "codex-local"])).toEqual({
      entry: chain[0],
      backup: false,
    });
    expect(runsHere(chain, ["codex", "claude"])).toEqual({ entry: chain[1], backup: true });
    expect(runsHere(chain, ["hermes"])).toBeUndefined();
  });
});
