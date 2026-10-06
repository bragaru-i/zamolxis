import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { type ChildLike, ClaudeCliProcess, claudeEnv } from "./cli-process";

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new PassThrough();
  stdin = new PassThrough();
  killed: string[] = [];
  kill(signal?: NodeJS.Signals) {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
}
function launch(options: { maxFrameBytes?: number } = {}) {
  const child = new FakeChild();
  const spawned: { file: string; args: readonly string[]; cwd: string }[] = [];
  const process = new ClaudeCliProcess({
    cwd: "/work",
    args: ["-p"],
    ...options,
    spawnChild: (file, args, cwd) => {
      spawned.push({ file, args, cwd });
      return child;
    },
  });
  const frames: Record<string, unknown>[] = [];
  process.onFrame((frame) => frames.push(frame));
  return { child, process, frames, spawned };
}

describe("claudeEnv", () => {
  it("removes API credentials so the CLI uses the owner's Claude login", () => {
    expect(
      claudeEnv({
        PATH: "/bin",
        ANTHROPIC_API_KEY: "sk-x",
        ANTHROPIC_AUTH_TOKEN: "t",
        ANTHROPIC_BASE_URL: "https://gateway.example",
        HOME: "/h",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("ClaudeCliProcess", () => {
  it("launches claude in the assigned cwd and frames NDJSON both ways", () => {
    const { child, process, frames, spawned } = launch();
    expect(spawned).toEqual([{ file: "claude", args: ["-p"], cwd: "/work" }]);
    let written = "";
    child.stdin.on("data", (chunk) => {
      written += String(chunk);
    });
    process.write({ type: "user" });
    child.stdout.write('{"type":"system","subtype":"init"}\n{"type":"res');
    child.stdout.write('ult"}\nnot json\n[1]\n\n');
    expect(written).toBe('{"type":"user"}\n');
    expect(frames).toEqual([{ type: "system", subtype: "init" }, { type: "result" }]);
  });
  it("skips oversized lines and keeps reading", () => {
    const { child, frames } = launch({ maxFrameBytes: 32 });
    child.stdout.write(`{"type":"user","content":"${"x".repeat(40)}`);
    child.stdout.write(`${"y".repeat(40)}"}\n{"type":"result"}\n`);
    expect(frames).toEqual([{ type: "result" }]);
  });
  it("reports its exit once and refuses writes afterwards", () => {
    const { child, process } = launch();
    let closed = 0;
    process.onClose(() => closed++);
    child.emit("exit", 0);
    child.emit("error", new Error("x"));
    expect(closed).toBe(1);
    expect(() => process.write({ type: "user" })).toThrow("CLAUDE_TRANSPORT_CLOSED");
    process.onClose(() => closed++);
    expect(closed).toBe(2);
  });
  it("ends stdin on close and kills on kill", () => {
    const { child, process } = launch();
    let ended = false;
    child.stdin.on("finish", () => {
      ended = true;
    });
    process.close();
    child.stdin.resume();
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(ended).toBe(true);
        process.kill();
        expect(child.killed).toEqual(["SIGTERM"]);
        resolve();
      });
    });
  });
});
