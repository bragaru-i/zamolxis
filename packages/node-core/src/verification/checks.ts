import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutGitHubTokens } from "@zamolxis/runtime-core";
export interface CheckEvidence {
  modality: string;
  result: "passed" | "failed";
  summary: string;
}
/** One executed (or refused) check, reported to an observer such as the trace recorder. */
export interface CheckObservation {
  readonly command: string;
  readonly script?: string;
  readonly result: "passed" | "failed";
  /** Process exit code; absent when the process did not exit normally or never ran. */
  readonly exitCode?: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  /** Raw tail of stdout and stderr; observers redact and bound it. */
  readonly output: string;
}
const OBSERVED_OUTPUT = 8000;
const SCRIPT_TIMEOUT = 120_000;
// A lockfile-exact install of a fresh worktree; the Builder's own install took longer.
const INSTALL_TIMEOUT = 600_000;
// The lockfile-only install for each supported package manager. A verifier worktree is
// fresh, so without this every scripted check fails for the lack of node_modules.
const INSTALLS: Record<string, { readonly lockfile: string; readonly args: string[] }> = {
  pnpm: { lockfile: "pnpm-lock.yaml", args: ["install", "--frozen-lockfile", "--prefer-offline"] },
  npm: { lockfile: "package-lock.json", args: ["ci"] },
};
// Node executes repository-owned scripts, never shell text from Supervisor output.
export async function runVerificationChecks(
  cwd: string,
  scripts: readonly string[],
  required: readonly string[],
  observe?: (check: CheckObservation) => void,
): Promise<CheckEvidence[]> {
  const execute = (
    executable: string,
    args: string[],
    script?: string,
    timeout = SCRIPT_TIMEOUT,
  ) => {
    const startedAt = Date.now();
    return new Promise<boolean>((resolve) =>
      execFile(
        executable,
        args,
        // Repository scripts get no GitHub tokens, like the agents that wrote them.
        { cwd, env: withoutGitHubTokens(), timeout, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = (error as { code?: unknown } | null)?.code;
          const output = [stdout, stderr].filter(Boolean).join("\n");
          observe?.({
            command: [executable, ...args].join(" "),
            ...(script ? { script } : {}),
            result: error ? "failed" : "passed",
            ...(!error ? { exitCode: 0 } : typeof code === "number" ? { exitCode: code } : {}),
            startedAt,
            finishedAt: Date.now(),
            output: output.slice(-OBSERVED_OUTPUT),
          });
          resolve(!error);
        },
      ),
    );
  };
  const staticPass = await execute("git", ["diff", "--check", "HEAD^", "HEAD"]);
  const evidence: CheckEvidence[] = [
    {
      modality: "static",
      result: staticPass ? "passed" : "failed",
      summary: "git diff --check HEAD^ HEAD",
    },
  ];
  let configured: Record<string, unknown> = {};
  let manager = "npm";
  try {
    const path = join(cwd, "package.json");
    if (lstatSync(path).isSymbolicLink()) throw new Error("UNSAFE_PACKAGE_MANIFEST");
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    configured = pkg.scripts ?? {};
    manager =
      typeof pkg.packageManager === "string" && pkg.packageManager.startsWith("pnpm@")
        ? "pnpm"
        : "npm";
  } catch {
    /* Missing manifest is a failed scripted check, not proof. */
  }
  let passed = scripts.length > 0;
  // Dependencies come from the repository's own lockfile (its lifecycle scripts run as
  // they do for the Builder); a repository without one runs its scripts as checked out.
  const install = INSTALLS[manager];
  const installed =
    !scripts.length || !install || !existsSync(join(cwd, install.lockfile))
      ? true
      : await execute(manager, install.args, undefined, INSTALL_TIMEOUT);
  const summaries: string[] = [];
  for (const script of scripts) {
    const runnable =
      installed &&
      /^[a-zA-Z0-9:_-]{1,64}$/.test(script) &&
      typeof configured[script] === "string";
    if (!runnable) {
      const at = Date.now();
      observe?.({
        command: `${manager} run ${script}`,
        script,
        result: "failed",
        startedAt: at,
        finishedAt: at,
        output: installed
          ? "Not run: the script is not defined in package.json."
          : "Not run: the dependencies could not be installed from the lockfile.",
      });
    }
    const ok = runnable && (await execute(manager, ["run", script], script));
    passed = passed && ok;
    summaries.push(`${manager} run ${script}: ${ok ? "passed" : "failed"}`);
  }
  if (scripts.length && !passed && !required.includes("test"))
    evidence.push({ modality: "test", result: "failed", summary: summaries.join("; ") });
  for (const modality of required.filter((value) => value !== "static"))
    evidence.push({
      modality,
      result:
        passed &&
        scripts.some((script) => /^(?:test(?::|$)|acceptance(?::|$)|e2e(?::|$))/.test(script))
          ? "passed"
          : "failed",
      summary: summaries.length
        ? summaries.join("; ")
        : "No executable acceptance checks configured",
    });
  return evidence;
}
