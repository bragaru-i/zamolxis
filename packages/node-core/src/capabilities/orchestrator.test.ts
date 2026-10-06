import { describe, expect, it } from "vitest";
import { orchestratorInstruction, parseOrchestratorDecision } from "./orchestrator";

const fenced = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

describe("orchestratorInstruction", () => {
  it("includes the control-plane context, conversation and owner instructions", () => {
    const text = orchestratorInstruction({
      text: "What needs me?",
      context: 'Scope: Product "Shop"',
      conversation: [
        { role: "user", text: "Hi" },
        { role: "supervisor", text: "Hello" },
      ],
      instructions: "Answer in Russian.",
    });
    expect(text).toContain('Scope: Product "Shop"');
    expect(text).toContain("User: Hi\n\nZamolxis: Hello");
    expect(text).toContain("Answer in Russian.");
    expect(text).toContain("What needs me?");
  });
});

describe("parseOrchestratorDecision", () => {
  it("accepts answer, ask and a complete proposal", () => {
    expect(parseOrchestratorDecision(fenced({ decision: "answer", reply: "Done." }))).toEqual({
      decision: "answer",
      reply: "Done.",
    });
    expect(parseOrchestratorDecision(fenced({ decision: "ask", reply: "Which repo?" }))).toEqual({
      decision: "ask",
      reply: "Which repo?",
    });
    expect(
      parseOrchestratorDecision(
        fenced({ decision: "propose", reply: "I can fix it.", proposal: "Fix totals." }),
      ),
    ).toEqual({ decision: "propose", reply: "I can fix it.", proposal: "Fix totals." });
  });
  it("never offers an incomplete proposal or executes anything", () => {
    expect(parseOrchestratorDecision(fenced({ decision: "propose", reply: "Maybe." }))).toEqual({
      decision: "answer",
      reply: "Maybe.",
    });
    expect(
      parseOrchestratorDecision(fenced({ decision: "delegate", reply: "Starting now." })),
    ).toEqual({ decision: "answer", reply: "Starting now." });
    expect(parseOrchestratorDecision("plain text reply")).toEqual({
      decision: "answer",
      reply: "plain text reply",
    });
    expect(parseOrchestratorDecision(undefined).decision).toBe("answer");
  });
  it("redacts secrets in replies and proposals", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    const parsed = parseOrchestratorDecision(
      fenced({ decision: "propose", reply: `key ${secret}`, proposal: `use ${secret}` }),
    );
    expect(JSON.stringify(parsed)).not.toContain(secret);
  });
});
