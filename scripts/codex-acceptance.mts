import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerClient, CodexRuntime } from "../packages/runtime-codex/src/index";
import type { AgentRunId, WorkspaceId, WorkstationId } from "../packages/contracts/src/index";

// Explicit user-invoked acceptance: existing authentication, isolated configuration,
// one minimal inference, no MCP/plugins or persistent changes to the user's profile.
if (!process.argv.includes("--authenticated")) {
  throw new Error("Run with --authenticated to use existing Codex login for one fixture inference");
}
const root = mkdtempSync(join(tmpdir(), "zamolxis-codex-acceptance-"));
const canonical = join(root, "canonical");
const workspace = join(root, "workspace");
const isolatedHome = join(root, "codex");
const children: ReturnType<typeof spawn>[] = [];
const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let deadline: ReturnType<typeof setTimeout> | undefined;
try {
  mkdirSync(isolatedHome, { mode: 0o700 });
  copyFileSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), join(isolatedHome, "auth.json"));
  chmodSync(join(isolatedHome, "auth.json"), 0o600);
  mkdirSync(canonical);
  git(canonical, ["init", "-b", "main"]);
  writeFileSync(join(canonical, "fixture.txt"), "Acceptance fixture\n");
  git(canonical, ["add", "."]);
  git(canonical, ["-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.invalid", "commit", "-m", "fixture"]);
  const headSha = git(canonical, ["rev-parse", "HEAD"]);
  git(canonical, ["worktree", "add", "-b", "acceptance", workspace, headSha]);
  const runtime = new CodexRuntime({
    connect: (cwd) => new AppServerClient({ cwd, launch: (executable, assignedCwd) => {
      const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
        cwd: assignedCwd, env: { ...process.env, CODEX_HOME: isolatedHome },
        stdio: ["pipe", "pipe", "ignore"], shell: false,
      });
      children.push(child);
      return child;
    } }),
  });
  const completion = async () => {
    const started = await runtime.start({
      runId: "acceptance-run" as AgentRunId,
      workstationId: "acceptance-mac" as WorkstationId,
      workspace: { workspaceId: "acceptance-workspace" as WorkspaceId, cwd: workspace, branch: "acceptance", headSha },
      instruction: "Reply with ALPHA_OK. Do not use tools, run commands, or change any files.",
    });
    const events = [];
    for await (const event of runtime.subscribe({ nativeSessionId: started.nativeSessionId })) events.push(event);
    const final = await runtime.inspect(started.nativeSessionId);
    assert.equal(final.state, "completed");
    assert(events.some((event) => event.type === "run.completed"));
    assert.equal(final.workspace.cwd, workspace);
    assert.equal(git(canonical, ["rev-parse", "HEAD"]), headSha);
    assert.equal(git(canonical, ["status", "--porcelain"]), "");
    assert.equal(git(workspace, ["status", "--porcelain"]), "");
    console.log("PASS: authenticated Codex inference; assigned worktree; terminal normalized event; canonical checkout unchanged.");
  };
  await Promise.race([completion(), new Promise<never>((_, reject) => {
    deadline = setTimeout(() => reject(new Error("AUTHENTICATED_ACCEPTANCE_TIMEOUT")), 90_000);
  })]);
} finally {
  if (deadline) clearTimeout(deadline);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000).unref();
      });
    }
  }
  rmSync(root, { recursive: true, force: true });
}
