import { describe, expect, it, vi } from "vitest";
import { runUpdate, type UpdateSteps } from "./update";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const LATER = "c".repeat(40);

function steps(options: {
  dirty?: boolean;
  branch?: string;
  diverged?: boolean;
  live?: (string | undefined)[];
  ancestor?: boolean;
}) {
  const calls: string[] = [];
  let head = OLD;
  const live = [...(options.live ?? [NEW])];
  let clock = 0;
  const value: UpdateSteps = {
    log: vi.fn(),
    run: vi.fn((command: string, args: string[]) => {
      const line = [command, ...args].join(" ");
      calls.push(line);
      if (line.startsWith("git status")) return options.dirty ? " M file.ts" : "";
      if (line === "git rev-parse --abbrev-ref HEAD") return options.branch ?? "main";
      if (line === "git rev-parse HEAD") return head;
      if (line.startsWith("git merge --ff-only")) {
        if (options.diverged) throw new Error("not possible to fast-forward");
        head = NEW;
      }
      if (line.startsWith("git merge-base") && !options.ancestor) throw new Error("not ancestor");
      return "";
    }),
    liveCommit: vi.fn(async () => (live.length > 1 ? live.shift() : live[0])),
    pause: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    now: () => clock,
    restart: vi.fn(async () => {
      calls.push("restart");
    }),
  };
  return { value, calls };
}

describe("pnpm zamolxis update", () => {
  it("fast-forwards, installs, waits for the deploy of that commit, then restarts", async () => {
    const s = steps({ live: [OLD, undefined, NEW] });
    await runUpdate("https://app.example", s.value);
    expect(s.calls.filter((line) => !line.startsWith("git rev-parse"))).toEqual([
      "git status --porcelain --untracked-files=no",
      "git fetch --quiet origin main",
      "git merge --ff-only --quiet origin/main",
      "pnpm install --frozen-lockfile",
      "git merge-base --is-ancestor " + NEW + " " + OLD,
      "restart",
    ]);
    expect(s.value.liveCommit).toHaveBeenCalledTimes(3);
  });
  it("accepts a deployed later commit that contains this one", async () => {
    const s = steps({ live: [LATER], ancestor: true });
    await runUpdate("https://app.example", s.value);
    expect(s.value.restart).toHaveBeenCalledOnce();
  });
  it.each([
    [{ dirty: true }, /local changes/],
    [{ branch: "feature" }, /not main/],
    [{ diverged: true }, /not on origin\/main/],
  ])("stops before changing anything: %o", async (options, message) => {
    const s = steps(options);
    await expect(runUpdate("https://app.example", s.value)).rejects.toThrow(message);
    expect(s.calls).not.toContain("pnpm install --frozen-lockfile");
    expect(s.value.restart).not.toHaveBeenCalled();
  });
  it("never restarts while the deployed app runs an older commit", async () => {
    const s = steps({ live: [OLD] });
    await expect(runUpdate("https://app.example", s.value)).rejects.toThrow(/after 20 minutes/);
    expect(s.value.restart).not.toHaveBeenCalled();
  });
});
