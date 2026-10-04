import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AppServerClient } from "./app-server-client";

function harness(options: { timeoutMs?: number; maxFrameBytes?: number } = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn(),
  });
  const sent: Record<string, unknown>[] = [];
  child.stdin.on("data", (data: Buffer) => sent.push(JSON.parse(data.toString())));
  const launch = vi.fn(() => child);
  const client = new AppServerClient({ cwd: "/assigned/worktree", launch, ...options });
  return { client, child, launch, sent };
}
describe("Codex app-server stdio boundary", () => {
  it("initializes in assigned cwd and correlates fragmented/out-of-order responses", async () => {
    const h = harness();
    const init = h.client.initialize();
    h.child.stdout.write('{"id":1,"res');
    h.child.stdout.write('ult":{}}\n');
    await init;
    expect(h.launch).toHaveBeenCalledWith("codex", "/assigned/worktree");
    expect(h.sent[1]).toEqual({ method: "initialized" });
    const a = h.client.request("thread/start", {});
    const b = h.client.request("thread/read", {});
    h.child.stdout.write('{"id":3,"result":"b"}\n{"id":2,"result":"a"}\n');
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
    h.client.close();
  });
  it("delivers notifications but refuses server-initiated approval/tool requests", () => {
    const h = harness();
    const listener = vi.fn();
    const remove = h.client.onNotification(listener);
    h.child.stdout.write('{"method":"turn/started","params":{"threadId":"native"}}\n');
    h.child.stdout.write(
      '{"id":"approval","method":"item/commandExecution/requestApproval","params":{}}\n',
    );
    expect(listener).toHaveBeenCalledOnce();
    expect(h.sent[0]).toEqual({
      id: "approval",
      error: { code: -32601, message: "Approval bridge unavailable" },
    });
    remove();
    h.client.close();
  });
  it("fails ambiguous requests on timeout and never replays them", async () => {
    const h = harness({ timeoutMs: 5 });
    await expect(h.client.request("turn/start", {})).rejects.toThrow("CODEX_REQUEST_TIMEOUT");
    expect(h.child.kill).toHaveBeenCalledOnce();
    await expect(h.client.request("turn/start", {})).rejects.toThrow("CODEX_TRANSPORT_CLOSED");
    expect(h.sent).toHaveLength(1);
  });
  it.each(["malformed", "oversized", "exit"])("rejects pending operations on %s", async (kind) => {
    const h = harness({ maxFrameBytes: 50 });
    const pending = h.client.request("thread/start", {});
    const assertion = expect(pending).rejects.toThrow(/CODEX_/);
    if (kind === "exit") h.child.emit("exit", 1);
    else h.child.stdout.write(kind === "malformed" ? "invalid\n" : "x".repeat(51));
    await assertion;
    expect(h.child.kill).toHaveBeenCalledOnce();
  });
});
