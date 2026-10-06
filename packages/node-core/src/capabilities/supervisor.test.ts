import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryContext } from "@zamolxis/contracts";
import { describe, expect, it } from "vitest";
import {
  explicitPlan,
  parseSupervisorDecision,
  repositoryChecks,
  supervisorInstruction,
} from "./supervisor";

const checks = {
  scripts: ["lint", "test", "test:unit"],
  verificationScripts: ["lint", "test"],
  requiredModalities: ["static", "test"],
};
const task = (key: string, dependencies: string[] = []) => ({
  key,
  title: `Task ${key}`,
  description: `Implement ${key}`,
  dependencies,
});

describe("parseSupervisorDecision", () => {
  it("accepts a bare answer object and ignores tasks for answers", () => {
    expect(
      parseSupervisorDecision(
        JSON.stringify({
          decision: "answer",
          reply: " The build uses turbo. ",
          tasks: [task("a")],
        }),
        checks,
      ),
    ).toEqual({ decision: "answer", reply: "The build uses turbo.", tasks: [] });
  });
  it("keeps task keys and redacts secrets in the reply and task text", () => {
    const decision = parseSupervisorDecision(
      JSON.stringify({
        decision: "delegate",
        reply: "Deploy with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345 set.",
        tasks: [
          {
            ...task("outcome"),
            title: "Use password: hunter2",
            description: "Call the API with Authorization: Bearer abc.def.ghi",
          },
        ],
      }),
      checks,
    );
    expect(decision.decision).toBe("delegate");
    expect(decision.tasks[0]?.key).toBe("outcome");
    expect(decision.reply).toBe("Deploy with GITHUB_TOKEN=*** set.");
    expect(decision.tasks[0]?.title).toBe("Use password: ***");
    expect(decision.tasks[0]?.description).not.toContain("abc.def.ghi");
  });
  it("accepts a fenced ask decision surrounded by prose", () => {
    const raw = `Here is my decision:\n\`\`\`json\n${JSON.stringify({ decision: "ask", reply: "Which page?" })}\n\`\`\`\n`;
    expect(parseSupervisorDecision(raw, checks)).toEqual({
      decision: "ask",
      reply: "Which page?",
      tasks: [],
    });
  });
  it("defaults checks, keeps known scripts, orders dependencies and validates the plan", () => {
    const result = parseSupervisorDecision(
      JSON.stringify({
        decision: "propose",
        reply: "Two changes.",
        tasks: [
          { ...task("c", ["a", "b"]), verificationScripts: ["test:unit", "missing"] },
          { ...task("a"), requiredModalities: ["behavioral"] },
          task("b"),
        ],
      }),
      checks,
    );
    expect(result.decision).toBe("propose");
    expect(result.reply).toBe("Two changes.");
    expect(result.tasks.map((t) => t.key)).toEqual(["a", "b", "c"]);
    expect(result.tasks[0]).toMatchObject({
      verificationScripts: ["lint", "test"],
      requiredModalities: ["behavioral"],
    });
    expect(result.tasks[2]).toMatchObject({
      dependencies: ["a", "b"],
      verificationScripts: ["test:unit"],
      requiredModalities: ["static", "test"],
    });
  });
  it("summarizes a plan without a reply", () => {
    const result = parseSupervisorDecision(
      JSON.stringify({ decision: "propose", tasks: [task("a")] }),
      checks,
    );
    expect(result.reply).toBe("Proposed 1 task: Task a");
  });
  it("downgrades the legacy plan decision to a proposal", () => {
    expect(
      parseSupervisorDecision(JSON.stringify({ decision: "plan", tasks: [task("a")] }), checks),
    ).toMatchObject({ decision: "propose", tasks: [{ key: "a" }] });
  });
  it("never plans from invalid output", () => {
    expect(parseSupervisorDecision("Plain prose answer.", checks)).toEqual({
      decision: "answer",
      reply: "Plain prose answer.",
      tasks: [],
    });
    expect(parseSupervisorDecision(undefined, checks).reply).toMatch(/without a usable reply/);
    expect(parseSupervisorDecision("   ", checks).decision).toBe("answer");
    for (const tasks of [
      [],
      [task("a", ["a"])],
      [task("a", ["b"]), task("b", ["a"])],
      [task("bad key")],
      [{ ...task("a"), dependencies: "b" }],
      [{ ...task("a"), requiredModalities: ["visual"] }],
      "not tasks",
    ]) {
      const result = parseSupervisorDecision(
        JSON.stringify({ decision: "delegate", reply: "Doing it.", tasks }),
        checks,
      );
      expect(result.decision).toBe("answer");
      expect(result.tasks).toEqual([]);
      expect(result.reply).toContain("Doing it.");
      expect(result.reply).toContain("no builders were started");
    }
    expect(
      parseSupervisorDecision(JSON.stringify({ decision: "deploy", reply: "x" }), checks),
    ).toMatchObject({ decision: "answer", tasks: [] });
    expect(
      parseSupervisorDecision(JSON.stringify({ decision: "answer", reply: "" }), checks).reply,
    ).toMatch(/without a usable reply/);
  });
  it("bounds replies to 8000 characters", () => {
    expect(
      parseSupervisorDecision(
        JSON.stringify({ decision: "answer", reply: "y".repeat(9000) }),
        checks,
      ).reply,
    ).toHaveLength(8000);
    expect(parseSupervisorDecision("z".repeat(9000), checks).reply).toHaveLength(8000);
  });
});

describe("explicitPlan", () => {
  it("uses a JSON plan typed by the user and ignores prose or other JSON", () => {
    const tasks = [{ ...task("a"), verificationScripts: [], requiredModalities: ["static"] }];
    expect(explicitPlan(JSON.stringify({ tasks }))).toEqual(tasks);
    expect(explicitPlan("Add a README")).toBeUndefined();
    expect(explicitPlan("{ not json")).toBeUndefined();
    expect(explicitPlan('{"question":"why?"}')).toBeUndefined();
    expect(() => explicitPlan(JSON.stringify({ tasks: [] }))).toThrow("INVALID_PLAN");
  });
});

describe("supervisorInstruction and repositoryChecks", () => {
  it("includes context, scripts, conversation, message and the output contract", () => {
    const dir = mkdtempSync(join(tmpdir(), "zamolxis-supervisor-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { test: "vitest", typecheck: "tsc", "bad name": "x" } }),
      );
      const found = repositoryChecks(dir);
      expect(found).toEqual({
        scripts: ["test", "typecheck"],
        verificationScripts: ["typecheck", "test"],
        requiredModalities: ["static", "test"],
      });
      const prompt = supervisorInstruction({
        text: "Why does CI fail?",
        conversation: [
          { role: "user", text: "Hello" },
          { role: "supervisor", text: "Hi there" },
        ],
        context: {
          gitSha: "abc",
          snapshotDigest: "d".repeat(64),
          discoveredSources: ["AGENTS.md"],
          resolvedCapabilities: {},
        } as unknown as RepositoryContext,
        checks: found,
      });
      for (const fragment of [
        "Zamolxis Supervisor",
        "read-only",
        "AGENTS.md",
        '"typecheck"',
        "User: Hello",
        "Supervisor: Hi there",
        "Why does CI fail?",
        '"decision":"answer"|"propose"|"delegate"|"ask"',
      ])
        expect(prompt).toContain(fragment);
      expect(repositoryChecks(join(dir, "missing"))).toEqual({
        scripts: [],
        verificationScripts: [],
        requiredModalities: ["static", "behavioral"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
